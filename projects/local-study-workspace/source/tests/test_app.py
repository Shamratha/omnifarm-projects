import json
import sqlite3
import tempfile
import threading
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import MAX_PAYLOAD_BYTES, StudyDatabase, create_server


class StudyApiIntegrationTests(unittest.TestCase):
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
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            body = json.loads(error.read().decode("utf-8"))
            return error.code, body

    def raw_request(self, method: str, path: str, body: bytes = b"", content_type: str = "application/octet-stream"):
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": content_type, "Content-Length": str(len(body))},
        )
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, response.headers, response.read()
        except HTTPError as error:
            return error.code, error.headers, error.read()

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

    def test_create_prerequisites_block_completion_and_persist_after_restart(self) -> None:
        payload = {
            "title": "Prerequisite path",
            "description": "A short path with an explicit order.",
            "lessons": [
                {"title": "First step", "summary": "Begin.", "content": "Start here.", "duration_minutes": 20},
                {
                    "title": "Second step",
                    "summary": "Continue.",
                    "content": "Continue here.",
                    "duration_minutes": 20,
                    "prerequisite_positions": [1],
                },
            ],
        }
        status, response = self.request("POST", "/api/courses", payload)
        self.assertEqual(status, 201)
        course = response["course"]
        first, second = course["lessons"]
        self.assertEqual(second["prerequisite_ids"], [first["id"]])
        self.assertEqual(second["prerequisite_positions"], [1])
        self.assertEqual(second["blocked_by"][0]["id"], first["id"])
        self.assertEqual(second["blocked_by"][0]["title"], first["title"])
        self.assertFalse(course["course_complete"])
        self.assertEqual(course["completion_rule"], "all_lessons")
        self.assertFalse(first["can_complete"])

        status, enrolled = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        self.assertTrue(enrolled["course"]["lessons"][0]["can_complete"])
        status, blocked = self.request("POST", f"/api/lessons/{second['id']}/complete", {})
        self.assertEqual(status, 409)
        self.assertIn("prerequisite", blocked["error"])
        self.assertEqual(blocked["details"]["blocked_by"][0]["id"], first["id"])
        self.assertEqual(blocked["blocked_by"][0]["id"], first["id"])
        status, before_progress = self.get("/api/courses")
        current = next(item for item in before_progress["courses"] if item["id"] == course["id"])
        self.assertEqual(current["completed_count"], 0)

        status, first_completion = self.request("POST", f"/api/lessons/{first['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertFalse(first_completion["course"]["course_complete"])
        status, repeated = self.request("POST", f"/api/lessons/{first['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertEqual(repeated["course"]["completed_count"], 1)
        status, final = self.request("POST", f"/api/lessons/{second['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertTrue(final["course"]["course_complete"])
        self.assertEqual(final["course"]["progress_percent"], 100)

        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        restarted = StudyDatabase(self.db_path, clock=lambda: self.fixed_now)
        persisted = next(item for item in restarted.list_courses() if item["id"] == course["id"])
        self.assertTrue(persisted["course_complete"])
        self.assertEqual(persisted["completed_count"], 2)
        self.server = create_server(port=0, db_path=self.db_path, clock=lambda: self.fixed_now)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        status, after_restart = self.get("/api/courses")
        self.assertTrue(next(item for item in after_restart["courses"] if item["id"] == course["id"])["course_complete"])

    def test_existing_database_without_prerequisite_table_is_migrated_safely(self) -> None:
        status, before = self.get("/api/courses")
        self.assertEqual(status, 200)
        completed_before = before["courses"][0]["completed_count"]
        with sqlite3.connect(self.db_path) as legacy_db:
            legacy_db.execute("DROP TABLE lesson_prerequisites")
        migrated = StudyDatabase(self.db_path, clock=lambda: self.fixed_now)
        with migrated.connect() as db:
            table = db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lesson_prerequisites'"
            ).fetchone()
            self.assertIsNotNone(table)
        course = next(item for item in migrated.list_courses() if item["id"] == before["courses"][0]["id"])
        self.assertEqual(course["completed_count"], completed_before)
        self.assertEqual(course["lessons"][1]["prerequisite_ids"], [])

    def test_put_updates_prerequisites_without_losing_progress(self) -> None:
        payload = {
            "title": "Editable path",
            "lessons": [
                {"title": "One", "duration_minutes": 20},
                {"title": "Two", "duration_minutes": 20},
                {"title": "Three", "duration_minutes": 20},
            ],
        }
        status, created = self.request("POST", "/api/courses", payload)
        self.assertEqual(status, 201)
        course = created["course"]
        lessons = course["lessons"]
        status, _ = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        status, _ = self.request("POST", f"/api/lessons/{lessons[0]['id']}/complete", {})
        self.assertEqual(status, 200)

        edited_payload = {
            "title": "Editable path, reordered rules",
            "lessons": [
                {"id": lessons[0]["id"], "title": "One", "duration_minutes": 20, "prerequisite_ids": [], "prerequisite_positions": []},
                {"id": lessons[1]["id"], "title": "Two", "duration_minutes": 20, "prerequisite_positions": [1], "prerequisite_ids": []},
                {"id": lessons[2]["id"], "title": "Three", "duration_minutes": 20, "prerequisite_positions": [2], "prerequisite_ids": []},
            ],
        }
        status, edited = self.request("PUT", f"/api/courses/{course['id']}", edited_payload)
        self.assertEqual(status, 200)
        edited_course = edited["course"]
        self.assertEqual([item["id"] for item in edited_course["lessons"]], [item["id"] for item in lessons])
        self.assertTrue(edited_course["lessons"][0]["completed"])
        self.assertEqual(edited_course["lessons"][1]["prerequisite_positions"], [1])
        self.assertEqual(edited_course["lessons"][2]["prerequisite_positions"], [2])
        self.assertTrue(edited_course["lessons"][1]["can_complete"])
        self.assertFalse(edited_course["lessons"][2]["can_complete"])
        self.assertEqual(edited_course["completed_count"], 1)
        self.assertEqual(edited_course["progress_percent"], 33)

    def test_invalid_prerequisites_are_atomic_for_create_and_put(self) -> None:
        status, before = self.get("/api/courses")
        self.assertEqual(status, 200)
        seed_course = before["courses"][0]
        foreign_id = before["courses"][1]["lessons"][0]["id"]
        status, created = self.request(
            "POST",
            "/api/courses",
            {
                "title": "Cyclic course",
                "lessons": [
                    {"title": "A", "prerequisite_positions": [2]},
                    {"title": "B", "prerequisite_positions": [1]},
                ],
            },
        )
        self.assertEqual(status, 400)
        self.assertIn("cycle", created["error"])
        status, after_failed_create = self.get("/api/courses")
        self.assertEqual(len(after_failed_create["courses"]), len(before["courses"]))

        target = seed_course
        original = {
            "title": target["title"],
            "lesson_ids": [lesson["id"] for lesson in target["lessons"]],
            "prerequisites": [lesson["prerequisite_ids"] for lesson in target["lessons"]],
        }

        def edit_with(changes):
            return {
                "title": "Must remain unchanged",
                "lessons": [
                    {
                        "id": lesson["id"],
                        "title": lesson["title"],
                        "summary": lesson["summary"],
                        "content": lesson["content"],
                        "duration_minutes": lesson["duration_minutes"],
                        **changes.get(index, {}),
                    }
                    for index, lesson in enumerate(target["lessons"], start=1)
                ],
            }

        invalid_payloads = [
            edit_with({2: {"prerequisite_positions": [2]}}),  # self
            edit_with({2: {"prerequisite_positions": [1, 1]}}),  # duplicate
            edit_with({2: {"prerequisite_positions": [99]}}),  # outside submitted list
            edit_with({2: {"prerequisite_ids": [foreign_id]}}),  # foreign lesson
            edit_with({1: {"prerequisite_positions": [2]}, 2: {"prerequisite_positions": [1]}}),  # cycle
        ]
        for invalid in invalid_payloads:
            status, error = self.request("PUT", f"/api/courses/{target['id']}", invalid)
            self.assertEqual(status, 400)
            self.assertIn("error", error)
            status, courses = self.get("/api/courses")
            unchanged = next(item for item in courses["courses"] if item["id"] == target["id"])
            self.assertEqual(unchanged["title"], original["title"])
            self.assertEqual([lesson["id"] for lesson in unchanged["lessons"]], original["lesson_ids"])
            self.assertEqual([lesson["prerequisite_ids"] for lesson in unchanged["lessons"]], original["prerequisites"])

    def test_session_conflicts_cover_joined_groups_and_allow_boundaries(self) -> None:
        status, groups_response = self.get("/api/groups")
        self.assertEqual(status, 200)
        joined_groups = [group for group in groups_response["groups"] if group["joined"]]
        unjoined_group = next(group for group in groups_response["groups"] if not group["joined"])
        session_date = (self.fixed_now.date() + timedelta(days=10)).isoformat()
        base = {
            "group_id": joined_groups[0]["id"],
            "title": "Fixed clock session",
            "session_date": session_date,
            "start_time": "10:00",
            "duration_minutes": 60,
            "timezone": "America/New_York",
        }
        status, first = self.request("POST", "/api/sessions", base)
        self.assertEqual(status, 201)
        status, existing = self.get("/api/sessions")
        self.assertEqual(status, 200)
        before_conflict_count = len(existing["sessions"])

        status, same_group_error = self.request("POST", "/api/sessions", base)
        self.assertEqual(status, 409)
        self.assertIn("conflict", same_group_error["error"].lower())
        self.assertEqual(same_group_error["details"]["conflicts"][0]["id"], first["session"]["id"])
        self.assertEqual(same_group_error["conflict"]["id"], first["session"]["id"])
        status, unchanged = self.get("/api/sessions")
        self.assertEqual(len(unchanged["sessions"]), before_conflict_count)

        adjacent = {**base, "title": "Back to back", "start_time": "11:00", "duration_minutes": 30}
        status, adjacent_response = self.request("POST", "/api/sessions", adjacent)
        self.assertEqual(status, 201)
        self.assertNotEqual(adjacent_response["session"]["id"], first["session"]["id"])

        other_group = next(group for group in joined_groups if group["id"] != joined_groups[0]["id"])
        other_group_overlap = {**base, "group_id": other_group["id"], "title": "Other group overlap", "start_time": "10:30"}
        status, other_error = self.request("POST", "/api/sessions", other_group_overlap)
        self.assertEqual(status, 409)
        self.assertTrue(other_error["details"]["conflicts"])
        status, after_other = self.get("/api/sessions")
        self.assertEqual(len(after_other["sessions"]), before_conflict_count + 1)

        unjoined_payload = {**base, "group_id": unjoined_group["id"], "title": "Unjoined attempt", "start_time": "15:00"}
        status, unjoined_error = self.request("POST", "/api/sessions", unjoined_payload)
        self.assertEqual(status, 409)
        self.assertIn("Join", unjoined_error["error"])
        status, after_unjoined = self.get("/api/sessions")
        self.assertEqual(len(after_unjoined["sessions"]), before_conflict_count + 1)

    def test_timezone_validation_is_required_structured_and_atomic(self) -> None:
        base = {
            "group_id": 1, "title": "Timezone validation", "session_date": "2026-10-24",
            "start_time": "10:00", "duration_minutes": 60,
        }
        with sqlite3.connect(self.db_path) as db:
            before = list(db.iterdump())
        invalid_fields = [
            {}, {"timezone": None}, {"timezone": ""}, {"timezone": "   "},
            {"timezone": 42}, {"timezone": True}, {"timezone": ["UTC"]},
            {"timezone": "Not/IANA"}, {"timezone": "+05:00"},
            {"timezone": "/etc/localtime"}, {"timezone": "../UTC"},
            {"timezone": "UTC", "time_zone": "America/New_York"},
            {"timezone": "Not/IANA", "time_zone": "UTC"},
        ]
        for fields in invalid_fields:
            with self.subTest(fields=fields):
                status, error = self.request("POST", "/api/sessions", {**base, **fields})
                self.assertEqual(status, 400, error)
                self.assertIsInstance(error["error"], str)
                self.assertEqual(error["details"]["field"], "timezone")
                with sqlite3.connect(self.db_path) as db:
                    self.assertEqual(list(db.iterdump()), before)
        # The legacy spelling is accepted only when a timezone is explicit.
        status, alias = self.request("POST", "/api/sessions", {**base, "time_zone": "UTC"})
        self.assertEqual(status, 201, alias)
        self.assertEqual(alias["session"]["timezone"], "UTC")

    def test_same_wall_time_in_different_zones_is_allowed_when_instants_differ(self) -> None:
        base = {
            "group_id": 1, "title": "New York morning", "session_date": "2026-10-24",
            "start_time": "10:00", "duration_minutes": 60, "timezone": "America/New_York",
        }
        status, eastern = self.request("POST", "/api/sessions", base)
        self.assertEqual(status, 201, eastern)
        self.assertEqual(eastern["session"]["start_utc"], "2026-10-24T14:00:00+00:00")
        status, utc = self.request("POST", "/api/sessions", {**base, "group_id": 2, "timezone": "UTC"})
        self.assertEqual(status, 201, utc)
        self.assertEqual(utc["session"]["start_utc"], "2026-10-24T10:00:00+00:00")
        # Same zone and clock on another date is a distinct local schedule.
        status, tomorrow = self.request("POST", "/api/sessions", {**base, "session_date": "2026-10-25"})
        self.assertEqual(status, 201, tomorrow)
        # The unjoined example group's slot is outside this learner's schedule.
        status, unjoined_slot = self.request("POST", "/api/sessions", {
            **base, "session_date": "2026-10-16", "start_time": "16:00", "timezone": "UTC",
        })
        self.assertEqual(status, 201, unjoined_slot)

    def test_dst_repeated_wall_clock_conflicts_even_when_utc_intervals_differ(self) -> None:
        base = {
            "group_id": 1, "title": "First repeated hour", "session_date": "2026-11-01",
            "start_time": "01:15", "duration_minutes": 30, "timezone": "America/New_York",
        }
        status, first = self.request("POST", "/api/sessions", {**base, "fold": 0})
        self.assertEqual(status, 201, first)
        self.assertEqual(first["session"]["start_utc"], "2026-11-01T05:15:00+00:00")
        self.assertEqual(first["session"]["end_utc"], "2026-11-01T05:45:00+00:00")
        status, repeated = self.request("POST", "/api/sessions", {**base, "group_id": 2, "fold": 1})
        self.assertEqual(status, 409, repeated)
        self.assertEqual(repeated["details"]["session"]["start_utc"], "2026-11-01T06:15:00+00:00")
        self.assertEqual(repeated["details"]["conflicts"][0]["id"], first["session"]["id"])
        # A different local wall-clock slot and a touching UTC boundary both pass.
        status, adjacent = self.request("POST", "/api/sessions", {**base, "start_time": "01:45", "fold": 0})
        self.assertEqual(status, 201, adjacent)
        self.restart_server()
        status, repeated_after_restart = self.request("POST", "/api/sessions", {**base, "fold": 1})
        self.assertEqual(status, 409, repeated_after_restart)

    def test_upcoming_sessions_use_aware_clock_and_utc_instead_of_local_date(self) -> None:
        self.fixed_now = datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc)
        base = {
            "group_id": 1, "title": "Still upcoming on previous local date",
            "session_date": "2026-10-19", "start_time": "20:00",
            "duration_minutes": 30, "timezone": "America/Los_Angeles",
        }
        status, future = self.request("POST", "/api/sessions", base)
        self.assertEqual(status, 201, future)
        # It is already the 20th in Tokyo, but this instant is in the past.
        status, past = self.request("POST", "/api/sessions", {
            **base, "session_date": "2026-10-20", "start_time": "08:00", "timezone": "Asia/Tokyo",
        })
        self.assertEqual(status, 201, past)
        status, dashboard = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(dashboard["today"], "2026-10-20")
        self.assertEqual(dashboard["stats"]["upcoming_sessions"], 1)
        status, _ = self.request("POST", f"/api/sessions/{future['session']['id']}/cancel")
        self.assertEqual(status, 200)
        status, cancelled_dashboard = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(cancelled_dashboard["stats"]["upcoming_sessions"], 0)

    def test_legacy_sessions_migrate_to_utc_and_preserve_records_after_restart(self) -> None:
        status, before = self.get("/api/sessions")
        self.assertEqual(status, 200)
        # Recreate the original sessions schema to exercise real ALTER TABLEs.
        with sqlite3.connect(self.db_path) as db:
            db.executescript(
                """
                ALTER TABLE sessions RENAME TO legacy_sessions;
                CREATE TABLE sessions (
                    id INTEGER PRIMARY KEY,
                    group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
                    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
                    title TEXT NOT NULL, session_date TEXT NOT NULL, start_time TEXT NOT NULL,
                    duration_minutes INTEGER NOT NULL DEFAULT 60, notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                INSERT INTO sessions
                    SELECT id, group_id, course_id, title, session_date, start_time,
                           duration_minutes, notes, created_at FROM legacy_sessions;
                DROP TABLE legacy_sessions;
                """
            )
        self.restart_server()
        status, after = self.get("/api/sessions")
        self.assertEqual(status, 200)
        self.assertEqual(after, before)
        with self.server.database.connect() as db:
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(sessions)")}
            self.assertTrue({"timezone", "status", "cancelled_at", "cancellation_reason"} <= columns)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        first = after["sessions"][0]
        status, conflict = self.request("POST", "/api/sessions", {
            **first, "group_id": 1, "timezone": "UTC",
        })
        self.assertEqual(status, 409, conflict)
        status, cancelled = self.request("POST", f"/api/sessions/{first['id']}/cancel", {"reason": "Migrated"})
        self.assertEqual(status, 200)
        self.restart_server()
        status, again = self.request("POST", f"/api/sessions/{first['id']}/cancel")
        self.assertEqual(status, 200)
        self.assertEqual(again, cancelled)

    def test_sessions_use_explicit_time_zones_utc_conflicts_and_cancellation(self) -> None:
        status, groups_response = self.get("/api/groups")
        self.assertEqual(status, 200)
        joined_groups = [group for group in groups_response["groups"] if group["joined"]]
        first_group, second_group = joined_groups[:2]
        first_payload = {
            "group_id": first_group["id"],
            "title": "Pacific midnight crossing",
            "session_date": "2026-10-19",
            "start_time": "17:00",
            "duration_minutes": 60,
            "timezone": "America/Los_Angeles",
        }
        status, first_response = self.request("POST", "/api/sessions", first_payload)
        self.assertEqual(status, 201)
        first = first_response["session"]
        self.assertEqual(first["time_zone"], "America/Los_Angeles")
        self.assertEqual(first["timezone"], "America/Los_Angeles")
        self.assertEqual(first["start_utc"], "2026-10-20T00:00:00+00:00")
        self.assertEqual(first["end_utc"], "2026-10-20T01:00:00+00:00")
        self.assertEqual(first["status"], "scheduled")
        self.assertEqual(first["created_at"], "2026-10-14T09:00:00+00:00")
        self.assertEqual(first["session_date"], first_payload["session_date"])
        self.assertEqual(first["start_time"], first_payload["start_time"])
        self.assertIsNone(first["cancelled_at"])
        self.assertIsNone(first["cancellation_reason"])
        with sqlite3.connect(self.db_path) as db:
            stored = db.execute(
                "SELECT timezone, start_utc, end_utc, created_at FROM sessions WHERE id = ?",
                (first["id"],),
            ).fetchone()
        self.assertEqual(stored, (first["timezone"], first["start_utc"], first["end_utc"], first["created_at"]))
        self.restart_server()
        status, persisted = self.get("/api/sessions")
        self.assertEqual(status, 200)
        self.assertEqual(next(item for item in persisted["sessions"] if item["id"] == first["id"]), first)

        adjacent = {
            "group_id": second_group["id"],
            "title": "UTC adjacent session",
            "session_date": "2026-10-20",
            "start_time": "01:00",
            "duration_minutes": 30,
            "timezone": "UTC",
        }
        status, adjacent_response = self.request("POST", "/api/sessions", adjacent)
        self.assertEqual(status, 201)
        self.assertEqual(adjacent_response["session"]["start_utc"], "2026-10-20T01:00:00+00:00")

        status, before_cancel = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        upcoming_before = before_cancel["stats"]["upcoming_sessions"]

        overlap = {**adjacent, "title": "UTC overlap", "start_time": "00:00", "duration_minutes": 30}
        status, overlap_error = self.request("POST", "/api/sessions", overlap)
        self.assertEqual(status, 409)
        self.assertIn("conflict", overlap_error["error"].lower())
        self.assertEqual(overlap_error["details"]["conflicts"][0]["id"], first["id"])
        self.assertEqual(overlap_error["details"]["conflict"]["time_zone"], "America/Los_Angeles")
        self.assertEqual(overlap_error["conflict"]["start_utc"], first["start_utc"])
        for field in ("id", "title", "group_name", "session_date", "start_time", "duration_minutes",
                      "time_zone", "start_utc", "end_utc", "status"):
            self.assertIn(field, overlap_error["conflicts"][0])

        status, cancelled = self.request(
            "POST", f"/api/sessions/{first['id']}/cancel", {"reason": "Holiday"}
        )
        self.assertEqual(status, 200)
        cancelled_session = cancelled["session"]
        self.assertEqual(cancelled_session["status"], "cancelled")
        self.assertEqual(cancelled_session["cancelled_at"], "2026-10-14T09:00:00+00:00")
        self.assertEqual(cancelled_session["cancelled_reason"], "Holiday")
        self.assertEqual(cancelled_session["cancellation_reason"], "Holiday")
        # Advancing the clock must not rewrite the first cancellation's metadata.
        self.fixed_now += timedelta(minutes=5)
        status, repeated_cancel = self.request(
            "POST", f"/api/sessions/{first['id']}/cancel", {"reason": "Changed explanation"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(repeated_cancel["session"]["cancelled_at"], cancelled_session["cancelled_at"])
        self.assertEqual(repeated_cancel["session"]["cancelled_reason"], "Holiday")
        self.assertEqual(repeated_cancel["session"], cancelled_session)
        status, after_cancel = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertNotIn(first["id"], {item["id"] for item in after_cancel["sessions"]})
        self.assertEqual(after_cancel["stats"]["upcoming_sessions"], upcoming_before - 1)
        self.restart_server()
        status, after_restart_cancel = self.request("POST", f"/api/sessions/{first['id']}/cancel")
        self.assertEqual(status, 200)
        self.assertEqual(after_restart_cancel["session"], cancelled_session)

        status, reused = self.request("POST", "/api/sessions", overlap)
        self.assertEqual(status, 201)
        self.assertEqual(reused["session"]["start_utc"], first["start_utc"])

        status, invalid_zone = self.request("POST", "/api/sessions", {**adjacent, "title": "Bad zone", "timezone": "Not/IANA"})
        self.assertEqual(status, 400)
        self.assertIn("IANA", invalid_zone["error"])
        status, nonexistent = self.request(
            "POST", "/api/sessions",
            {**adjacent, "title": "DST gap", "session_date": "2026-03-08", "start_time": "02:30",
             "timezone": "America/New_York"},
        )
        self.assertEqual(status, 400)
        self.assertIn("does not exist", nonexistent["error"])

        status, listed = self.get("/api/sessions")
        self.assertEqual(status, 200)
        self.assertNotIn(first["id"], {item["id"] for item in listed["sessions"]})
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute(
                "SELECT status, cancellation_reason, cancelled_at FROM sessions WHERE id = ?", (first["id"],)
            ).fetchone(), ("cancelled", "Holiday", cancelled_session["cancelled_at"]))
        status, dashboard = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(dashboard["today"], "2026-10-14")
        status, missing_cancel = self.request("POST", "/api/sessions/999999/cancel")
        self.assertEqual(status, 404)
        self.assertIn("error", missing_cancel)
        # Local wall-clock conflicts must ignore cancelled records too.
        status, local_reuse = self.request("POST", "/api/sessions", {**first_payload, "start_time": "17:30", "duration_minutes": 30})
        self.assertEqual(status, 201, local_reuse)
        status, no_reason = self.request("POST", f"/api/sessions/{local_reuse['session']['id']}/cancel")
        self.assertEqual(status, 200)
        self.assertIsNone(no_reason["session"]["cancellation_reason"])
        status, deleted = self.request("DELETE", f"/api/sessions/{local_reuse['session']['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(deleted, {"deleted": True})
        status, deleted_cancel = self.request("POST", f"/api/sessions/{local_reuse['session']['id']}/cancel")
        self.assertEqual(status, 404, deleted_cancel)

    def test_duplicate_enrollment_preserves_progress_after_restart(self) -> None:
        """Enroll always returns HTTP 200 with {course, created}; repeats set created=false."""
        status, created = self.request(
            "POST", "/api/courses", {
                "title": "Idempotent enrollment",
                "lessons": [{"title": "Keep this progress", "duration_minutes": 20}],
            },
        )
        self.assertEqual(status, 201)
        course = created["course"]
        lesson_id = course["lessons"][0]["id"]
        status, first_enrollment = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        self.assertFalse(first_enrollment["course"]["already_enrolled"])
        self.assertIs(first_enrollment["created"], True)
        with sqlite3.connect(self.db_path) as db:
            first_row = db.execute("SELECT * FROM enrollments WHERE course_id = ?", (course["id"],)).fetchone()
        status, completed = self.request("POST", f"/api/lessons/{lesson_id}/complete", {})
        self.assertEqual(status, 200)
        status, repeated_enrollment = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        self.assertTrue(repeated_enrollment["course"]["already_enrolled"])
        self.assertIs(repeated_enrollment["created"], False)
        self.assertEqual(repeated_enrollment["course"]["completed_count"], 1)
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM enrollments WHERE course_id = ?", (course["id"],)).fetchone()[0], 1
            )
            self.assertEqual(db.execute("SELECT * FROM enrollments WHERE course_id = ?", (course["id"],)).fetchone(), first_row)

        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        restarted = StudyDatabase(self.db_path, clock=lambda: self.fixed_now)
        self.assertEqual(next(item for item in restarted.list_courses() if item["id"] == course["id"])["completed_count"], 1)
        self.server = create_server(port=0, db_path=self.db_path, clock=lambda: self.fixed_now)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        status, after_restart = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        self.assertTrue(after_restart["course"]["already_enrolled"])
        self.assertIs(after_restart["created"], False)
        self.assertEqual(after_restart["course"]["completed_count"], 1)

    def test_deleting_completed_lessons_cleans_progress_and_prerequisites(self) -> None:
        status, created = self.request(
            "POST", "/api/courses", {
                "title": "Deletion cleanup",
                "lessons": [
                    {"title": "Retained one", "duration_minutes": 20},
                    {"title": "Remove this", "duration_minutes": 20, "prerequisite_positions": [1]},
                    {"title": "Retained three", "duration_minutes": 20, "prerequisite_positions": [2]},
                ],
            },
        )
        self.assertEqual(status, 201)
        course = created["course"]
        first, removed, third = course["lessons"]
        status, _ = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        for lesson in (first, removed, third):
            status, _ = self.request("POST", f"/api/lessons/{lesson['id']}/complete", {})
            self.assertEqual(status, 200)
        with self.server.database.connect() as db:
            retained_progress = [tuple(row) for row in db.execute(
                "SELECT * FROM lesson_progress WHERE lesson_id IN (?, ?) ORDER BY lesson_id",
                (first["id"], third["id"]),
            )]
            for table in ("lesson_progress", "lesson_prerequisites"):
                lesson_keys = [row for row in db.execute(f"PRAGMA foreign_key_list({table})") if row["table"] == "lessons"]
                self.assertTrue(lesson_keys)
                self.assertTrue(all(row["on_delete"] == "CASCADE" for row in lesson_keys))
            # Verify SQLite itself cascades both prerequisite directions, before
            # the service's defensive cleanup can run, then restore the fixture.
            db.execute("SAVEPOINT verify_cascades")
            db.execute("DELETE FROM lessons WHERE id = ?", (removed["id"],))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lesson_progress WHERE lesson_id = ?", (removed["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM lesson_prerequisites WHERE lesson_id = ? OR prerequisite_lesson_id = ?",
                (removed["id"], removed["id"]),
            ).fetchone()[0], 0)
            db.execute("ROLLBACK TO verify_cascades")
            db.execute("RELEASE verify_cascades")

        edited_payload = {
            "title": "Deletion cleanup, revised",
            "lessons": [
                {"id": first["id"], "title": first["title"], "duration_minutes": 20},
                {"id": third["id"], "title": third["title"], "duration_minutes": 20},
            ],
        }
        status, edited = self.request("PUT", f"/api/courses/{course['id']}", edited_payload)
        self.assertEqual(status, 200)
        self.assertEqual([lesson["id"] for lesson in edited["course"]["lessons"]], [first["id"], third["id"]])
        self.assertTrue(edited["course"]["lessons"][0]["completed"])
        self.assertTrue(edited["course"]["lessons"][1]["completed"])
        self.assertEqual(edited["course"]["completed_count"], 2)
        self.assertTrue(edited["course"]["course_complete"])
        self.assertEqual(edited["course"]["progress_percent"], 100)
        self.assertEqual(edited["course"]["lessons"][1]["prerequisite_ids"], [])
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute(
                "SELECT * FROM lesson_progress WHERE lesson_id IN (?, ?) ORDER BY lesson_id",
                (first["id"], third["id"]),
            ).fetchall(), retained_progress)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lesson_progress WHERE lesson_id = ?", (removed["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM lesson_prerequisites WHERE lesson_id = ? OR prerequisite_lesson_id = ?",
                (removed["id"], removed["id"]),
            ).fetchone()[0], 0)
            learner_id = db.execute("SELECT id FROM learners LIMIT 1").fetchone()[0]
            db.execute("PRAGMA foreign_keys = OFF")
            db.execute(
                "INSERT INTO lesson_progress (learner_id, lesson_id, completed_at) VALUES (?, ?, ?)",
                (learner_id, removed["id"], "2026-10-14T09:00:00+00:00"),
            )
            db.execute(
                "INSERT INTO lesson_prerequisites (lesson_id, prerequisite_lesson_id) VALUES (?, ?)",
                (third["id"], removed["id"]),
            )
        StudyDatabase(self.db_path, clock=lambda: self.fixed_now)
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lesson_progress WHERE lesson_id = ?", (removed["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM lesson_prerequisites WHERE lesson_id = ? OR prerequisite_lesson_id = ?",
                (removed["id"], removed["id"]),
            ).fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.restart_server()
        status, persisted = self.get("/api/courses")
        self.assertEqual(status, 200)
        self.assertEqual(next(item for item in persisted["courses"] if item["id"] == course["id"]), edited["course"])

        status, empty_created = self.request(
            "POST", "/api/courses", {"title": "Empty after edit", "lessons": [{"title": "Only lesson"}]},
        )
        self.assertEqual(status, 201)
        empty_course = empty_created["course"]
        status, _ = self.request("POST", f"/api/courses/{empty_course['id']}/enroll", {})
        self.assertEqual(status, 200)
        status, complete = self.request("POST", f"/api/lessons/{empty_course['lessons'][0]['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertTrue(complete["course"]["course_complete"])
        status, empty_edit = self.request("PUT", f"/api/courses/{empty_course['id']}", {"title": "Now empty", "lessons": []})
        self.assertEqual(status, 200)
        self.assertFalse(empty_edit["course"]["course_complete"])
        self.assertEqual(empty_edit["course"]["completed_count"], 0)
        self.assertEqual(empty_edit["course"]["progress_percent"], 0)

    def test_deleting_incomplete_lesson_recalculates_completion(self) -> None:
        status, created = self.request("POST", "/api/courses", {
            "title": "Finish by trimming the plan",
            "lessons": [{"title": "Done"}, {"title": "Not needed", "prerequisite_positions": [1]}],
        })
        self.assertEqual(status, 201)
        course = created["course"]
        first, removed = course["lessons"]
        status, _ = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        status, completed = self.request("POST", f"/api/lessons/{first['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertEqual(completed["course"]["progress_percent"], 50)
        self.assertFalse(completed["course"]["course_complete"])
        status, edited = self.request("PUT", f"/api/courses/{course['id']}", {
            "title": course["title"], "lessons": [{"id": first["id"], "title": "Done, retained"}],
        })
        self.assertEqual(status, 200)
        self.assertTrue(edited["course"]["course_complete"])
        self.assertEqual(edited["course"]["progress_percent"], 100)
        self.assertEqual(edited["course"]["completed_count"], 1)
        status, missing = self.request("POST", f"/api/lessons/{removed['id']}/complete", {})
        self.assertEqual(status, 404, missing)
        with self.server.database.connect() as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_lesson_cleanup_also_handles_legacy_tables_without_cascades(self) -> None:
        status, created = self.request("POST", "/api/courses", {
            "title": "Legacy cleanup", "lessons": [
                {"title": "Keep"}, {"title": "Remove", "prerequisite_positions": [1]},
                {"title": "Keep dependent", "prerequisite_positions": [2]},
            ],
        })
        self.assertEqual(status, 201)
        course = created["course"]
        first, removed, last = course["lessons"]
        status, _ = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        for lesson in (first, removed):
            status, _ = self.request("POST", f"/api/lessons/{lesson['id']}/complete", {})
            self.assertEqual(status, 200)
        # An old SQLite file can have the right columns but lack the cascades.
        with sqlite3.connect(self.db_path) as db:
            db.executescript(
                """
                ALTER TABLE lesson_progress RENAME TO old_progress;
                CREATE TABLE lesson_progress (
                    id INTEGER PRIMARY KEY, learner_id INTEGER NOT NULL, lesson_id INTEGER NOT NULL,
                    completed_at TEXT NOT NULL, UNIQUE (learner_id, lesson_id)
                );
                INSERT INTO lesson_progress SELECT * FROM old_progress;
                DROP TABLE old_progress;
                ALTER TABLE lesson_prerequisites RENAME TO old_prerequisites;
                CREATE TABLE lesson_prerequisites (
                    lesson_id INTEGER NOT NULL, prerequisite_lesson_id INTEGER NOT NULL,
                    PRIMARY KEY (lesson_id, prerequisite_lesson_id)
                );
                INSERT INTO lesson_prerequisites SELECT * FROM old_prerequisites;
                DROP TABLE old_prerequisites;
                """
            )
        self.restart_server()
        status, edited = self.request("PUT", f"/api/courses/{course['id']}", {
            "title": course["title"], "lessons": [
                {"id": first["id"], "title": first["title"]},
                {"id": last["id"], "title": last["title"]},
            ],
        })
        self.assertEqual(status, 200)
        self.assertEqual(edited["course"]["completed_count"], 1)
        self.assertEqual(edited["course"]["progress_percent"], 50)
        self.assertFalse(edited["course"]["course_complete"])
        self.assertTrue(edited["course"]["lessons"][0]["completed"])
        self.assertTrue(edited["course"]["lessons"][1]["can_complete"])
        with sqlite3.connect(self.db_path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM lesson_progress WHERE lesson_id = ?", (removed["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM lesson_prerequisites WHERE lesson_id = ? OR prerequisite_lesson_id = ?",
                (removed["id"], removed["id"]),
            ).fetchone()[0], 0)

    def test_seed_is_useful_and_idempotent_after_restart(self) -> None:
        status, bootstrap = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(
            {course["title"] for course in bootstrap["courses"]},
            {
                "Python for curious minds",
                "The art of open collaboration",
                "A practical guide to data storytelling",
                "Designing for everyone",
            },
        )
        self.assertEqual(sum(course["enrolled"] for course in bootstrap["courses"]), 2)
        self.assertGreater(sum(course["completed_count"] for course in bootstrap["courses"]), 0)
        self.assertGreaterEqual(min(course["lesson_count"] for course in bootstrap["courses"]), 4)
        self.assertEqual(len(bootstrap["groups"]), 3)
        self.assertEqual(len(bootstrap["sessions"]), 3)
        monday = self.fixed_now.date() - timedelta(days=self.fixed_now.date().weekday())
        sunday = monday + timedelta(days=6)
        for session in bootstrap["sessions"]:
            session_day = date.fromisoformat(session["session_date"])
            self.assertGreaterEqual(session_day, monday)
            self.assertLessEqual(session_day, sunday)
            self.assertIn(session["start_time"], {"11:00", "13:30", "16:00"})

        first_counts = (len(bootstrap["courses"]), len(bootstrap["groups"]), len(bootstrap["sessions"]))
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()

        restarted = StudyDatabase(self.db_path, clock=lambda: self.fixed_now)
        self.assertEqual(
            (
                len(restarted.list_courses()),
                len(restarted.list_groups()),
                len(restarted.list_sessions()),
            ),
            first_counts,
        )
        self.server = create_server(port=0, db_path=self.db_path, clock=lambda: self.fixed_now)
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        status, after_restart = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(len(after_restart["courses"]), 4)
        self.assertEqual(sum(course["enrolled"] for course in after_restart["courses"]), 2)

    def test_create_enroll_complete_edit_group_session_and_delete(self) -> None:
        create_payload = {
            "title": "Local field notes",
            "description": "A course made during an integration test.",
            "category": "Writing",
            "level": "Beginner",
            "accent": "#123ABC",
            "lessons": [
                {
                    "title": "Observe before explaining",
                    "summary": "Separate what happened from what you think it means.",
                    "content": "Write down the observation first.\n\nThen name the question it raises.",
                    "duration_minutes": 20,
                },
                {
                    "title": "Share a useful draft",
                    "summary": "Invite a response with a clear question.",
                    "content": "A draft gives others something concrete to respond to.\n\nAsk for one kind of feedback at a time.",
                    "duration_minutes": 25,
                },
            ],
        }
        status, created = self.request("POST", "/api/courses", create_payload)
        self.assertEqual(status, 201)
        course = created["course"]
        course_id = course["id"]
        first_lesson, removed_lesson = course["lessons"]

        status, enrolled = self.request("POST", f"/api/courses/{course_id}/enroll", {})
        self.assertEqual(status, 200)
        self.assertTrue(enrolled["course"]["enrolled"])
        status, completed = self.request("POST", f"/api/lessons/{first_lesson['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertTrue(completed["course"]["lessons"][0]["completed"])

        edit_payload = {
            "title": "Local field notes, revised",
            "description": "An edited course with preserved progress.",
            "category": "Research writing",
            "level": "Intermediate",
            "accent": "#abcdef",
            "lessons": [
                {
                    "id": first_lesson["id"],
                    "title": "Observe before explaining, revised",
                    "summary": first_lesson["summary"],
                    "content": first_lesson["content"] + "\n\nKeep the evidence close.",
                    "duration_minutes": 30,
                },
                {
                    "title": "Make the next question",
                    "summary": "Turn the first observation into a direction.",
                    "content": "A useful next question is specific and answerable.\n\nChoose one small thing to learn next.",
                    "duration_minutes": 25,
                },
            ],
        }
        status, edited = self.request("PUT", f"/api/courses/{course_id}", edit_payload)
        self.assertEqual(status, 200)
        edited_course = edited["course"]
        self.assertEqual(edited_course["title"], edit_payload["title"])
        self.assertEqual([lesson["id"] for lesson in edited_course["lessons"]][0], first_lesson["id"])
        self.assertTrue(edited_course["lessons"][0]["completed"])
        self.assertNotIn(removed_lesson["id"], {lesson["id"] for lesson in edited_course["lessons"]})
        self.assertEqual(len(edited_course["lessons"]), 2)
        self.assertNotEqual(edited_course["lessons"][1]["id"], removed_lesson["id"])

        status, groups = self.get("/api/groups")
        self.assertEqual(status, 200)
        unjoined = next(group for group in groups["groups"] if not group["joined"])
        status, joined = self.request("POST", f"/api/groups/{unjoined['id']}/join", {})
        self.assertEqual(status, 200)
        self.assertTrue(joined["group"]["joined"])
        member_count = joined["group"]["member_count"]
        status, joined_again = self.request("POST", f"/api/groups/{unjoined['id']}/join", {})
        self.assertEqual(status, 200)
        self.assertEqual(joined_again["group"]["member_count"], member_count)

        session_payload = {
            "group_id": unjoined["id"],
            "course_id": course_id,
            "title": "Field notes work session",
            "session_date": (self.fixed_now.date() + timedelta(days=1)).isoformat(),
            "start_time": "14:15",
            "timezone": "UTC",
            "duration_minutes": 45,
            "notes": "Bring the revised observation.",
        }
        status, created_session = self.request("POST", "/api/sessions", session_payload)
        self.assertEqual(status, 201)
        session_id = created_session["session"]["id"]
        status, sessions = self.get("/api/sessions")
        self.assertEqual(status, 200)
        self.assertEqual(next(item for item in sessions["sessions"] if item["id"] == session_id)["title"], session_payload["title"])
        status, deleted = self.request("DELETE", f"/api/sessions/{session_id}")
        self.assertEqual(status, 200)
        self.assertEqual(deleted, {"deleted": True})
        status, sessions_after_delete = self.get("/api/sessions")
        self.assertNotIn(session_id, {item["id"] for item in sessions_after_delete["sessions"]})
        status, error = self.request("DELETE", f"/api/sessions/{session_id}")
        self.assertEqual(status, 404)
        self.assertIn("error", error)

    def test_validation_rejects_invalid_values_and_keeps_database_unchanged(self) -> None:
        status, before = self.get("/api/courses")
        self.assertEqual(status, 200)
        course_count = len(before["courses"])

        invalid_courses = [
            {"title": "Bad color", "accent": "blue", "lessons": []},
            {"title": "Fraction", "lessons": [{"title": "Lesson", "duration_minutes": 12.5}]},
            {"title": "Boolean", "lessons": [{"title": "Lesson", "duration_minutes": True}]},
        ]
        for payload in invalid_courses:
            status, error = self.request("POST", "/api/courses", payload)
            self.assertEqual(status, 400)
            self.assertIn("error", error)
            self.assertIsInstance(error["details"], dict)
        status, after_invalid_courses = self.get("/api/courses")
        self.assertEqual(status, 200)
        self.assertEqual(len(after_invalid_courses["courses"]), course_count)

        course = after_invalid_courses["courses"][0]
        original_title = course["title"]
        foreign_lesson_id = next(
            other_lesson["id"]
            for other in after_invalid_courses["courses"]
            if other["id"] != course["id"]
            for other_lesson in other["lessons"]
        )
        edit_payload = {
            "title": "Should not be written",
            "accent": "#123456",
            "lessons": [{"id": foreign_lesson_id, "title": "Foreign", "duration_minutes": 20}],
        }
        status, error = self.request("PUT", f"/api/courses/{course['id']}", edit_payload)
        self.assertEqual(status, 400)
        self.assertIn("belong", error["error"])
        status, unchanged = self.get("/api/courses")
        self.assertEqual(status, 200)
        self.assertEqual(next(item for item in unchanged["courses"] if item["id"] == course["id"])["title"], original_title)

        session_base = {
            "group_id": 1,
            "title": "Invalid date test",
            "session_date": "2026-1-01",
            "start_time": "9:00",
            "timezone": "UTC",
        }
        status, error = self.request("POST", "/api/sessions", session_base)
        self.assertEqual(status, 400)
        self.assertIn("Date", error["error"])
        session_base["session_date"] = "2026-02-30"
        session_base["start_time"] = "09:00"
        status, error = self.request("POST", "/api/sessions", session_base)
        self.assertEqual(status, 400)
        self.assertIn("calendar", error["error"])

        oversized = {"title": "x" * (MAX_PAYLOAD_BYTES + 1)}
        status, error = self.request("POST", "/api/courses", oversized)
        self.assertEqual(status, 413)
        self.assertIn("too large", error["error"])

    def test_discussions_progress_exports_and_sqlite_restore_are_safe(self) -> None:
        status, discussion = self.get("/api/groups/1/posts")
        self.assertEqual(status, 200)
        self.assertEqual(discussion["group"]["id"], 1)

        hostile_body = "<script>alert('x')</script>\nA useful update"
        status, created = self.request("POST", "/api/groups/1/posts", {"body": hostile_body})
        self.assertEqual(status, 201)
        post = created["post"]
        self.assertEqual(post["body"], hostile_body)
        self.assertTrue(post["can_edit"])
        self.assertTrue(post["can_delete"])

        status, listed = self.get("/api/groups/1/posts")
        self.assertEqual(status, 200)
        self.assertEqual(listed["posts"][0]["body"], hostile_body)

        status, edited = self.request(
            "PUT", f"/api/groups/1/posts/{post['id']}", {"body": "Edited <b>as text</b>"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(edited["post"]["body"], "Edited <b>as text</b>")
        status, invalid_post = self.request("POST", "/api/groups/1/posts", {"body": "\u0000\u0001"})
        self.assertEqual(status, 400)
        status, not_member = self.request("POST", "/api/groups/3/posts", {"body": "Not allowed"})
        self.assertEqual(status, 409)
        self.assertIn("Join", not_member["error"])

        status, progress = self.get("/api/progress")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(progress["summary"]["lessons_completed"], 1)
        self.assertIn("recent_completed_lessons", progress)
        self.assertTrue(any(course["next_lesson"] for course in progress["courses"] if course["enrolled"]))
        status, bootstrap = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(bootstrap["stats"]["completed_lessons"], progress["summary"]["lessons_completed"])
        self.assertEqual(bootstrap["stats"]["enrolled_courses"], progress["summary"]["enrolled_courses"])
        self.assertEqual(bootstrap["stats"]["overall_progress"], progress["summary"]["overall_progress_percent"])

        status, headers, json_export = self.raw_request("GET", "/api/export.json", b"")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        exported = json.loads(json_export.decode("utf-8"))
        self.assertTrue(any(item["body"] == "Edited <b>as text</b>" for item in exported["posts"]))
        status, _, csv_export = self.raw_request("GET", "/api/export.csv", b"")
        self.assertEqual(status, 200)
        self.assertIn("post", csv_export.decode("utf-8"))

        status, _, backup = self.raw_request("GET", "/api/backup", b"")
        self.assertEqual(status, 200)
        self.assertTrue(backup.startswith(b"SQLite format 3\x00"))
        status, _, validation = self.raw_request("POST", "/api/restore/validate", backup)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(validation.decode("utf-8"))["valid"])

        status, extra = self.request("POST", "/api/groups/1/posts", {"body": "Only before restore"})
        self.assertEqual(status, 201)
        status, _, invalid_restore = self.raw_request("POST", "/api/restore", b"not a sqlite database")
        self.assertEqual(status, 400)
        self.assertIn("error", json.loads(invalid_restore.decode("utf-8")))
        status, after_invalid = self.get("/api/groups/1/posts")
        self.assertTrue(any(item["id"] == extra["post"]["id"] for item in after_invalid["posts"]))

        status, _, restored = self.raw_request("POST", "/api/restore", backup)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(restored.decode("utf-8"))["restored"])
        status, after_restore = self.get("/api/groups/1/posts")
        self.assertFalse(any(item["id"] == extra["post"]["id"] for item in after_restore["posts"]))
        self.assertEqual(after_restore["posts"][0]["body"], "Edited <b>as text</b>")

    def test_requested_learning_flow_conflict_and_json_backup_round_trip(self) -> None:
        course_payload = {
            "title": "Flow check course",
            "description": "A complete local browser flow fixture.",
            "category": "Testing",
            "level": "Beginner",
            "lessons": [
                {"title": "Start locally", "content": "Read the first note.", "duration_minutes": 20},
                {"title": "Finish locally", "content": "Complete the second note.", "duration_minutes": 20},
            ],
        }
        status, created = self.request("POST", "/api/courses", course_payload)
        self.assertEqual(status, 201)
        course = created["course"]
        first, second = course["lessons"]

        status, enrolled = self.request("POST", f"/api/courses/{course['id']}/enroll", {})
        self.assertEqual(status, 200)
        self.assertTrue(enrolled["course"]["enrolled"])
        status, completed_first = self.request("POST", f"/api/lessons/{first['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertTrue(completed_first["course"]["lessons"][0]["completed"])
        status, completed_second = self.request("POST", f"/api/lessons/{second['id']}/complete", {})
        self.assertEqual(status, 200)
        self.assertTrue(completed_second["course"]["course_complete"])

        session_payload = {
            "group_id": 1,
            "course_id": course["id"],
            "title": "Flow check session",
            "session_date": (self.fixed_now.date() + timedelta(days=2)).isoformat(),
            "start_time": "19:00",
            "timezone": "UTC",
            "duration_minutes": 60,
            "notes": "Conflict fixture",
        }
        status, scheduled = self.request("POST", "/api/sessions", session_payload)
        self.assertEqual(status, 201)
        session_id = scheduled["session"]["id"]
        status, conflict = self.request("POST", "/api/sessions", session_payload)
        self.assertEqual(status, 409)
        self.assertIn("conflict", conflict["error"].lower())
        status, sessions = self.get("/api/sessions")
        self.assertEqual(status, 200)
        self.assertEqual(sum(item["id"] == session_id for item in sessions["sessions"]), 1)

        status, _, exported_bytes = self.raw_request("GET", "/api/export.json", b"")
        self.assertEqual(status, 200)
        exported = json.loads(exported_bytes.decode("utf-8"))
        status, validated = self.request("POST", "/api/backup/validate", exported)
        self.assertEqual(status, 200)
        self.assertTrue(validated["valid"])
        self.assertEqual(validated["counts"]["courses"], len(exported["courses"]))

        status, created_after_backup = self.request("POST", "/api/courses", {
            "title": "Should disappear after JSON restore",
            "lessons": [{"title": "Temporary", "duration_minutes": 20}],
        })
        self.assertEqual(status, 201)
        temporary_id = created_after_backup["course"]["id"]
        status, restored = self.request("POST", "/api/backup/restore", exported)
        self.assertEqual(status, 200)
        self.assertTrue(restored["restored"])
        status, after_restore = self.get("/api/courses")
        self.assertEqual(status, 200)
        self.assertNotIn(temporary_id, {item["id"] for item in after_restore["courses"]})
        restored_course = next(item for item in after_restore["courses"] if item["id"] == course["id"])
        self.assertTrue(restored_course["course_complete"])

        self.restart_server()
        status, after_restart = self.get("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertTrue(next(item for item in after_restart["courses"] if item["id"] == course["id"])["course_complete"])
        self.assertIn(session_id, {item["id"] for item in after_restart["sessions"]})


if __name__ == "__main__":
    unittest.main()
