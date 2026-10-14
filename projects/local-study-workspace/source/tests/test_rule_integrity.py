import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import create_server


class RuleIntegrityIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "study.db"
        self.fixed_now = datetime(2026, 10, 14, 9, 0, tzinfo=timezone.utc)
        self.server = create_server(port=0, db_path=self.db_path, clock=lambda: self.fixed_now)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.temp_dir.cleanup()

    def request(self, method: str, path: str, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data is not None else {},
        )
        try:
            with urlopen(request, timeout=5) as response:
                status = response.status
                raw = response.read()
        except HTTPError as error:
            status = error.code
            raw = error.read()
        try:
            return status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AssertionError(f"HTTP {status} returned a non-JSON response") from error

    def get(self, path: str):
        return self.request("GET", path)

    def restart_server(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        self.server = create_server(port=0, db_path=self.db_path, clock=lambda: self.fixed_now)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def simultaneous_requests(self, path: str, payloads: list[dict]):
        barrier = threading.Barrier(len(payloads))

        def send(payload):
            barrier.wait(timeout=5)
            return self.request("POST", path, payload)

        with ThreadPoolExecutor(max_workers=len(payloads)) as executor:
            return list(executor.map(send, payloads))

    def test_prerequisites_require_enrollment_all_dependencies_and_stable_completion_time(self) -> None:
        status, created = self.request("POST", "/api/courses", {
            "title": "Two foundations",
            "lessons": [
                {"title": "A", "duration_minutes": 20},
                {"title": "B", "duration_minutes": 20},
                {"title": "C", "duration_minutes": 20, "prerequisite_positions": [1, 2]},
            ],
        })
        self.assertEqual(status, 201, created)
        course = created["course"]
        lesson_a, lesson_b, lesson_c = course["lessons"]
        self.assertEqual(lesson_c["prerequisite_ids"], [lesson_a["id"], lesson_b["id"]])

        status, not_enrolled = self.request("POST", f"/api/lessons/{lesson_a['id']}/complete", {})
        self.assertEqual(status, 409, not_enrolled)
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM lesson_progress WHERE lesson_id = ?", (lesson_a["id"],)).fetchone()[0],
                0,
            )

        status, enrolled = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200, enrolled)
        status, completed_a = self.request("POST", f"/api/lessons/{lesson_a['id']}/complete", {})
        self.assertEqual(status, 200, completed_a)
        with sqlite3.connect(self.db_path) as db:
            progress_before_block = db.execute(
                "SELECT learner_id, lesson_id, completed_at FROM lesson_progress ORDER BY lesson_id"
            ).fetchall()

        status, blocked = self.request("POST", f"/api/lessons/{lesson_c['id']}/complete", {})
        self.assertEqual(status, 409, blocked)
        self.assertEqual([item["title"] for item in blocked["details"]["blocked_by"]], ["B"])
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(
                db.execute(
                    "SELECT learner_id, lesson_id, completed_at FROM lesson_progress ORDER BY lesson_id"
                ).fetchall(),
                progress_before_block,
            )
        status, listed = self.get("/api/courses")
        self.assertEqual(status, 200, listed)
        current = next(item for item in listed["courses"] if item["id"] == course["id"])
        current_c = next(item for item in current["lessons"] if item["id"] == lesson_c["id"])
        self.assertEqual(current["completed_count"], 1)
        self.assertEqual([item["title"] for item in current_c["blocked_by"]], ["B"])
        self.assertFalse(current_c["completed"])

        status, completed_b = self.request("POST", f"/api/lessons/{lesson_b['id']}/complete", {})
        self.assertEqual(status, 200, completed_b)
        status, completed_c = self.request("POST", f"/api/lessons/{lesson_c['id']}/complete", {})
        self.assertEqual(status, 200, completed_c)
        self.assertTrue(completed_c["course"]["course_complete"])
        self.assertIsNone(completed_c["course"]["next_lesson_id"])

        with sqlite3.connect(self.db_path) as db:
            completed_at = db.execute(
                "SELECT completed_at FROM lesson_progress WHERE lesson_id = ?", (lesson_c["id"],)
            ).fetchone()[0]
        self.fixed_now += timedelta(hours=2)
        status, repeated = self.request("POST", f"/api/lessons/{lesson_c['id']}/complete", {})
        self.assertEqual(status, 200, repeated)
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(
                db.execute(
                    "SELECT completed_at FROM lesson_progress WHERE lesson_id = ?", (lesson_c["id"],)
                ).fetchone()[0],
                completed_at,
            )

    def test_deleted_highest_lesson_id_is_not_reused_after_restart(self) -> None:
        status, created = self.request("POST", "/api/courses", {
            "title": "Monotonic lesson records",
            "lessons": [
                {"title": "Retained A", "duration_minutes": 20},
                {"title": "Retained B", "duration_minutes": 20, "prerequisite_positions": [1]},
                {"title": "Deleted C", "duration_minutes": 20, "prerequisite_positions": [2]},
            ],
        })
        self.assertEqual(status, 201, created)
        course = created["course"]
        lesson_a, lesson_b, lesson_c = course["lessons"]
        deleted_id = lesson_c["id"]
        self.assertEqual(deleted_id, max(lesson["id"] for lesson in course["lessons"]))

        status, enrolled = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200, enrolled)
        for lesson in (lesson_a, lesson_b, lesson_c):
            status, completed = self.request("POST", f"/api/lessons/{lesson['id']}/complete", {})
            self.assertEqual(status, 200, completed)

        with sqlite3.connect(self.db_path) as db:
            retained_progress = db.execute(
                "SELECT id, learner_id, lesson_id, completed_at "
                "FROM lesson_progress WHERE lesson_id IN (?, ?) ORDER BY lesson_id",
                (lesson_a["id"], lesson_b["id"]),
            ).fetchall()
            enrollment = db.execute(
                "SELECT id, learner_id, course_id, enrolled_at FROM enrollments WHERE course_id = ?",
                (course["id"],),
            ).fetchall()

        status, edited = self.request("PUT", f"/api/courses/{course['id']}", {
            "title": course["title"],
            "lessons": [
                {"id": lesson_a["id"], "title": lesson_a["title"], "duration_minutes": 20,
                 "prerequisite_positions": []},
                {"id": lesson_b["id"], "title": lesson_b["title"], "duration_minutes": 20,
                 "prerequisite_positions": [1]},
            ],
        })
        self.assertEqual(status, 200, edited)
        self.assertTrue(edited["course"]["course_complete"])
        self.assertEqual(edited["course"]["completed_count"], 2)
        self.assertNotIn(deleted_id, {lesson["id"] for lesson in edited["course"]["lessons"]})
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM lesson_progress WHERE lesson_id = ?", (deleted_id,)).fetchone()[0],
                0,
            )
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM lesson_prerequisites "
                    "WHERE lesson_id = ? OR prerequisite_lesson_id = ?", (deleted_id, deleted_id)
                ).fetchone()[0],
                0,
            )

        self.restart_server()
        status, after_restart = self.get("/api/courses")
        self.assertEqual(status, 200, after_restart)
        restarted_course = next(item for item in after_restart["courses"] if item["id"] == course["id"])
        self.assertEqual(restarted_course["completed_count"], 2)
        self.assertTrue(restarted_course["enrolled"])

        status, added = self.request("PUT", f"/api/courses/{course['id']}", {
            "title": course["title"],
            "lessons": [
                {"id": lesson_a["id"], "title": lesson_a["title"], "duration_minutes": 20,
                 "prerequisite_positions": []},
                {"id": lesson_b["id"], "title": lesson_b["title"], "duration_minutes": 20,
                 "prerequisite_positions": [1]},
                {"title": "Replacement D", "duration_minutes": 20},
            ],
        })
        self.assertEqual(status, 200, added)
        new_lesson = next(lesson for lesson in added["course"]["lessons"] if lesson["title"] == "Replacement D")
        self.assertGreater(new_lesson["id"], deleted_id)

        status, old_completion = self.request("POST", f"/api/lessons/{deleted_id}/complete", {})
        self.assertEqual(status, 404, old_completion)

        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(
                db.execute(
                    "SELECT id, learner_id, lesson_id, completed_at "
                    "FROM lesson_progress WHERE lesson_id IN (?, ?) ORDER BY lesson_id",
                    (lesson_a["id"], lesson_b["id"]),
                ).fetchall(),
                retained_progress,
            )
            self.assertEqual(
                db.execute(
                    "SELECT id, learner_id, course_id, enrolled_at FROM enrollments WHERE course_id = ?",
                    (course["id"],),
                ).fetchall(),
                enrollment,
            )
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM lesson_progress AS p "
                    "WHERE NOT EXISTS (SELECT 1 FROM lessons AS l WHERE l.id = p.lesson_id)"
                ).fetchone()[0],
                0,
            )
            self.assertEqual(
                db.execute(
                    "SELECT COUNT(*) FROM lesson_prerequisites AS p "
                    "WHERE NOT EXISTS (SELECT 1 FROM lessons AS l WHERE l.id = p.lesson_id) "
                    "OR NOT EXISTS (SELECT 1 FROM lessons AS required "
                    "WHERE required.id = p.prerequisite_lesson_id)"
                ).fetchone()[0],
                0,
            )
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

        status, zero_created = self.request("POST", "/api/courses", {
            "title": "No lessons",
            "lessons": [],
        })
        self.assertEqual(status, 201, zero_created)
        zero_course = zero_created["course"]
        status, zero_enrolled = self.request("POST", f"/api/courses/{zero_course['id']}/enroll", {})
        self.assertEqual(status, 200, zero_enrolled)
        status, courses = self.get("/api/courses")
        self.assertEqual(status, 200, courses)
        zero_after_enrollment = next(item for item in courses["courses"] if item["id"] == zero_course["id"])
        self.assertEqual(zero_after_enrollment["lesson_count"], 0)
        self.assertEqual(zero_after_enrollment["completed_count"], 0)
        self.assertFalse(zero_after_enrollment["course_complete"])

    def test_concurrent_enrollment_is_single_row_and_completion_persists(self) -> None:
        status, created = self.request("POST", "/api/courses", {
            "title": "Concurrent enrollment",
            "lessons": [{"title": "One lesson", "duration_minutes": 20}],
        })
        self.assertEqual(status, 201, created)
        course = created["course"]
        lesson_id = course["lessons"][0]["id"]

        results = self.simultaneous_requests(
            f"/api/courses/{course['id']}/enroll", [{}, {}]
        )
        self.assertEqual([status for status, _ in results], [200, 200], results)
        self.assertEqual(sum(response["created"] is True for _, response in results), 1, results)
        self.assertEqual(sum(response["created"] is False for _, response in results), 1, results)
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM enrollments WHERE course_id = ?", (course["id"],)).fetchone()[0],
                1,
            )

        status, completed = self.request("POST", f"/api/lessons/{lesson_id}/complete", {})
        self.assertEqual(status, 200, completed)
        self.assertTrue(completed["course"]["course_complete"])
        self.restart_server()
        status, after_restart = self.get("/api/courses")
        self.assertEqual(status, 200, after_restart)
        persisted = next(item for item in after_restart["courses"] if item["id"] == course["id"])
        self.assertTrue(persisted["enrolled"])
        self.assertEqual(persisted["completed_count"], 1)
        self.assertTrue(persisted["course_complete"])

    def test_concurrent_equivalent_time_sessions_cancel_idempotently_and_reuse(self) -> None:
        status, created = self.request("POST", "/api/courses", {
            "title": "Session-linked progress",
            "lessons": [{"title": "Completed before scheduling", "duration_minutes": 20}],
        })
        self.assertEqual(status, 201, created)
        course = created["course"]
        status, enrolled = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200, enrolled)
        status, completed = self.request("POST", f"/api/lessons/{course['lessons'][0]['id']}/complete", {})
        self.assertEqual(status, 200, completed)
        status, courses_before = self.get("/api/courses")
        self.assertEqual(status, 200, courses_before)
        course_before_cancel = next(item for item in courses_before["courses"] if item["id"] == course["id"])

        status, groups_response = self.get("/api/groups")
        self.assertEqual(status, 200, groups_response)
        joined_groups = [group for group in groups_response["groups"] if group["joined"]]
        self.assertGreaterEqual(len(joined_groups), 2, groups_response)
        with sqlite3.connect(self.db_path) as db:
            session_count_before = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]

        session_payloads = [
            {
                "group_id": joined_groups[0]["id"],
                "course_id": course["id"],
                "title": "UTC equivalent",
                "session_date": "2026-10-24",
                "start_time": "14:00",
                "timezone": "UTC",
                "duration_minutes": 60,
            },
            {
                "group_id": joined_groups[1]["id"],
                "course_id": course["id"],
                "title": "New York equivalent",
                "session_date": "2026-10-24",
                "start_time": "10:00",
                "timezone": "America/New_York",
                "duration_minutes": 60,
            },
        ]
        results = self.simultaneous_requests("/api/sessions", session_payloads)
        statuses = [status for status, _ in results]
        self.assertEqual(statuses.count(201), 1, results)
        self.assertEqual(statuses.count(409), 1, results)
        self.assertEqual(sorted(statuses), [201, 409], results)
        winner_index = statuses.index(201)
        loser_index = statuses.index(409)
        winner_session = results[winner_index][1]["session"]
        loser_response = results[loser_index][1]
        self.assertIn("conflicts", loser_response)
        self.assertTrue(loser_response["conflicts"], loser_response)
        self.assertEqual(loser_response["conflicts"][0]["id"], winner_session["id"])
        self.assertEqual(winner_session["start_utc"], "2026-10-24T14:00:00+00:00")
        self.assertEqual(loser_response["details"]["session"]["start_utc"], "2026-10-24T14:00:00+00:00")
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], session_count_before + 1)

        status, cancelled = self.request(
            "POST", f"/api/sessions/{winner_session['id']}/cancel", {"reason": "Holiday"}
        )
        self.assertEqual(status, 200, cancelled)
        cancelled_session = cancelled["session"]
        self.assertEqual(cancelled_session["status"], "cancelled")
        self.assertEqual(cancelled_session["cancelled_at"], "2026-10-14T09:00:00+00:00")
        self.assertEqual(cancelled_session["cancellation_reason"], "Holiday")

        self.fixed_now += timedelta(minutes=11)
        status, repeated_cancel = self.request(
            "POST", f"/api/sessions/{winner_session['id']}/cancel", {"reason": "Changed explanation"}
        )
        self.assertEqual(status, 200, repeated_cancel)
        self.assertEqual(repeated_cancel["session"], cancelled_session)
        status, courses_after_cancel = self.get("/api/courses")
        self.assertEqual(status, 200, courses_after_cancel)
        self.assertEqual(
            next(item for item in courses_after_cancel["courses"] if item["id"] == course["id"]),
            course_before_cancel,
        )

        status, reused = self.request("POST", "/api/sessions", session_payloads[winner_index])
        self.assertEqual(status, 201, reused)
        reused_session = reused["session"]
        self.assertNotEqual(reused_session["id"], winner_session["id"])
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], session_count_before + 2)

        self.restart_server()
        status, persisted_sessions = self.get("/api/sessions")
        self.assertEqual(status, 200, persisted_sessions)
        self.assertIn(reused_session, persisted_sessions["sessions"])
        self.assertNotIn(winner_session["id"], {session["id"] for session in persisted_sessions["sessions"]})
        status, persisted_cancel = self.request("POST", f"/api/sessions/{winner_session['id']}/cancel")
        self.assertEqual(status, 200, persisted_cancel)
        self.assertEqual(persisted_cancel["session"], cancelled_session)
        status, courses_after_restart = self.get("/api/courses")
        self.assertEqual(status, 200, courses_after_restart)
        self.assertEqual(
            next(item for item in courses_after_restart["courses"] if item["id"] == course["id"]),
            course_before_cancel,
        )
