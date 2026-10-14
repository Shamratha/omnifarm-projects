"""Local Study Workspace.

A small, dependency-free Python service for planning and tracking local study.
The service exposes JSON endpoints for the browser UI and serves the static
interface from ``public/``.  SQLite is intentionally the only persistence
layer so the workspace can be copied, backed up, and run without a cloud
account.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import mimetypes
import os
import re
import sqlite3
import tempfile
import unicodedata
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DEFAULT_DB = ROOT / "study_workspace.db"
MAX_PAYLOAD_BYTES = 256 * 1024
MAX_BACKUP_PAYLOAD_BYTES = 50 * 1024 * 1024
BACKUP_VERSION = 1
BACKUP_SCHEMA = "local-study-workspace"
CSV_EXPORT_COLUMNS = [
    "record_type", "id", "parent_id", "learner_id", "name", "role", "author_name", "author_role",
    "course_id", "course_title", "lesson_id", "prerequisite_lesson_id", "group_id", "title", "body",
    "enrolled", "lesson_count", "completed_count", "progress_percent", "course_complete", "next_lesson_id",
    "completed", "completed_at", "created_at", "updated_at", "session_date", "start_time", "timezone",
    "duration_minutes", "status", "cancellation_reason", "member_count", "post_count", "enrolled_course_count",
    "total_lessons", "progress_percent", "completed_lessons",
]
HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
INTEGER_PATTERN = re.compile(r"^[+-]?\d+$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_PATTERN = re.compile(r"^\d{2}:\d{2}$")


class ApiError(Exception):
    """An expected API error with an HTTP status code."""

    def __init__(self, status: HTTPStatus, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details


class StudyDatabase:
    """SQLite-backed application service."""

    def __init__(self, path: str | Path, *, clock: Callable[[], datetime] | None = None):
        self.path = Path(path)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self) -> None:
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS learners (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'Learner',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS courses (
                    id INTEGER PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT 'General',
                    level TEXT NOT NULL DEFAULT 'Mixed',
                    accent TEXT NOT NULL DEFAULT '#7c5cff',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                 CREATE TABLE IF NOT EXISTS lessons (
                    id INTEGER PRIMARY KEY,
                    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    duration_minutes INTEGER NOT NULL DEFAULT 30,
                    position INTEGER NOT NULL DEFAULT 1,
                     created_at TEXT NOT NULL
                 );

                 CREATE TABLE IF NOT EXISTS lesson_prerequisites (
                     lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                     prerequisite_lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                     PRIMARY KEY (lesson_id, prerequisite_lesson_id),
                     CHECK (lesson_id <> prerequisite_lesson_id)
                 );

                CREATE TABLE IF NOT EXISTS enrollments (
                    id INTEGER PRIMARY KEY,
                    learner_id INTEGER NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
                    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
                    enrolled_at TEXT NOT NULL,
                    UNIQUE (learner_id, course_id)
                );

                CREATE TABLE IF NOT EXISTS lesson_progress (
                    id INTEGER PRIMARY KEY,
                    learner_id INTEGER NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
                    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
                    completed_at TEXT NOT NULL,
                    UNIQUE (learner_id, lesson_id)
                );

                CREATE TABLE IF NOT EXISTS study_groups (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    color TEXT NOT NULL DEFAULT '#19c3a3',
                    created_at TEXT NOT NULL
                );

                 CREATE TABLE IF NOT EXISTS group_members (
                     id INTEGER PRIMARY KEY,
                     group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
                     learner_id INTEGER NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
                     joined_at TEXT NOT NULL,
                     UNIQUE (group_id, learner_id)
                 );

                 CREATE TABLE IF NOT EXISTS group_posts (
                     id INTEGER PRIMARY KEY,
                     group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
                     learner_id INTEGER NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
                     body TEXT NOT NULL,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );

                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY,
                    group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
                    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
                    title TEXT NOT NULL,
                    session_date TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    timezone TEXT NOT NULL DEFAULT 'UTC',
                    duration_minutes INTEGER NOT NULL DEFAULT 60,
                    notes TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'scheduled',
                    cancelled_at TEXT,
                    cancellation_reason TEXT,
                    time_zone TEXT NOT NULL DEFAULT 'UTC',
                    start_utc TEXT,
                    end_utc TEXT,
                    cancelled_reason TEXT,
                    created_at TEXT NOT NULL
                );

                 CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, position);
                 CREATE INDEX IF NOT EXISTS idx_prerequisites_lesson ON lesson_prerequisites(lesson_id);
                 CREATE INDEX IF NOT EXISTS idx_prerequisites_required ON lesson_prerequisites(prerequisite_lesson_id);
                  CREATE INDEX IF NOT EXISTS idx_progress_learner ON lesson_progress(learner_id);
                  CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(session_date, start_time);
                  CREATE INDEX IF NOT EXISTS idx_group_posts_group_created ON group_posts(group_id, created_at, id);
                  CREATE INDEX IF NOT EXISTS idx_group_posts_author ON group_posts(learner_id);

                 CREATE TABLE IF NOT EXISTS app_metadata (
                      key TEXT PRIMARY KEY,
                      value TEXT NOT NULL
                  );

                  CREATE TABLE IF NOT EXISTS lesson_id_sequence (
                      next_id INTEGER NOT NULL
                  );
                  """
              )
            db.execute("BEGIN IMMEDIATE")
            self.migrate_sessions(db)
            self.migrate_enrollments(db)
            self.migrate_group_posts(db)
            self.cleanup_orphan_lesson_rows(db)
            self.ensure_lesson_id_sequence(db)
            learner = db.execute("SELECT id FROM learners ORDER BY id LIMIT 1").fetchone()
            if learner is None:
                now = self.now()
                db.execute(
                    "INSERT INTO learners (name, role, created_at) VALUES (?, ?, ?)",
                    ("Alex Morgan", "Local learner", now),
                )
            course_count = db.execute("SELECT COUNT(*) AS count FROM courses").fetchone()["count"]
            seed_marker = db.execute(
                "SELECT 1 FROM app_metadata WHERE key = 'example_seed_v1'"
            ).fetchone()
            if course_count == 0 and seed_marker is None:
                self.seed(db)
                db.execute(
                    "INSERT INTO app_metadata (key, value) VALUES ('example_seed_v1', 'complete')"
                )
            elif seed_marker is None:
                # Existing databases predate the marker. Their data is user-owned;
                # mark them initialized without adding or replacing any records.
                db.execute(
                    "INSERT INTO app_metadata (key, value) VALUES ('example_seed_v1', 'existing')"
                )

    @staticmethod
    def migrate_sessions(db: sqlite3.Connection) -> None:
        """Upgrade legacy sessions in place without replacing user records."""
        columns = {row["name"] for row in db.execute("PRAGMA table_info(sessions)")}
        had_timezone = "timezone" in columns
        additions = {
            "timezone": "TEXT NOT NULL DEFAULT 'UTC'",
            "time_zone": "TEXT NOT NULL DEFAULT 'UTC'",
            "start_utc": "TEXT",
            "end_utc": "TEXT",
            "status": "TEXT NOT NULL DEFAULT 'scheduled'",
            "cancelled_at": "TEXT",
            "cancellation_reason": "TEXT",
            "cancelled_reason": "TEXT",
        }
        for name, definition in additions.items():
            if name not in columns:
                db.execute(f"ALTER TABLE sessions ADD COLUMN {name} {definition}")

        # Some intermediate versions called the public field ``time_zone`` and
        # the cancellation field ``cancelled_reason``.  Keep those columns for
        # old clients, but make the canonical schema authoritative.
        if not had_timezone and "time_zone" in columns:
            db.execute(
                "UPDATE sessions SET timezone = time_zone "
                "WHERE time_zone IS NOT NULL AND trim(time_zone) <> ''"
            )
        if "cancelled_reason" in columns:
            db.execute(
                "UPDATE sessions SET cancellation_reason = cancelled_reason "
                "WHERE cancellation_reason IS NULL AND cancelled_reason IS NOT NULL"
            )
        for session in db.execute(
            "SELECT * FROM sessions WHERE start_utc IS NULL OR end_utc IS NULL"
        ).fetchall():
            start_utc, end_utc = session_utc_interval(
                session["session_date"], session["start_time"],
                session["duration_minutes"], session["timezone"],
            )
            db.execute(
                "UPDATE sessions SET start_utc = ?, end_utc = ? WHERE id = ?",
                (start_utc, end_utc, session["id"]),
            )
        db.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sessions_scheduled_interval
            ON sessions(start_utc, end_utc, group_id) WHERE status = 'scheduled'
            """
        )
        db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)")

    @staticmethod
    def migrate_enrollments(db: sqlite3.Connection) -> None:
        """Make legacy enrollment rows idempotent while retaining first enrollment."""
        db.execute(
            """
            DELETE FROM enrollments
            WHERE id NOT IN (
                SELECT MIN(id) FROM enrollments GROUP BY learner_id, course_id
            )
            """
        )
        db.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_learner_course
            ON enrollments(learner_id, course_id)
            """
        )

    @staticmethod
    def migrate_group_posts(db: sqlite3.Connection) -> None:
        """Create the discussion table and indexes for older workspace files."""
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS group_posts (
                id INTEGER PRIMARY KEY,
                group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
                learner_id INTEGER NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_group_posts_group_created "
            "ON group_posts(group_id, created_at, id)"
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_group_posts_author ON group_posts(learner_id)"
        )

    @staticmethod
    def cleanup_orphan_lesson_rows(db: sqlite3.Connection) -> None:
        """Repair records left by older databases with foreign keys disabled."""
        db.execute(
            """
            DELETE FROM lesson_progress
            WHERE NOT EXISTS (SELECT 1 FROM lessons WHERE lessons.id = lesson_progress.lesson_id)
               OR NOT EXISTS (SELECT 1 FROM learners WHERE learners.id = lesson_progress.learner_id)
            """
        )
        db.execute(
            """
            DELETE FROM lesson_prerequisites
            WHERE NOT EXISTS (SELECT 1 FROM lessons WHERE lessons.id = lesson_prerequisites.lesson_id)
               OR NOT EXISTS (
                   SELECT 1 FROM lessons WHERE lessons.id = lesson_prerequisites.prerequisite_lesson_id
               )
            """
        )
        db.execute("CREATE INDEX IF NOT EXISTS idx_progress_lesson ON lesson_progress(lesson_id)")

    @staticmethod
    def ensure_lesson_id_sequence(db: sqlite3.Connection) -> None:
        """Create and advance the lesson high-water mark for old databases."""
        db.execute(
            "CREATE TABLE IF NOT EXISTS lesson_id_sequence (next_id INTEGER NOT NULL)"
        )
        maximum = int(db.execute("SELECT COALESCE(MAX(id), 0) FROM lessons").fetchone()[0])
        row = db.execute("SELECT next_id FROM lesson_id_sequence LIMIT 1").fetchone()
        if row is None:
            db.execute("INSERT INTO lesson_id_sequence (next_id) VALUES (?)", (maximum + 1,))
        elif int(row[0]) <= maximum:
            db.execute("UPDATE lesson_id_sequence SET next_id = ?", (maximum + 1,))

    def current_time(self) -> datetime:
        """Read the injected clock as an aware UTC instant."""
        current = self.clock()
        if not isinstance(current, datetime) or current.utcoffset() is None:
            raise ValueError("The application clock must return a timezone-aware datetime")
        return current.astimezone(timezone.utc)

    def now(self) -> str:
        return self.current_time().isoformat(timespec="seconds")

    def today(self) -> date:
        return self.current_time().date()

    def seed(self, db: sqlite3.Connection) -> None:
        """Seed an inviting first-run workspace without overwriting user data."""
        now = self.now()
        courses = [
            {
                "title": "Python for curious minds",
                "description": "Build a friendly mental model of Python by turning everyday questions into small, readable experiments.",
                "category": "Python",
                "level": "Beginner",
                "accent": "#7c5cff",
                "lessons": [
                    (
                        "Think in objects and actions",
                        "Turn a real-world question into names, values, and small actions.",
                        "Python becomes less mysterious when you describe a task in ordinary language first. A book has a title, a reading list has several books, and a study plan can answer questions about both.\n\nWrite down the nouns and verbs in a small problem before opening the editor. This gives you useful candidates for variables, lists, and functions without asking syntax to do the thinking for you.",
                        25,
                    ),
                    (
                        "Make a tiny experiment",
                        "Use expressions, loops, and print statements to learn by observation.",
                        "A short program is a laboratory: change one value, run it, and describe what changed. Start with arithmetic and strings, then use a loop when the same action needs to happen more than once.\n\nKeep experiments visible while learning. A few carefully chosen print statements can show the shape of your data and help you ask a better next question than a long program written all at once.",
                        30,
                    ),
                    (
                        "Name repetition with functions",
                        "Package a useful idea so it can be tested and reused.",
                        "A function should have one clear job and a name that tells the reader what it does. Begin with an input and an expected output, then write the smallest body that connects them.\n\nTry calling the function with an ordinary value, an empty value, and a surprising value. These small checks make the behavior concrete and teach you where the boundaries of your idea really are.",
                        30,
                    ),
                    (
                        "Read data with care",
                        "Explore a small text file while keeping assumptions visible.",
                        "Files are conversations with the past: their headings, blank lines, and spelling carry meaning. Read a few rows by hand before transforming them, and decide how missing or unexpected values should be treated.\n\nA trustworthy result includes the question, the transformation, and the limitation. Save a small sample beside your script so another learner can reproduce the path from raw text to conclusion.",
                        35,
                    ),
                ],
            },
            {
                "title": "The art of open collaboration",
                "description": "Learn the habits that make shared work welcoming, legible, and easier for the next person to continue.",
                "category": "Open source",
                "level": "Beginner",
                "accent": "#19c3a3",
                "lessons": [
                    (
                        "Find the invitation",
                        "Orient yourself in a project before proposing a change.",
                        "Start with the README, contribution guide, and recent conversations. They reveal what the project values, how decisions are made, and where a new person can make a safe first step.\n\nChoose a small question that can be answered by reading existing work. Showing that you did the orientation is a form of respect and gives maintainers useful context when you eventually ask for help.",
                        25,
                    ),
                    (
                        "Write a useful issue",
                        "Describe a problem so another person can reproduce and discuss it.",
                        "A good issue separates what you expected from what happened. Include the smallest example, the environment or steps involved, and why the result matters to someone using the project.\n\nAvoid guessing at a solution too early. A clear description leaves room for people with different experience to contribute an explanation, a test, documentation, or code.",
                        30,
                    ),
                    (
                        "Make a review easier",
                        "Offer changes that are focused, explainable, and kind to review.",
                        "Keep a contribution narrow enough that a reviewer can hold its purpose in mind. In the description, name the problem, the approach, and how you checked the result.\n\nReview comments work best when they point to behavior or clarity rather than a person's character. Ask a question when you are uncertain, and thank the author when a detail helps you understand the project.",
                        35,
                    ),
                    (
                        "Leave a trail",
                        "Turn a solved question into documentation that welcomes the next learner.",
                        "When a confusing step becomes clear, capture the path rather than only the final command. A short example, glossary entry, or troubleshooting note can save many future conversations.\n\nRead the note as a first-time visitor. Replace insider language, link ideas to the surrounding workflow, and say what a reader should see when the step worked.",
                        25,
                    ),
                ],
            },
            {
                "title": "A practical guide to data storytelling",
                "description": "Move from a messy observation to a clear, honest story that helps people decide what to explore next.",
                "category": "Data science",
                "level": "Intermediate",
                "accent": "#ffb547",
                "lessons": [
                    (
                        "Start with the audience",
                        "Shape an analysis around a real decision and a real reader.",
                        "A data story is not a collection of interesting numbers. Begin by naming who needs to act, what they already know, and which uncertainty makes the decision difficult.\n\nWrite one sentence describing the decision before choosing a chart. That sentence keeps the analysis grounded and gives you a useful test for whether each calculation belongs in the story.",
                        35,
                    ),
                    (
                        "Audit the raw material",
                        "Check definitions, missing values, and the time window before finding a pattern.",
                        "Spend time with the rows before spending time with the chart. Identify what one row represents, how fields were collected, which values are absent, and whether the period includes an unusual event.\n\nKeep an audit note beside the data. Recording an assumption while it is fresh makes later explanations more honest and makes it easier for another person to challenge or improve the work.",
                        40,
                    ),
                    (
                        "Choose a revealing comparison",
                        "Use a baseline and a meaningful grouping to make change understandable.",
                        "A number gains meaning through comparison: with an earlier period, a stated goal, or another group measured in the same way. Pick one comparison that serves the decision instead of adding every available dimension.\n\nCheck whether the comparison is fair. Differences in population, collection method, or exposure can create a persuasive-looking result that answers a different question from the one your audience asked.",
                        40,
                    ),
                    (
                        "Make the chart speak",
                        "Reduce visual noise and give the important relationship a clear sentence.",
                        "Use a chart form that matches the question: positions for comparison, lines for change, and a small number of categories for composition. Remove decoration that competes with the evidence.\n\nWrite a title that states the takeaway without exaggerating it. Put units, dates, and source notes close to the chart so a reader does not need a separate investigation to interpret it.",
                        35,
                    ),
                    (
                        "Name the limits and next step",
                        "End with what the evidence supports, what it cannot show, and what to learn next.",
                        "A strong conclusion is specific about uncertainty. Say whether the data describes a relationship, a trend, or a tested effect, and identify the assumptions that could change the reading.\n\nOffer one useful next step: collect a missing measure, speak with people represented by the data, or run a small follow-up. This turns the story into a shared inquiry rather than a final verdict.",
                        30,
                    ),
                ],
            },
            {
                "title": "Designing for everyone",
                "description": "Practice inclusive design by noticing barriers, testing assumptions, and making everyday interfaces easier to use.",
                "category": "Design",
                "level": "Beginner",
                "accent": "#ff735c",
                "lessons": [
                    (
                        "Notice the whole situation",
                        "Look beyond the screen to the people, place, and pressure around an interaction.",
                        "People use products while distracted, tired, rushed, learning a language, or relying on assistive technology. Start by observing the conditions around a task instead of imagining one ideal user.\n\nWrite down where the task asks for memory, precision, speed, or interpretation. Each demand is a chance to make the experience more forgiving without lowering its usefulness.",
                        25,
                    ),
                    (
                        "Give information more than one path",
                        "Use language, structure, and visual cues together instead of depending on one signal.",
                        "Color can support meaning, but it should not carry meaning alone. Pair status colors with text, icons, labels, or patterns, and keep the relationship consistent wherever it appears.\n\nPlain language is part of visual design. Short headings, descriptive buttons, and a clear order help people scan, translate, zoom, or listen to the interface with less effort.",
                        30,
                    ),
                    (
                        "Design the keyboard path",
                        "Make focus visible and the important actions reachable without a pointer.",
                        "Move through an interface using only the keyboard. The focus order should follow the task, the focused item should be obvious, and no control should trap the person in a loop.\n\nTreat the keyboard path as a design sketch, not a final audit. When it feels awkward, the underlying hierarchy or wording may need attention too.",
                        30,
                    ),
                    (
                        "Test with real friction",
                        "Learn from specific barriers instead of asking whether someone simply likes the design.",
                        "Invite a person to complete a concrete task and ask them to think aloud only when it does not interrupt their work. Watch for hesitation, workarounds, and places where the interface makes the next step hard to predict.\n\nRecord the barrier, its impact, and a possible change separately. This helps a team prioritize the user's need without treating one proposed fix as the only answer.",
                        35,
                    ),
                ],
            },
        ]
        course_ids: list[int] = []
        lesson_ids_by_course: dict[int, list[int]] = {}
        for course in courses:
            cursor = db.execute(
                """
                INSERT INTO courses (title, description, category, level, accent, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (course["title"], course["description"], course["category"], course["level"], course["accent"], now, now),
            )
            course_id = int(cursor.lastrowid)
            course_ids.append(course_id)
            lesson_ids_by_course[course_id] = []
            for position, lesson in enumerate(course["lessons"], start=1):
                lesson_cursor = db.execute(
                    """
                    INSERT INTO lessons
                        (course_id, title, summary, content, duration_minutes, position, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (course_id, lesson[0], lesson[1], lesson[2].strip(), lesson[3], position, now),
                )
                lesson_ids_by_course[course_id].append(int(lesson_cursor.lastrowid))
            lesson_ids = lesson_ids_by_course[course_id]
            db.executemany(
                "INSERT INTO lesson_prerequisites (lesson_id, prerequisite_lesson_id) VALUES (?, ?)",
                zip(lesson_ids[1:], lesson_ids[:-1]),
            )

        learner_id = self.learner(db)["id"]
        for course_id in course_ids[:2]:
            db.execute(
                "INSERT INTO enrollments (learner_id, course_id, enrolled_at) VALUES (?, ?, ?)",
                (learner_id, course_id, now),
            )
        for course_id, completed_count in ((course_ids[0], 2), (course_ids[1], 1)):
            for lesson_id in lesson_ids_by_course[course_id][:completed_count]:
                db.execute(
                    "INSERT INTO lesson_progress (learner_id, lesson_id, completed_at) VALUES (?, ?, ?)",
                    (learner_id, lesson_id, now),
                )

        group_specs = [
            ("Saturday Study Circle", "A gentle weekly space for sharing progress and unblocking one another.", "#19c3a3"),
            ("Open Knowledge Makers", "Build public learning resources together, one small experiment at a time.", "#ffb547"),
            ("Quiet Data Practice", "A low-pressure place to compare questions, assumptions, and useful next steps.", "#ff735c"),
        ]
        group_ids: list[int] = []
        for index, (name, description, color) in enumerate(group_specs):
            cursor = db.execute(
                "INSERT INTO study_groups (name, description, color, created_at) VALUES (?, ?, ?, ?)",
                (name, description, color, now),
            )
            group_ids.append(int(cursor.lastrowid))
            if index < 2:
                db.execute(
                    "INSERT INTO group_members (group_id, learner_id, joined_at) VALUES (?, ?, ?)",
                    (cursor.lastrowid, learner_id, now),
                )

        today = self.today()
        monday = today - timedelta(days=today.weekday())
        example_sessions = [
            (group_ids[0], course_ids[0], "Python question lab", monday + timedelta(days=1), "11:00", 60, "Bring one small experiment or a question from your notes."),
            (group_ids[1], course_ids[1], "Open collaboration clinic", monday + timedelta(days=2), "13:30", 75, "Bring a project page, issue, or contribution idea to discuss."),
            (group_ids[2], course_ids[2], "Data story workbench", monday + timedelta(days=4), "16:00", 60, "Share a question and one assumption behind your data story."),
        ]
        for group_id, course_id, title, session_date, start_time, duration, notes in example_sessions:
            start_utc, end_utc = session_utc_interval(session_date.isoformat(), start_time, duration, "UTC")
            db.execute(
                """
                INSERT INTO sessions
                    (group_id, course_id, title, session_date, start_time, duration_minutes, notes,
                     created_at, timezone, time_zone, start_utc, end_utc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (group_id, course_id, title, session_date.isoformat(), start_time, duration, notes,
                 now, "UTC", "UTC", start_utc, end_utc),
            )

    def learner(self, db: sqlite3.Connection | None = None) -> dict[str, Any]:
        owns_connection = db is None
        db = db or self.connect()
        try:
            row = db.execute("SELECT id, name, role FROM learners ORDER BY id LIMIT 1").fetchone()
            if row is None:
                raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "No local learner is configured")
            return dict(row)
        finally:
            if owns_connection:
                db.close()

    def list_courses(self, db: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        owns_connection = db is None
        db = db or self.connect()
        try:
            learner_id = self.learner(db)["id"]
            rows = db.execute(
                """
                SELECT c.id, c.title, c.description, c.category, c.level, c.accent,
                       c.created_at, c.updated_at,
                       EXISTS (
                           SELECT 1 FROM enrollments e
                           WHERE e.course_id = c.id AND e.learner_id = ?
                       ) AS enrolled,
                       COUNT(l.id) AS lesson_count,
                       COUNT(lp.id) AS completed_count
                FROM courses c
                LEFT JOIN lessons l ON l.course_id = c.id
                LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.learner_id = ?
                GROUP BY c.id
                ORDER BY c.created_at DESC, c.id DESC
                """,
                (learner_id, learner_id),
            ).fetchall()
            courses = []
            for row in rows:
                course = dict(row)
                course["enrolled"] = bool(course["enrolled"])
                course["progress_percent"] = self.progress_percent(course["completed_count"], course["lesson_count"])
                course["completion_rule"] = "all_lessons"
                course["course_complete"] = (
                    course["enrolled"] and course["lesson_count"] > 0
                    and course["completed_count"] == course["lesson_count"]
                )
                course["lessons"] = self.lessons_for_course(db, course["id"], learner_id)
                course["is_complete"] = course["course_complete"]
                course["next_lesson_id"] = next(
                    (lesson["id"] for lesson in course["lessons"] if lesson["can_complete"]), None
                )
                courses.append(course)
            return courses
        finally:
            if owns_connection:
                db.close()

    @staticmethod
    def progress_percent(completed: int, total: int) -> int:
        return round((completed / total) * 100) if total else 0

    @staticmethod
    def next_lesson_id(db: sqlite3.Connection) -> int:
        """Allocate a lesson ID that is never reused after deletion.

        The original schema used ``INTEGER PRIMARY KEY`` without
        ``AUTOINCREMENT``. SQLite can therefore reuse the highest deleted row
        ID. Explicitly allocating above the current maximum preserves the
        identity of deleted lessons, including for existing databases that
        cannot be rebuilt in place without a risky table migration.
        """
        StudyDatabase.ensure_lesson_id_sequence(db)
        row = db.execute("SELECT next_id FROM lesson_id_sequence LIMIT 1").fetchone()
        lesson_id = int(row[0])
        db.execute("UPDATE lesson_id_sequence SET next_id = ?", (lesson_id + 1,))
        return lesson_id

    def lessons_for_course(self, db: sqlite3.Connection, course_id: int, learner_id: int) -> list[dict[str, Any]]:
        rows = db.execute(
            """
            SELECT l.id, l.course_id, l.title, l.summary, l.content, l.duration_minutes, l.position,
                   lp.completed_at
            FROM lessons l
            LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.learner_id = ?
            WHERE l.course_id = ?
            ORDER BY l.position, l.id
            """,
            (learner_id, course_id),
        ).fetchall()
        lessons = []
        for row in rows:
            lesson = dict(row)
            lesson["completed"] = bool(lesson.pop("completed_at"))
            lesson["prerequisite_ids"] = []
            lesson["prerequisite_positions"] = []
            lesson["blocked_by"] = []
            lessons.append(lesson)
        by_id = {lesson["id"]: lesson for lesson in lessons}
        prerequisites = db.execute(
            """
            SELECT p.lesson_id, required.id, required.title, required.position, lp.completed_at
            FROM lesson_prerequisites p
            JOIN lessons l ON l.id = p.lesson_id
            JOIN lessons required ON required.id = p.prerequisite_lesson_id
            LEFT JOIN lesson_progress lp ON lp.lesson_id = required.id AND lp.learner_id = ?
            WHERE l.course_id = ?
            ORDER BY required.position, required.id
            """,
            (learner_id, course_id),
        ).fetchall()
        for prerequisite in prerequisites:
            lesson = by_id[prerequisite["lesson_id"]]
            lesson["prerequisite_ids"].append(prerequisite["id"])
            lesson["prerequisite_positions"].append(prerequisite["position"])
            if prerequisite["completed_at"] is None:
                lesson["blocked_by"].append({
                    "id": prerequisite["id"],
                    "title": prerequisite["title"],
                    "position": prerequisite["position"],
                })
        enrolled = db.execute(
            "SELECT 1 FROM enrollments WHERE learner_id = ? AND course_id = ?",
            (learner_id, course_id),
        ).fetchone() is not None
        for lesson in lessons:
            # This is an available new action; repeated completion is still idempotent.
            lesson["can_complete"] = enrolled and not lesson["completed"] and not lesson["blocked_by"]
        return lessons

    def list_groups(self, db: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        owns_connection = db is None
        db = db or self.connect()
        try:
            learner_id = self.learner(db)["id"]
            rows = db.execute(
                """
                SELECT g.id, g.name, g.description, g.color, g.created_at,
                       COUNT(DISTINCT gm.id) AS member_count,
                       EXISTS (SELECT 1 FROM group_members mine WHERE mine.group_id = g.id AND mine.learner_id = ?) AS joined,
                       COUNT(DISTINCT p.id) AS post_count,
                       MAX(p.created_at) AS latest_post_at
                FROM study_groups g
                LEFT JOIN group_members gm ON gm.group_id = g.id
                LEFT JOIN group_posts p ON p.group_id = g.id
                GROUP BY g.id
                ORDER BY g.created_at, g.id
                """,
                (learner_id,),
            ).fetchall()
            groups = []
            for row in rows:
                group = dict(row)
                group["joined"] = bool(group["joined"])
                groups.append(group)
            return groups
        finally:
            if owns_connection:
                db.close()

    @staticmethod
    def validate_post_body(payload: Any) -> str:
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object")
        body = clean_text(payload.get("body"), "Post body", 4000)
        if not any(not unicodedata.category(character).startswith("C") for character in body):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Post body must contain readable text")
        return body

    @staticmethod
    def require_group_member(db: sqlite3.Connection, group_id: int, learner_id: int) -> None:
        if db.execute("SELECT 1 FROM study_groups WHERE id = ?", (group_id,)).fetchone() is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Study group not found")
        if db.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND learner_id = ?",
            (group_id, learner_id),
        ).fetchone() is None:
            raise ApiError(HTTPStatus.CONFLICT, "Join this study group before posting in its discussion")

    @staticmethod
    def serialize_post(row: sqlite3.Row, learner_id: int) -> dict[str, Any]:
        post = dict(row)
        post["can_edit"] = post["learner_id"] == learner_id
        post["can_delete"] = post["learner_id"] == learner_id
        return post

    def list_group_posts(self, group_id: int) -> dict[str, Any]:
        with self.connect() as db:
            learner = self.learner(db)
            group_row = db.execute(
                "SELECT id, name, description, color, created_at FROM study_groups WHERE id = ?",
                (group_id,),
            ).fetchone()
            if group_row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Study group not found")
            rows = db.execute(
                """
                SELECT p.id, p.group_id, p.learner_id, l.name AS author_name, l.role AS author_role,
                       p.body, p.created_at, p.updated_at
                FROM group_posts p
                JOIN study_groups g ON g.id = p.group_id
                JOIN learners l ON l.id = p.learner_id
                WHERE p.group_id = ?
                ORDER BY p.created_at DESC, p.id DESC
                """,
                (group_id,),
            ).fetchall()
            return {
                "group": dict(group_row),
                "posts": [self.serialize_post(row, learner["id"]) for row in rows],
            }

    def create_group_post(self, group_id: int, payload: Any) -> dict[str, Any]:
        body = self.validate_post_body(payload)
        now = self.now()
        with self.connect() as db:
            learner_id = self.learner(db)["id"]
            self.require_group_member(db, group_id, learner_id)
            cursor = db.execute(
                """
                INSERT INTO group_posts (group_id, learner_id, body, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (group_id, learner_id, body, now, now),
            )
            row = db.execute(
                """
                SELECT p.id, p.group_id, p.learner_id, l.name AS author_name, l.role AS author_role,
                       p.body, p.created_at, p.updated_at
                FROM group_posts p JOIN learners l ON l.id = p.learner_id
                WHERE p.id = ?
                """,
                (cursor.lastrowid,),
            ).fetchone()
            return self.serialize_post(row, learner_id)

    def update_group_post(self, group_id: int, post_id: int, payload: Any) -> dict[str, Any]:
        body = self.validate_post_body(payload)
        with self.connect() as db:
            learner_id = self.learner(db)["id"]
            self.require_group_member(db, group_id, learner_id)
            row = db.execute(
                "SELECT learner_id FROM group_posts WHERE id = ? AND group_id = ?",
                (post_id, group_id),
            ).fetchone()
            if row is None:
                wrong_group = db.execute("SELECT 1 FROM group_posts WHERE id = ?", (post_id,)).fetchone()
                if wrong_group is not None:
                    raise ApiError(HTTPStatus.FORBIDDEN, "This post does not belong to the requested group")
                raise ApiError(HTTPStatus.NOT_FOUND, "Post not found")
            if row["learner_id"] != learner_id:
                raise ApiError(HTTPStatus.FORBIDDEN, "Only the post author can edit this post")
            db.execute(
                "UPDATE group_posts SET body = ?, updated_at = ? WHERE id = ?",
                (body, self.now(), post_id),
            )
            updated = db.execute(
                """
                SELECT p.id, p.group_id, p.learner_id, l.name AS author_name, l.role AS author_role,
                       p.body, p.created_at, p.updated_at
                FROM group_posts p JOIN learners l ON l.id = p.learner_id
                WHERE p.id = ?
                """,
                (post_id,),
            ).fetchone()
            return self.serialize_post(updated, learner_id)

    def delete_group_post(self, group_id: int, post_id: int) -> None:
        with self.connect() as db:
            learner_id = self.learner(db)["id"]
            self.require_group_member(db, group_id, learner_id)
            row = db.execute(
                "SELECT learner_id FROM group_posts WHERE id = ? AND group_id = ?",
                (post_id, group_id),
            ).fetchone()
            if row is None:
                wrong_group = db.execute("SELECT 1 FROM group_posts WHERE id = ?", (post_id,)).fetchone()
                if wrong_group is not None:
                    raise ApiError(HTTPStatus.FORBIDDEN, "This post does not belong to the requested group")
                raise ApiError(HTTPStatus.NOT_FOUND, "Post not found")
            if row["learner_id"] != learner_id:
                raise ApiError(HTTPStatus.FORBIDDEN, "Only the post author can delete this post")
            db.execute("DELETE FROM group_posts WHERE id = ?", (post_id,))

    def list_sessions(self, db: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        owns_connection = db is None
        db = db or self.connect()
        try:
            rows = db.execute(
                """
                SELECT s.*, g.name AS group_name, g.color AS group_color,
                       c.title AS course_title
                FROM sessions s
                JOIN study_groups g ON g.id = s.group_id
                LEFT JOIN courses c ON c.id = s.course_id
                WHERE s.status = 'scheduled'
                ORDER BY s.start_utc, s.id
                """
            ).fetchall()
            return [self.serialize_session(row) for row in rows]
        finally:
            if owns_connection:
                db.close()

    @staticmethod
    def serialize_session(row: sqlite3.Row) -> dict[str, Any]:
        session = dict(row)
        session["time_zone"] = session["timezone"]
        session["cancelled_reason"] = session["cancellation_reason"]
        return session

    def session_by_id(self, db: sqlite3.Connection, session_id: int) -> dict[str, Any]:
        """Read a session including cancelled records, for idempotent actions."""
        row = db.execute(
            """
            SELECT s.*, g.name AS group_name, g.color AS group_color,
                   c.title AS course_title
            FROM sessions s
            JOIN study_groups g ON g.id = s.group_id
            LEFT JOIN courses c ON c.id = s.course_id
            WHERE s.id = ?
            """,
            (session_id,),
        ).fetchone()
        if row is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Session not found")
        return self.serialize_session(row)

    def dashboard(self) -> dict[str, Any]:
        with self.connect() as db:
            learner = self.learner(db)
            courses = self.list_courses(db)
            groups = self.list_groups(db)
            sessions = self.list_sessions(db)
            progress_summary = self.progress_summary(db)
            current = self.current_time()
            summary = progress_summary["summary"]
            return {
                "learner": learner,
                "courses": courses,
                "groups": groups,
                "sessions": sessions,
                "progress_summary": progress_summary,
                "stats": {
                    "enrolled_courses": summary["enrolled_courses"],
                    "completed_lessons": summary["lessons_completed"],
                    "upcoming_sessions": summary["upcoming_sessions"],
                    "overall_progress": summary["overall_progress_percent"],
                },
                "today": current.date().isoformat(),
                "now_utc": current.isoformat(timespec="seconds"),
            }

    def all_sessions(self, db: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        owns_connection = db is None
        db = db or self.connect()
        try:
            rows = db.execute(
                """
                SELECT s.*, g.name AS group_name, g.color AS group_color,
                       c.title AS course_title
                FROM sessions s
                JOIN study_groups g ON g.id = s.group_id
                LEFT JOIN courses c ON c.id = s.course_id
                ORDER BY s.start_utc, s.id
                """
            ).fetchall()
            return [self.serialize_session(row) for row in rows]
        finally:
            if owns_connection:
                db.close()

    def all_group_posts(self, db: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
        owns_connection = db is None
        db = db or self.connect()
        try:
            rows = db.execute(
                """
                SELECT p.id, p.group_id, p.learner_id, g.name AS group_name,
                       l.name AS author_name, l.role AS author_role,
                       p.body, p.created_at, p.updated_at
                FROM group_posts p
                JOIN study_groups g ON g.id = p.group_id
                JOIN learners l ON l.id = p.learner_id
                ORDER BY p.created_at, p.id
                """
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            if owns_connection:
                db.close()

    def export_snapshot(self, scope: str) -> dict[str, Any]:
        with self.connect() as db:
            learner = self.learner(db)
            courses = self.list_courses(db)
            groups = self.list_groups(db)
            posts = self.all_group_posts(db)
            sessions = self.all_sessions(db)
            progress = self.progress_summary(db)
        grouped_posts: dict[int, list[dict[str, Any]]] = {}
        for post in posts:
            grouped_posts.setdefault(post["group_id"], []).append(post)
        groups_export = []
        for group in groups:
            groups_export.append({
                **group,
                "posts": grouped_posts.get(group["id"], []),
            })
        if scope == "workspace":
            return {
                "learner": learner,
                "courses": courses,
                "groups": groups_export,
                "sessions": sessions,
                "progress_summary": progress,
            }
        if scope == "progress":
            return {"learner": learner, "courses": courses, "progress_summary": progress}
        if scope == "sessions":
            return {"learner": learner, "sessions": sessions}
        if scope == "groups":
            return {"learner": learner, "groups": groups_export}
        raise ApiError(HTTPStatus.BAD_REQUEST, "Unsupported export scope")

    @staticmethod
    def _csv_row(record_type: str, **values: Any) -> dict[str, Any]:
        row = {column: "" for column in CSV_EXPORT_COLUMNS}
        row["record_type"] = record_type
        for key, value in values.items():
            if key in row:
                row[key] = value
        return row

    def export_csv_rows(self, scope: str) -> list[dict[str, Any]]:
        snapshot = self.export_snapshot(scope)
        rows: list[dict[str, Any]] = []
        learner = snapshot["learner"]
        rows.append(self._csv_row(
            "learner", id=learner["id"], name=learner["name"], role=learner["role"]
        ))
        if "courses" in snapshot:
            for course in snapshot["courses"]:
                rows.append(self._csv_row(
                    "course", id=course["id"], title=course["title"], body=course["description"],
                    enrolled=course["enrolled"], lesson_count=course["lesson_count"],
                    completed_count=course["completed_count"], progress_percent=course["progress_percent"],
                    course_complete=course["course_complete"], next_lesson_id=course["next_lesson_id"],
                ))
                for lesson in course["lessons"]:
                    rows.append(self._csv_row(
                        "lesson", id=lesson["id"], parent_id=course["id"], course_id=course["id"],
                        lesson_id=lesson["id"], title=lesson["title"], body=lesson["content"],
                        completed=lesson["completed"], completed_at=lesson.get("completed_at", ""),
                    ))
                    for prerequisite_id in lesson["prerequisite_ids"]:
                        rows.append(self._csv_row(
                            "prerequisite", parent_id=lesson["id"], lesson_id=lesson["id"],
                            prerequisite_lesson_id=prerequisite_id,
                        ))
        if "groups" in snapshot:
            for group in snapshot["groups"]:
                rows.append(self._csv_row(
                    "group", id=group["id"], name=group["name"], body=group["description"],
                    member_count=group["member_count"], post_count=group["post_count"],
                ))
                for post in group["posts"]:
                    rows.append(self._csv_row(
                        "group_post", id=post["id"], parent_id=group["id"], group_id=group["id"],
                        author_name=post["author_name"], author_role=post["author_role"],
                        body=post["body"], created_at=post["created_at"], updated_at=post["updated_at"],
                    ))
        if "sessions" in snapshot:
            for session in snapshot["sessions"]:
                rows.append(self._csv_row(
                    "session", id=session["id"], group_id=session["group_id"], course_id=session["course_id"],
                    title=session["title"], body=session["notes"], session_date=session["session_date"],
                    start_time=session["start_time"], timezone=session["timezone"],
                    duration_minutes=session["duration_minutes"], status=session["status"],
                    cancellation_reason=session["cancellation_reason"], created_at=session["created_at"],
                ))
        if "progress_summary" in snapshot:
            progress = snapshot["progress_summary"]
            rows.append(self._csv_row(
                "progress_summary", enrolled_course_count=progress["enrolled_course_count"],
                total_lessons=progress["total_lessons"], completed_lessons=progress["completed_lessons"],
                progress_percent=progress["overall_percent"],
            ))
            for completed in progress["recent_completed_lessons"]:
                rows.append(self._csv_row(
                    "completed_lesson", id=completed["lesson_id"], course_id=completed["course_id"],
                    title=completed["title"], course_title=completed["course_title"],
                    completed_at=completed["completed_at"],
                ))
        return rows

    def export_data(self, output_format: str = "json", scope: str = "workspace") -> bytes:
        if output_format not in {"json", "csv"}:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Unsupported export format")
        if scope not in {"workspace", "progress", "sessions", "groups"}:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Unsupported export scope")
        if output_format == "json":
            return json.dumps(
                self.export_snapshot(scope), ensure_ascii=False, sort_keys=True, indent=2
            ).encode("utf-8")
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=CSV_EXPORT_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(self.export_csv_rows(scope))
        return output.getvalue().encode("utf-8")

    def backup_bytes(self) -> bytes:
        """Copy the live database through SQLite's backup API, without writing it."""
        with self.connect() as source, sqlite3.connect(":memory:") as destination:
            source.backup(destination)
            return destination.serialize()

    def _stage_valid_restore(self, raw: bytes) -> str:
        """Write and validate a candidate database without touching the live file."""
        if len(raw) > MAX_BACKUP_PAYLOAD_BYTES:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Backup body is too large")
        temporary_name: str | None = None
        candidate: sqlite3.Connection | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb", dir=self.path.parent, prefix=f".{self.path.name}.restore-", delete=False
            ) as temporary:
                temporary_name = temporary.name
                temporary.write(raw)
                temporary.flush()
                os.fsync(temporary.fileno())
            candidate = sqlite3.connect(temporary_name)
            candidate.row_factory = sqlite3.Row
            candidate.execute("PRAGMA foreign_keys = ON")
            required = {
                "learners", "courses", "lessons", "lesson_progress", "enrollments",
                "study_groups", "group_members", "sessions", "lesson_prerequisites",
            }
            tables = {
                row["name"] for row in candidate.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            if not required <= tables:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Backup is missing required workspace tables")
            if candidate.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ApiError(HTTPStatus.BAD_REQUEST, "Backup failed SQLite integrity validation")
            # Migrations operate only on the candidate and make current backups portable.
            self.migrate_sessions(candidate)
            self.migrate_enrollments(candidate)
            self.migrate_group_posts(candidate)
            self.cleanup_orphan_lesson_rows(candidate)
            tables = {
                row["name"] for row in candidate.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            if "group_posts" not in tables:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Backup is missing the group_posts table")
            if candidate.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ApiError(HTTPStatus.BAD_REQUEST, "Backup failed SQLite integrity validation")
            if candidate.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Backup contains foreign-key violations")
            learner_count = candidate.execute("SELECT COUNT(*) FROM learners").fetchone()[0]
            if learner_count < 1:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Backup must contain a local learner")
            sanity_queries = (
                "SELECT COUNT(*) FROM learners WHERE id <= 0 OR trim(name) = ''",
                "SELECT COUNT(*) FROM courses WHERE id <= 0 OR trim(title) = ''",
                "SELECT COUNT(*) FROM lessons WHERE id <= 0 OR trim(title) = '' OR duration_minutes <= 0",
                "SELECT COUNT(*) FROM group_posts WHERE id <= 0 OR trim(body) = '' OR length(body) > 4000",
            )
            if any(candidate.execute(query).fetchone()[0] for query in sanity_queries):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Backup contains invalid workspace rows")
            candidate.commit()
            candidate.close()
            candidate = None
            return temporary_name
        except ApiError:
            raise
        except (sqlite3.DatabaseError, OSError, ValueError) as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Backup is not a valid SQLite workspace") from exc
        finally:
            if candidate is not None:
                candidate.close()
            if temporary_name is not None:
                # A successful validation hands ownership of the temporary file
                # to restore_bytes; failed validation removes it here.
                if candidate is not None:
                    try:
                        os.unlink(temporary_name)
                    except FileNotFoundError:
                        pass

    def validate_restore_bytes(self, raw: bytes) -> None:
        """Validate an uploaded SQLite backup without replacing the workspace."""
        temporary_name = self._stage_valid_restore(raw)
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass

    def restore_bytes(self, raw: bytes) -> None:
        """Validate an uploaded database in a sibling temp file before replacement."""
        temporary_name = self._stage_valid_restore(raw)
        try:
            os.replace(temporary_name, self.path)
        except OSError as exc:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
            raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "The workspace backup could not be restored") from exc

    def progress_summary(self, db: sqlite3.Connection | None = None) -> dict[str, Any]:
        owns_connection = db is None
        db = db or self.connect()
        try:
            learner = self.learner(db)
            learner_id = learner["id"]
            rows = db.execute(
                """
                SELECT c.id, c.title,
                       EXISTS (
                           SELECT 1 FROM enrollments e
                           WHERE e.learner_id = ? AND e.course_id = c.id
                       ) AS enrolled,
                       COUNT(l.id) AS lesson_count,
                       COUNT(lp.id) AS completed_count,
                       MAX(lp.completed_at) AS completed_at
                FROM courses c
                LEFT JOIN lessons l ON l.course_id = c.id
                LEFT JOIN lesson_progress lp
                    ON lp.lesson_id = l.id AND lp.learner_id = ?
                GROUP BY c.id
                ORDER BY c.created_at, c.id
                """,
                (learner_id, learner_id),
            ).fetchall()
            courses = []
            for row in rows:
                course = dict(row)
                course["enrolled"] = bool(course["enrolled"])
                course["progress_percent"] = self.progress_percent(
                    course["completed_count"], course["lesson_count"]
                )
                course["completion_rule"] = "all_lessons"
                course["course_complete"] = bool(
                    course["enrolled"]
                    and course["lesson_count"] > 0
                    and course["completed_count"] == course["lesson_count"]
                )
                course["remaining_count"] = max(
                    course["lesson_count"] - course["completed_count"], 0
                )
                next_row = db.execute(
                    """
                    SELECT l.id, l.title
                    FROM lessons l
                    JOIN enrollments e ON e.course_id = l.course_id AND e.learner_id = ?
                    WHERE l.course_id = ?
                      AND NOT EXISTS (
                          SELECT 1 FROM lesson_progress lp
                          WHERE lp.lesson_id = l.id AND lp.learner_id = ?
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM lesson_prerequisites p
                          WHERE p.lesson_id = l.id
                            AND NOT EXISTS (
                                SELECT 1 FROM lesson_progress required_progress
                                WHERE required_progress.lesson_id = p.prerequisite_lesson_id
                                  AND required_progress.learner_id = ?
                            )
                      )
                    ORDER BY l.position, l.id
                    LIMIT 1
                    """,
                    (learner_id, course["id"], learner_id, learner_id),
                ).fetchone()
                course["next_lesson_id"] = next_row["id"] if next_row else None
                course["next_lesson"] = dict(next_row) if next_row else None
                courses.append(course)

            enrolled_courses = [course for course in courses if course["enrolled"]]
            lessons_completed = sum(course["completed_count"] for course in enrolled_courses)
            lessons_total = sum(course["lesson_count"] for course in enrolled_courses)
            current = self.current_time()
            upcoming_sessions = db.execute(
                """
                SELECT COUNT(*) AS count FROM sessions
                WHERE status = 'scheduled' AND start_utc >= ?
                """,
                (current.isoformat(timespec="seconds"),),
            ).fetchone()["count"]
            active_groups = db.execute(
                """
                SELECT COUNT(*) AS count FROM group_members
                WHERE learner_id = ?
                """,
                (learner_id,),
            ).fetchone()["count"]
            completed_courses = sum(course["course_complete"] for course in enrolled_courses)
            recent_completed_lessons = [
                dict(row) for row in db.execute(
                    """
                    SELECT lp.lesson_id, lp.completed_at, l.title, l.course_id, c.title AS course_title
                    FROM lesson_progress lp
                    JOIN lessons l ON l.id = lp.lesson_id
                    JOIN courses c ON c.id = l.course_id
                    WHERE lp.learner_id = ?
                    ORDER BY lp.completed_at DESC, lp.id DESC
                    LIMIT 5
                    """,
                    (learner_id,),
                ).fetchall()
            ]
            return {
                "learner": learner,
                "summary": {
                    "enrolled_courses": len(enrolled_courses),
                    "completed_courses": completed_courses,
                    "lessons_completed": lessons_completed,
                    "lessons_total": lessons_total,
                    "overall_progress_percent": self.progress_percent(lessons_completed, lessons_total),
                    "upcoming_sessions": upcoming_sessions,
                    "active_groups": active_groups,
                },
                "courses": courses,
                "recent_completed_lessons": recent_completed_lessons,
            }
        finally:
            if owns_connection:
                db.close()

    @staticmethod
    def _rows(db: sqlite3.Connection, table: str, columns: str) -> list[dict[str, Any]]:
        return [dict(row) for row in db.execute(f"SELECT {columns} FROM {table} ORDER BY id")]

    def export_workspace(self) -> dict[str, Any]:
        with self.connect() as db:
            learner_rows = self._rows(db, "learners", "id, name, role, created_at")
            return {
                "version": BACKUP_VERSION,
                "schema": BACKUP_SCHEMA,
                "exported_at": self.now(),
                "learner": learner_rows[0] if learner_rows else None,
                "courses": self._rows(
                    db, "courses",
                    "id, title, description, category, level, accent, created_at, updated_at",
                ),
                "lessons": self._rows(
                    db, "lessons",
                    "id, course_id, title, summary, content, duration_minutes, position, created_at",
                ),
                "progress": self._rows(
                    db, "lesson_progress", "id, learner_id, lesson_id, completed_at"
                ),
                "prerequisites": [
                    dict(row) for row in db.execute(
                        "SELECT lesson_id, prerequisite_lesson_id "
                        "FROM lesson_prerequisites ORDER BY lesson_id, prerequisite_lesson_id"
                    )
                ],
                "enrollments": self._rows(
                    db, "enrollments", "id, learner_id, course_id, enrolled_at"
                ),
                "groups": self._rows(
                    db, "study_groups", "id, name, description, color, created_at"
                ),
                "members": self._rows(
                    db, "group_members", "id, group_id, learner_id, joined_at"
                ),
                "posts": [
                    dict(row) for row in db.execute(
                        "SELECT id, group_id, learner_id, body, created_at, updated_at "
                        "FROM group_posts ORDER BY id"
                    )
                ],
                "sessions": [
                    dict(row) for row in db.execute(
                        "SELECT id, group_id, course_id, title, session_date, start_time, "
                        "timezone, duration_minutes, notes, status, cancelled_at, "
                        "cancellation_reason, time_zone, start_utc, end_utc, "
                        "cancelled_reason, created_at FROM sessions ORDER BY id"
                    )
                ],
                "progress_summary": self.progress_summary(db),
            }

    def export_csv(self) -> str:
        exported = self.export_workspace()
        columns = [
            "record_type", "course_id", "lesson_id", "group_id", "session_id", "title",
            "body", "status", "time_zone", "session_date", "start_time", "completed",
            "created_at", "updated_at",
        ]
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()

        def write(record_type: str, values: dict[str, Any]) -> None:
            row = {column: "" for column in columns}
            row["record_type"] = record_type
            for key, value in values.items():
                if key in row and value is not None:
                    row[key] = value
            writer.writerow(row)

        for course in exported["courses"]:
            write("course", {"course_id": course["id"], "title": course["title"],
                              "created_at": course["created_at"], "updated_at": course["updated_at"]})
        for lesson in exported["lessons"]:
            write("lesson", {"course_id": lesson["course_id"], "lesson_id": lesson["id"],
                              "title": lesson["title"], "body": lesson["content"],
                              "created_at": lesson["created_at"]})
        progress_by_lesson = {
            item["lesson_id"]: item for item in exported["progress"]
        }
        for lesson in exported["lessons"]:
            progress = progress_by_lesson.get(lesson["id"])
            if progress:
                write("progress", {"course_id": lesson["course_id"], "lesson_id": lesson["id"],
                                    "completed": True, "created_at": progress["completed_at"]})
        for group in exported["groups"]:
            write("group", {"group_id": group["id"], "title": group["name"],
                             "body": group["description"], "created_at": group["created_at"]})
        for post in exported["posts"]:
            write("post", {"group_id": post["group_id"], "body": post["body"],
                            "created_at": post["created_at"], "updated_at": post["updated_at"]})
        for session in exported["sessions"]:
            write("session", {"group_id": session["group_id"], "course_id": session["course_id"],
                               "session_id": session["id"], "title": session["title"],
                               "body": session["notes"], "status": session["status"],
                               "time_zone": session["timezone"], "session_date": session["session_date"],
                               "start_time": session["start_time"], "created_at": session["created_at"]})
        return output.getvalue()

    @staticmethod
    def _backup_error(message: str, field: str | None = None) -> None:
        raise ApiError(
            HTTPStatus.BAD_REQUEST,
            message,
            {"field": field} if field is not None else {},
        )

    @classmethod
    def validate_backup(cls, payload: Any) -> dict[str, Any]:
        """Validate and normalize a complete export without touching SQLite."""
        if not isinstance(payload, dict):
            cls._backup_error("Backup must be a JSON object")
        if payload.get("version") != BACKUP_VERSION:
            cls._backup_error("Unsupported backup version", "version")
        if payload.get("schema", BACKUP_SCHEMA) != BACKUP_SCHEMA:
            cls._backup_error("Unsupported backup schema", "schema")

        def array(name: str) -> list[dict[str, Any]]:
            value = payload.get(name, [])
            if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
                cls._backup_error(f"{name} must be a list of objects", name)
            return value

        def required_text(value: Any, field: str, maximum: int) -> str:
            if not isinstance(value, str):
                cls._backup_error(f"{field} must be text", field)
            value = value.strip()
            if not value:
                cls._backup_error(f"{field} is required", field)
            if len(value) > maximum:
                cls._backup_error(f"{field} must be {maximum} characters or fewer", field)
            return value

        def optional_text(value: Any, field: str, maximum: int) -> str:
            if value is None:
                return ""
            if not isinstance(value, str):
                cls._backup_error(f"{field} must be text", field)
            value = value.strip()
            if len(value) > maximum:
                cls._backup_error(f"{field} must be {maximum} characters or fewer", field)
            return value

        def timestamp(value: Any, field: str, nullable: bool = False) -> str | None:
            if value is None and nullable:
                return None
            if not isinstance(value, str):
                cls._backup_error(f"{field} must be an ISO timestamp", field)
            try:
                parsed = datetime.fromisoformat(value)
            except ValueError as exc:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be an ISO timestamp", {"field": field}) from exc
            if parsed.utcoffset() is None:
                cls._backup_error(f"{field} must include a timezone", field)
            return value

        def record_id(value: Any, field: str) -> int:
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                cls._backup_error(f"{field} must be a positive integer", field)
            return value

        def unique_ids(records: list[dict[str, Any]], name: str) -> dict[int, dict[str, Any]]:
            result: dict[int, dict[str, Any]] = {}
            if len(records) > 10000:
                cls._backup_error(f"{name} contains too many records", name)
            for record in records:
                identifier = record_id(record.get("id"), f"{name}.id")
                if identifier in result:
                    cls._backup_error(f"Duplicate {name} id", f"{name}.id")
                result[identifier] = record
            return result

        learner_value = payload.get("learner")
        learners_value = payload.get("learners")
        if learners_value is not None:
            if not isinstance(learners_value, list) or len(learners_value) != 1 or not isinstance(learners_value[0], dict):
                cls._backup_error("Backup must contain exactly one learner", "learner")
            if learner_value is not None and learner_value != learners_value[0]:
                cls._backup_error("learner and learners representations must agree", "learner")
            learner_value = learners_value[0]
        if not isinstance(learner_value, dict):
            cls._backup_error("Backup must contain exactly one learner", "learner")
        learner = {
            "id": record_id(learner_value.get("id"), "learner.id"),
            "name": required_text(learner_value.get("name"), "learner.name", 120),
            "role": required_text(learner_value.get("role"), "learner.role", 60),
            "created_at": timestamp(learner_value.get("created_at"), "learner.created_at"),
        }

        courses_raw = array("courses")
        courses_by_id = unique_ids(courses_raw, "courses")
        courses = []
        for raw in courses_raw:
            courses.append({
                "id": record_id(raw["id"], "courses.id"),
                "title": required_text(raw.get("title"), "course.title", 120),
                "description": optional_text(raw.get("description", ""), "course.description", 1000),
                "category": required_text(raw.get("category", "General"), "course.category", 60),
                "level": required_text(raw.get("level", "Mixed"), "course.level", 40),
                "accent": hex_color(raw.get("accent", "#7c5cff"), "Course accent", "#7c5cff"),
                "created_at": timestamp(raw.get("created_at"), "course.created_at"),
                "updated_at": timestamp(raw.get("updated_at"), "course.updated_at"),
            })

        lessons_raw = array("lessons")
        lessons_by_id = unique_ids(lessons_raw, "lessons")
        lessons = []
        positions_by_course: dict[int, set[int]] = {}
        for raw in lessons_raw:
            lesson_course = record_id(raw.get("course_id"), "lesson.course_id")
            if lesson_course not in courses_by_id:
                cls._backup_error("Lesson references a missing course", "lesson.course_id")
            position = positive_int(raw.get("position"), "Lesson position")
            if position in positions_by_course.setdefault(lesson_course, set()):
                cls._backup_error("Lesson positions must be unique within a course", "lesson.position")
            positions_by_course[lesson_course].add(position)
            lessons.append({
                "id": record_id(raw["id"], "lessons.id"),
                "course_id": lesson_course,
                "title": required_text(raw.get("title"), "lesson.title", 120),
                "summary": optional_text(raw.get("summary", ""), "lesson.summary", 500),
                "content": optional_text(raw.get("content", ""), "lesson.content", 4000),
                "duration_minutes": positive_int(raw.get("duration_minutes", 30), "Lesson duration", 5, 240),
                "position": position,
                "created_at": timestamp(raw.get("created_at"), "lesson.created_at"),
            })

        lesson_course_by_id = {lesson["id"]: lesson["course_id"] for lesson in lessons}
        prerequisites_raw = array("prerequisites")
        prerequisites: list[dict[str, int]] = []
        prerequisite_pairs: set[tuple[int, int]] = set()
        graph: dict[int, list[int]] = {lesson_id: [] for lesson_id in lesson_course_by_id}
        for raw in prerequisites_raw:
            lesson_id = record_id(raw.get("lesson_id"), "prerequisite.lesson_id")
            required_id = record_id(raw.get("prerequisite_lesson_id"), "prerequisite.prerequisite_lesson_id")
            pair = (lesson_id, required_id)
            if lesson_id not in lesson_course_by_id or required_id not in lesson_course_by_id:
                cls._backup_error("Prerequisite references a missing lesson", "prerequisites")
            if lesson_id == required_id:
                cls._backup_error("A lesson cannot require itself as a prerequisite", "prerequisites")
            if lesson_course_by_id[lesson_id] != lesson_course_by_id[required_id]:
                cls._backup_error("Prerequisites must stay within a course", "prerequisites")
            if pair in prerequisite_pairs:
                cls._backup_error("Duplicate prerequisite edge", "prerequisites")
            prerequisite_pairs.add(pair)
            graph[lesson_id].append(required_id)
            prerequisites.append({"lesson_id": lesson_id, "prerequisite_lesson_id": required_id})

        visiting: set[int] = set()
        visited: set[int] = set()

        def visit(lesson_id: int) -> None:
            if lesson_id in visiting:
                cls._backup_error("Lesson prerequisites cannot contain a dependency cycle", "prerequisites")
            if lesson_id in visited:
                return
            visiting.add(lesson_id)
            for required_id in graph[lesson_id]:
                visit(required_id)
            visiting.remove(lesson_id)
            visited.add(lesson_id)

        for lesson_id in graph:
            visit(lesson_id)

        def foreign_learner(value: Any, field: str) -> int:
            identifier = record_id(value, field)
            if identifier != learner["id"]:
                cls._backup_error("All records must belong to the backup learner", field)
            return identifier

        enrollments_raw = array("enrollments")
        enrollments = []
        enrollment_pairs: set[tuple[int, int]] = set()
        for raw in enrollments_raw:
            course_id = record_id(raw.get("course_id"), "enrollment.course_id")
            if course_id not in courses_by_id:
                cls._backup_error("Enrollment references a missing course", "enrollment.course_id")
            pair = (learner["id"], course_id)
            if pair in enrollment_pairs:
                cls._backup_error("Duplicate learner/course enrollment", "enrollments")
            enrollment_pairs.add(pair)
            enrollments.append({
                "id": record_id(raw.get("id"), "enrollments.id"),
                "learner_id": foreign_learner(raw.get("learner_id"), "enrollment.learner_id"),
                "course_id": course_id,
                "enrolled_at": timestamp(raw.get("enrolled_at"), "enrollment.enrolled_at"),
            })
        unique_ids(enrollments_raw, "enrollments")

        progress_raw = array("progress")
        progress = []
        progress_pairs: set[tuple[int, int]] = set()
        for raw in progress_raw:
            lesson_id = record_id(raw.get("lesson_id"), "progress.lesson_id")
            if lesson_id not in lessons_by_id:
                cls._backup_error("Progress references a missing lesson", "progress.lesson_id")
            pair = (learner["id"], lesson_id)
            if pair in progress_pairs:
                cls._backup_error("Duplicate lesson progress record", "progress")
            progress_pairs.add(pair)
            progress.append({
                "id": record_id(raw.get("id"), "progress.id"),
                "learner_id": foreign_learner(raw.get("learner_id"), "progress.learner_id"),
                "lesson_id": lesson_id,
                "completed_at": timestamp(raw.get("completed_at"), "progress.completed_at"),
            })
        unique_ids(progress_raw, "progress")

        groups_raw = array("groups")
        groups_by_id = unique_ids(groups_raw, "groups")
        groups = []
        for raw in groups_raw:
            groups.append({
                "id": record_id(raw["id"], "groups.id"),
                "name": required_text(raw.get("name"), "group.name", 100),
                "description": optional_text(raw.get("description", ""), "group.description", 600),
                "color": hex_color(raw.get("color", "#19c3a3"), "Group color", "#19c3a3"),
                "created_at": timestamp(raw.get("created_at"), "group.created_at"),
            })

        members_raw = array("members")
        members = []
        member_pairs: set[tuple[int, int]] = set()
        for raw in members_raw:
            group_id = record_id(raw.get("group_id"), "member.group_id")
            if group_id not in groups_by_id:
                cls._backup_error("Member references a missing group", "member.group_id")
            pair = (group_id, learner["id"])
            if pair in member_pairs:
                cls._backup_error("Duplicate group membership", "members")
            member_pairs.add(pair)
            members.append({
                "id": record_id(raw.get("id"), "members.id"),
                "group_id": group_id,
                "learner_id": foreign_learner(raw.get("learner_id"), "member.learner_id"),
                "joined_at": timestamp(raw.get("joined_at"), "member.joined_at"),
            })
        unique_ids(members_raw, "members")

        posts_raw = array("posts")
        posts = []
        for raw in posts_raw:
            group_id = record_id(raw.get("group_id"), "post.group_id")
            if group_id not in groups_by_id:
                cls._backup_error("Post references a missing group", "post.group_id")
            post_body = required_text(raw.get("body"), "post.body", 2000)
            if not any(not unicodedata.category(character).startswith("C") for character in post_body):
                cls._backup_error("Post body must contain readable text", "post.body")
            posts.append({
                "id": record_id(raw.get("id"), "posts.id"),
                "group_id": group_id,
                "learner_id": foreign_learner(raw.get("learner_id"), "post.learner_id"),
                "body": post_body,
                "created_at": timestamp(raw.get("created_at"), "post.created_at"),
                "updated_at": timestamp(raw.get("updated_at"), "post.updated_at"),
            })
        unique_ids(posts_raw, "posts")

        sessions_raw = array("sessions")
        sessions = []
        for raw in sessions_raw:
            group_id = record_id(raw.get("group_id"), "session.group_id")
            if group_id not in groups_by_id:
                cls._backup_error("Session references a missing group", "session.group_id")
            course_value = raw.get("course_id")
            course_id = None if course_value is None else record_id(course_value, "session.course_id")
            if course_id is not None and course_id not in courses_by_id:
                cls._backup_error("Session references a missing course", "session.course_id")
            title = required_text(raw.get("title"), "session.title", 120)
            session_date = strict_date(raw.get("session_date"), "Session date")
            start_time = strict_time(raw.get("start_time"), "Session start time")
            duration = positive_int(raw.get("duration_minutes", 60), "Session duration", 15, 480)
            if clock_minutes(start_time) + duration > 24 * 60:
                cls._backup_error("A session must end by midnight on its scheduled date", "session.duration_minutes")
            timezone_value = raw.get("timezone", raw.get("time_zone"))
            if not isinstance(timezone_value, str):
                cls._backup_error("Session time zone is required", "session.timezone")
            try:
                ZoneInfo(timezone_value)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Session time zone must be a valid IANA ZoneInfo name", {"field": "session.timezone"}) from exc
            if raw.get("time_zone", timezone_value) != timezone_value:
                cls._backup_error("Session timezone fields must agree", "session.time_zone")
            status = raw.get("status")
            if status not in {"scheduled", "cancelled"}:
                cls._backup_error("Session status must be scheduled or cancelled", "session.status")
            start_utc = timestamp(raw.get("start_utc"), "session.start_utc")
            end_utc = timestamp(raw.get("end_utc"), "session.end_utc")
            start_parsed = datetime.fromisoformat(start_utc)
            end_parsed = datetime.fromisoformat(end_utc)
            if end_parsed <= start_parsed or end_parsed - start_parsed != timedelta(minutes=duration):
                cls._backup_error("Session UTC interval must match its duration", "session.end_utc")
            valid_intervals = {
                session_utc_interval(session_date, start_time, duration, timezone_value, fold)
                for fold in (0, 1)
            }
            if (start_utc, end_utc) not in valid_intervals:
                cls._backup_error("Session UTC fields do not match its local schedule", "session.start_utc")
            cancelled_at = timestamp(raw.get("cancelled_at"), "session.cancelled_at", nullable=True)
            cancellation_reason = raw.get("cancellation_reason")
            cancelled_reason = raw.get("cancelled_reason", cancellation_reason)
            if cancellation_reason is not None:
                cancellation_reason = optional_text(cancellation_reason, "session.cancellation_reason", 500) or None
            if cancelled_reason is not None:
                cancelled_reason = optional_text(cancelled_reason, "session.cancelled_reason", 500) or None
            if cancellation_reason != cancelled_reason:
                cls._backup_error("Session cancellation fields must agree", "session.cancellation_reason")
            if status == "scheduled" and (cancelled_at is not None or cancellation_reason is not None):
                cls._backup_error("Scheduled sessions cannot have cancellation fields", "session.status")
            if status == "cancelled" and cancelled_at is None:
                cls._backup_error("Cancelled sessions require cancelled_at", "session.cancelled_at")
            sessions.append({
                "id": record_id(raw.get("id"), "sessions.id"),
                "group_id": group_id,
                "course_id": course_id,
                "title": title,
                "session_date": session_date,
                "start_time": start_time,
                "timezone": timezone_value,
                "duration_minutes": duration,
                "notes": optional_text(raw.get("notes", ""), "session.notes", 1000),
                "status": status,
                "cancelled_at": cancelled_at,
                "cancellation_reason": cancellation_reason,
                "time_zone": timezone_value,
                "start_utc": start_utc,
                "end_utc": end_utc,
                "cancelled_reason": cancelled_reason,
                "created_at": timestamp(raw.get("created_at"), "session.created_at"),
            })
        unique_ids(sessions_raw, "sessions")

        normalized = {
            "version": BACKUP_VERSION,
            "schema": BACKUP_SCHEMA,
            "exported_at": timestamp(payload.get("exported_at"), "exported_at"),
            "learner": learner,
            "courses": courses,
            "lessons": lessons,
            "progress": progress,
            "prerequisites": prerequisites,
            "enrollments": enrollments,
            "groups": groups,
            "members": members,
            "posts": posts,
            "sessions": sessions,
        }
        return normalized

    @staticmethod
    def backup_counts(backup: dict[str, Any]) -> dict[str, int]:
        return {
            "learners": 1,
            **{key: len(backup[key]) for key in (
                "courses", "lessons", "progress", "prerequisites", "enrollments",
                "groups", "members", "posts", "sessions",
            )},
        }

    def validate_backup_response(self, payload: Any) -> dict[str, Any]:
        backup = self.validate_backup(payload)
        return {"valid": True, "counts": self.backup_counts(backup), "version": backup["version"]}

    def restore_backup(self, payload: Any) -> dict[str, Any]:
        backup = self.validate_backup(payload)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            # Delete in dependency order. Metadata is intentionally retained so
            # restore does not trigger first-run seeding on the next restart.
            for table in (
                "group_posts", "sessions", "lesson_progress", "lesson_prerequisites",
                "group_members", "enrollments", "lessons", "courses", "study_groups", "learners",
            ):
                db.execute(f"DELETE FROM {table}")
            learner = backup["learner"]
            db.execute(
                "INSERT INTO learners (id, name, role, created_at) VALUES (?, ?, ?, ?)",
                (learner["id"], learner["name"], learner["role"], learner["created_at"]),
            )
            db.executemany(
                "INSERT INTO courses (id, title, description, category, level, accent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [tuple(course[field] for field in (
                    "id", "title", "description", "category", "level", "accent", "created_at", "updated_at"
                )) for course in backup["courses"]],
            )
            db.executemany(
                "INSERT INTO lessons (id, course_id, title, summary, content, duration_minutes, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [tuple(lesson[field] for field in (
                    "id", "course_id", "title", "summary", "content", "duration_minutes", "position", "created_at"
                )) for lesson in backup["lessons"]],
            )
            db.executemany(
                "INSERT INTO lesson_prerequisites (lesson_id, prerequisite_lesson_id) VALUES (?, ?)",
                [(item["lesson_id"], item["prerequisite_lesson_id"]) for item in backup["prerequisites"]],
            )
            db.executemany(
                "INSERT INTO enrollments (id, learner_id, course_id, enrolled_at) VALUES (?, ?, ?, ?)",
                [tuple(item[field] for field in ("id", "learner_id", "course_id", "enrolled_at")) for item in backup["enrollments"]],
            )
            db.executemany(
                "INSERT INTO lesson_progress (id, learner_id, lesson_id, completed_at) VALUES (?, ?, ?, ?)",
                [tuple(item[field] for field in ("id", "learner_id", "lesson_id", "completed_at")) for item in backup["progress"]],
            )
            db.executemany(
                "INSERT INTO study_groups (id, name, description, color, created_at) VALUES (?, ?, ?, ?, ?)",
                [tuple(group[field] for field in ("id", "name", "description", "color", "created_at")) for group in backup["groups"]],
            )
            db.executemany(
                "INSERT INTO group_members (id, group_id, learner_id, joined_at) VALUES (?, ?, ?, ?)",
                [tuple(item[field] for field in ("id", "group_id", "learner_id", "joined_at")) for item in backup["members"]],
            )
            db.executemany(
                "INSERT INTO group_posts (id, group_id, learner_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                [tuple(item[field] for field in ("id", "group_id", "learner_id", "body", "created_at", "updated_at")) for item in backup["posts"]],
            )
            db.executemany(
                """
                INSERT INTO sessions
                    (id, group_id, course_id, title, session_date, start_time, timezone,
                     duration_minutes, notes, status, cancelled_at, cancellation_reason,
                     time_zone, start_utc, end_utc, cancelled_reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [tuple(session[field] for field in (
                    "id", "group_id", "course_id", "title", "session_date", "start_time", "timezone",
                    "duration_minutes", "notes", "status", "cancelled_at", "cancellation_reason",
                    "time_zone", "start_utc", "end_utc", "cancelled_reason", "created_at"
                 )) for session in backup["sessions"]],
            )
            self.ensure_lesson_id_sequence(db)
        return {"restored": True, "counts": self.backup_counts(backup), "version": backup["version"]}

    @staticmethod
    def validate_course_payload(
        payload: dict[str, Any], allow_lesson_ids: bool = False
    ) -> tuple[dict[str, str], list[dict[str, Any]]]:
        """Validate all course fields before a course or lesson is written."""
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object")
        title = clean_text(payload.get("title"), "Course title", 120)
        description = clean_text(payload.get("description", ""), "Description", 1000, required=False)
        category = clean_text(payload.get("category", "General"), "Category", 60, required=False) or "General"
        level = clean_text(payload.get("level", "Mixed"), "Level", 40, required=False) or "Mixed"
        accent = hex_color(payload.get("accent", "#7c5cff"), "Accent", "#7c5cff")
        raw_lessons = payload.get("lessons", [])
        if not isinstance(raw_lessons, list):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Lessons must be a list")
        if len(raw_lessons) > 20:
            raise ApiError(HTTPStatus.BAD_REQUEST, "A course can have at most 20 lessons")
        lessons: list[dict[str, Any]] = []
        for raw_lesson in raw_lessons:
            if not isinstance(raw_lesson, dict):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Each lesson must be an object")
            lesson_id = None
            if "id" in raw_lesson and raw_lesson["id"] is not None:
                if not allow_lesson_ids:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Lesson ids are only accepted when editing a course")
                lesson_id = positive_int(raw_lesson["id"], "Lesson")
            prerequisite_refs = {}
            for field in ("prerequisite_ids", "prerequisite_positions"):
                refs = raw_lesson.get(field, [])
                if not isinstance(refs, list):
                    raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be a list")
                prerequisite_refs[field] = [positive_int(ref, field) for ref in refs]
            lessons.append(
                {
                    "id": lesson_id,
                    "title": clean_text(raw_lesson.get("title"), "Lesson title", 120),
                    "summary": clean_text(raw_lesson.get("summary", ""), "Lesson summary", 500, required=False),
                    "content": clean_text(raw_lesson.get("content", ""), "Lesson content", 4000, required=False),
                    "duration_minutes": positive_int(
                        raw_lesson.get("duration_minutes", 30), "Lesson duration", 5, 240
                    ),
                    **prerequisite_refs,
                    "prerequisites_supplied": any(
                        field in raw_lesson for field in ("prerequisite_ids", "prerequisite_positions")
                    ),
                }
            )
        return (
            {
                "title": title,
                "description": description,
                "category": category,
                "level": level,
                "accent": accent,
            },
            lessons,
        )

    @staticmethod
    def resolve_prerequisites(
        lessons: list[dict[str, Any]], existing: dict[int, list[int]] | None = None
    ) -> list[list[int]]:
        """Resolve refs to submitted positions and validate the entire graph before writes.

        Omitted prerequisite fields on an edit retain edges to surviving lessons.
        Either explicit field replaces the prerequisites (an empty list clears them).
        References through both fields are combined, with duplicate targets rejected.
        """
        positions_by_id = {
            lesson["id"]: position
            for position, lesson in enumerate(lessons, start=1) if lesson["id"] is not None
        }
        graph: list[list[int]] = []
        for position, lesson in enumerate(lessons, start=1):
            if not lesson["prerequisites_supplied"]:
                refs = [
                    positions_by_id[ref]
                    for ref in (existing or {}).get(lesson["id"], []) if ref in positions_by_id
                ]
            else:
                refs = list(lesson["prerequisite_positions"])
                if any(ref > len(lessons) for ref in refs):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "Prerequisite positions must refer to submitted lessons")
                for ref in lesson["prerequisite_ids"]:
                    if ref not in positions_by_id:
                        raise ApiError(
                            HTTPStatus.BAD_REQUEST,
                            "Prerequisite ids must belong to the course and remain in the submitted lesson list",
                        )
                    refs.append(positions_by_id[ref])
            if position in refs:
                raise ApiError(HTTPStatus.BAD_REQUEST, "A lesson cannot require itself as a prerequisite")
            if len(refs) != len(set(refs)):
                raise ApiError(HTTPStatus.BAD_REQUEST, "A prerequisite cannot appear more than once for a lesson")
            graph.append(sorted(refs))

        visiting: set[int] = set()
        visited: set[int] = set()

        def visit(position: int) -> None:
            if position in visiting:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Lesson prerequisites cannot contain a dependency cycle")
            if position in visited:
                return
            visiting.add(position)
            for prerequisite in graph[position - 1]:
                visit(prerequisite)
            visiting.remove(position)
            visited.add(position)

        for position in range(1, len(lessons) + 1):
            visit(position)
        return graph

    @staticmethod
    def save_prerequisites(
        db: sqlite3.Connection, course_id: int, lessons: list[dict[str, Any]], graph: list[list[int]]
    ) -> None:
        db.execute(
            "DELETE FROM lesson_prerequisites WHERE lesson_id IN (SELECT id FROM lessons WHERE course_id = ?)",
            (course_id,),
        )
        db.executemany(
            "INSERT INTO lesson_prerequisites (lesson_id, prerequisite_lesson_id) VALUES (?, ?)",
            (
                (lesson["id"], lessons[prerequisite - 1]["id"])
                for lesson, refs in zip(lessons, graph) for prerequisite in refs
            ),
        )

    def create_course(self, payload: dict[str, Any]) -> dict[str, Any]:
        course_fields, lessons = self.validate_course_payload(payload)
        graph = self.resolve_prerequisites(lessons)
        now = self.now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            cursor = db.execute(
                """
                INSERT INTO courses (title, description, category, level, accent, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    course_fields["title"],
                    course_fields["description"],
                    course_fields["category"],
                    course_fields["level"],
                    course_fields["accent"],
                    now,
                    now,
                ),
            )
            course_id = int(cursor.lastrowid)
            for position, lesson in enumerate(lessons, start=1):
                lesson_id = self.next_lesson_id(db)
                cursor = db.execute(
                    """
                    INSERT INTO lessons
                        (id, course_id, title, summary, content, duration_minutes, position, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        lesson_id,
                        course_id,
                        lesson["title"],
                        lesson["summary"],
                        lesson["content"],
                        lesson["duration_minutes"],
                        position,
                        now,
                    ),
                )
                lesson["id"] = lesson_id
            self.save_prerequisites(db, course_id, lessons, graph)
            return next(course for course in self.list_courses(db) if course["id"] == course_id)

    def update_course(self, course_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        course_fields, lessons = self.validate_course_payload(payload, allow_lesson_ids=True)
        supplied_ids = [lesson["id"] for lesson in lessons if lesson["id"] is not None]
        if len(supplied_ids) != len(set(supplied_ids)):
            raise ApiError(HTTPStatus.BAD_REQUEST, "A lesson cannot appear more than once")

        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.require_course(db, course_id)
            existing_rows = db.execute(
                "SELECT id FROM lessons WHERE course_id = ?", (course_id,)
            ).fetchall()
            existing_ids = {int(row["id"]) for row in existing_rows}
            foreign_ids = [lesson_id for lesson_id in supplied_ids if lesson_id not in existing_ids]
            if foreign_ids:
                raise ApiError(
                    HTTPStatus.BAD_REQUEST,
                    "Every lesson id must belong to the course being edited",
                )
            existing_prerequisites: dict[int, list[int]] = {}
            for row in db.execute(
                """
                SELECT p.lesson_id, p.prerequisite_lesson_id
                FROM lesson_prerequisites p JOIN lessons l ON l.id = p.lesson_id
                WHERE l.course_id = ?
                """,
                (course_id,),
            ):
                existing_prerequisites.setdefault(row["lesson_id"], []).append(row["prerequisite_lesson_id"])
            graph = self.resolve_prerequisites(lessons, existing_prerequisites)

            now = self.now()
            db.execute(
                """
                UPDATE courses
                SET title = ?, description = ?, category = ?, level = ?, accent = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    course_fields["title"],
                    course_fields["description"],
                    course_fields["category"],
                    course_fields["level"],
                    course_fields["accent"],
                    now,
                    course_id,
                ),
            )

            for position, lesson in enumerate(lessons, start=1):
                values = (
                    lesson["title"],
                    lesson["summary"],
                    lesson["content"],
                    lesson["duration_minutes"],
                    position,
                )
                if lesson["id"] is None:
                    lesson_id = self.next_lesson_id(db)
                    cursor = db.execute(
                        """
                        INSERT INTO lessons
                            (id, course_id, title, summary, content, duration_minutes, position, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (lesson_id, course_id, *values, now),
                    )
                    lesson["id"] = lesson_id
                else:
                    db.execute(
                        """
                        UPDATE lessons
                        SET title = ?, summary = ?, content = ?, duration_minutes = ?, position = ?
                        WHERE id = ? AND course_id = ?
                        """,
                        (*values, lesson["id"], course_id),
                    )

            removed_ids = existing_ids - set(supplied_ids)
            if removed_ids:
                placeholders = ",".join("?" for _ in removed_ids)
                db.execute(
                    f"DELETE FROM lessons WHERE course_id = ? AND id IN ({placeholders})",
                    (course_id, *sorted(removed_ids)),
                )
                # Current schemas cascade these deletes; also repair legacy tables
                # that were created without foreign key constraints.
                self.cleanup_orphan_lesson_rows(db)
            self.save_prerequisites(db, course_id, lessons, graph)
            return next(course for course in self.list_courses(db) if course["id"] == course_id)

    def enroll(self, course_id: int) -> dict[str, Any]:
        now = self.now()
        with self.connect() as db:
            self.require_course(db, course_id)
            learner_id = self.learner(db)["id"]
            cursor = db.execute(
                "INSERT OR IGNORE INTO enrollments (learner_id, course_id, enrolled_at) VALUES (?, ?, ?)",
                (learner_id, course_id, now),
            )
            course = next(course for course in self.list_courses(db) if course["id"] == course_id)
            course["already_enrolled"] = cursor.rowcount == 0
            return {"course": course, "created": cursor.rowcount > 0}

    def complete_lesson(self, lesson_id: int) -> dict[str, Any]:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id, course_id FROM lessons WHERE id = ?", (lesson_id,)).fetchone()
            if row is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Lesson not found")
            learner_id = self.learner(db)["id"]
            enrolled = db.execute(
                "SELECT 1 FROM enrollments WHERE learner_id = ? AND course_id = ?",
                (learner_id, row["course_id"]),
            ).fetchone()
            if enrolled is None:
                raise ApiError(HTTPStatus.CONFLICT, "Enroll in this course before completing lessons")
            lesson = next(
                lesson for lesson in self.lessons_for_course(db, row["course_id"], learner_id)
                if lesson["id"] == lesson_id
            )
            if not lesson["completed"]:
                if lesson["blocked_by"]:
                    raise ApiError(
                        HTTPStatus.CONFLICT,
                        "Complete the prerequisite lessons before completing this lesson",
                        {"lesson_id": lesson_id, "course_id": row["course_id"], "blocked_by": lesson["blocked_by"]},
                    )
                db.execute(
                    "INSERT INTO lesson_progress (learner_id, lesson_id, completed_at) VALUES (?, ?, ?)",
                    (learner_id, lesson_id, self.now()),
                )
            course = next(course for course in self.list_courses(db) if course["id"] == row["course_id"])
            return {"lesson_id": lesson_id, "course": course}

    def create_group(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = clean_text(payload.get("name"), "Group name", 100)
        description = clean_text(payload.get("description", ""), "Description", 600, required=False)
        color = hex_color(payload.get("color", "#19c3a3"), "Color", "#19c3a3")
        now = self.now()
        with self.connect() as db:
            cursor = db.execute(
                "INSERT INTO study_groups (name, description, color, created_at) VALUES (?, ?, ?, ?)",
                (name, description, color, now),
            )
            group_id = int(cursor.lastrowid)
            learner_id = self.learner(db)["id"]
            db.execute(
                "INSERT INTO group_members (group_id, learner_id, joined_at) VALUES (?, ?, ?)",
                (group_id, learner_id, now),
            )
            return next(group for group in self.list_groups(db) if group["id"] == group_id)

    def join_group(self, group_id: int) -> dict[str, Any]:
        with self.connect() as db:
            if db.execute("SELECT 1 FROM study_groups WHERE id = ?", (group_id,)).fetchone() is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Study group not found")
            db.execute(
                "INSERT OR IGNORE INTO group_members (group_id, learner_id, joined_at) VALUES (?, ?, ?)",
                (group_id, self.learner(db)["id"], self.now()),
            )
            return next(group for group in self.list_groups(db) if group["id"] == group_id)

    def create_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        group_id = positive_int(payload.get("group_id"), "Study group")
        course_value = payload.get("course_id")
        course_id = positive_int(course_value, "Course") if course_value not in (None, "", 0, "0") else None
        title = clean_text(payload.get("title"), "Session title", 120)
        session_date = strict_date(payload.get("session_date"), "Date")
        start_time = strict_time(payload.get("start_time"), "Start time")
        notes = clean_text(payload.get("notes", ""), "Notes", 1000, required=False)
        duration = positive_int(payload.get("duration_minutes", 60), "Duration", 15, 480)
        time_zone = session_timezone(payload)
        fold = positive_int(payload.get("fold", 0), "Fold", 0, 1)
        start_utc, end_utc = session_utc_interval(session_date, start_time, duration, time_zone, fold)
        if clock_minutes(start_time) + duration > 24 * 60:
            raise ApiError(HTTPStatus.BAD_REQUEST, "A session must end by midnight on its scheduled date")
        with self.connect() as db:
            # Hold the writer lock across validation and insertion so concurrent
            # requests cannot both reserve overlapping intervals.
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM study_groups WHERE id = ?", (group_id,)).fetchone() is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Study group not found")
            learner_id = self.learner(db)["id"]
            if db.execute(
                "SELECT 1 FROM group_members WHERE group_id = ? AND learner_id = ?",
                (group_id, learner_id),
            ).fetchone() is None:
                raise ApiError(HTTPStatus.CONFLICT, "Join this study group before scheduling a session")
            if course_id is not None and db.execute("SELECT 1 FROM courses WHERE id = ?", (course_id,)).fetchone() is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Course not found")
            scheduled = db.execute(
                """
                SELECT s.*, g.name AS group_name, g.color AS group_color,
                       c.title AS course_title
                FROM sessions s
                JOIN study_groups g ON g.id = s.group_id
                JOIN group_members gm ON gm.group_id = s.group_id AND gm.learner_id = ?
                LEFT JOIN courses c ON c.id = s.course_id
                WHERE s.status = 'scheduled' AND (
                    (? < s.end_utc AND s.start_utc < ?)
                    OR (s.timezone = ? AND s.session_date = ?)
                )
                ORDER BY s.start_utc, s.id
                """,
                (learner_id, start_utc, end_utc, time_zone, session_date),
            ).fetchall()
            conflicts = []
            for session in scheduled:
                # UTC catches real collisions even on different local dates;
                # the wall-clock rule also reserves repeated DST clock slots.
                utc_overlap = start_utc < session["end_utc"] and session["start_utc"] < end_utc
                local_overlap = (
                    session["timezone"] == time_zone
                    and session["session_date"] == session_date
                    and clock_minutes(start_time) < clock_minutes(session["start_time"]) + session["duration_minutes"]
                    and clock_minutes(session["start_time"]) < clock_minutes(start_time) + duration
                )
                if not (utc_overlap or local_overlap):
                    continue
                local_end = datetime.fromisoformat(session["end_utc"]).astimezone(ZoneInfo(session["timezone"]))
                conflicts.append({
                    **self.serialize_session(session),
                    "end_time": local_end.strftime("%H:%M"),
                })
            if conflicts:
                raise ApiError(
                    HTTPStatus.CONFLICT,
                    "This session conflicts with an existing session in your schedule",
                    {
                        "session": {
                            "group_id": group_id, "course_id": course_id, "title": title,
                            "session_date": session_date, "start_time": start_time,
                            "duration_minutes": duration,
                            "time_zone": time_zone, "timezone": time_zone,
                            "start_utc": start_utc, "end_utc": end_utc, "status": "scheduled",
                        },
                        "conflicts": conflicts,
                        "conflict": conflicts[0],
                    },
                )
            cursor = db.execute(
                """
                INSERT INTO sessions
                    (group_id, course_id, title, session_date, start_time, duration_minutes, notes,
                     created_at, timezone, time_zone, start_utc, end_utc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (group_id, course_id, title, session_date, start_time, duration, notes,
                 self.now(), time_zone, time_zone, start_utc, end_utc),
            )
            session_id = int(cursor.lastrowid)
            return self.session_by_id(db, session_id)

    def cancel_session(self, session_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        reason = clean_text(payload.get("reason", ""), "Cancellation reason", 500, required=False) or None
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            session = db.execute("SELECT status FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if session is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Session not found")
            if session["status"] == "scheduled":
                db.execute(
                    """
                    UPDATE sessions SET status = 'cancelled', cancelled_at = ?,
                                        cancellation_reason = ?, cancelled_reason = ?
                    WHERE id = ?
                    """,
                    (self.now(), reason, reason, session_id),
                )
            return self.session_by_id(db, session_id)

    def delete_session(self, session_id: int) -> None:
        with self.connect() as db:
            cursor = db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            if cursor.rowcount == 0:
                raise ApiError(HTTPStatus.NOT_FOUND, "Session not found")

    @staticmethod
    def require_course(db: sqlite3.Connection, course_id: int) -> sqlite3.Row:
        row = db.execute("SELECT id FROM courses WHERE id = ?", (course_id,)).fetchone()
        if row is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Course not found")
        return row


def clean_text(value: Any, field: str, maximum: int, required: bool = True) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be text")
    value = value.strip()
    if required and not value:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} is required")
    if len(value) > maximum:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be {maximum} characters or fewer")
    return value


def hex_color(value: Any, field: str, default: str) -> str:
    color = clean_text(value, field, 20, required=False) or default
    if HEX_COLOR_PATTERN.fullmatch(color) is None:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be a 6-digit hex color")
    return color


def strict_date(value: Any, field: str) -> str:
    raw = clean_text(value, field, 10)
    if DATE_PATTERN.fullmatch(raw) is None:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must use YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(raw)
    except ValueError as exc:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be a valid calendar date") from exc
    if parsed.isoformat() != raw:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must use YYYY-MM-DD")
    return raw


def strict_time(value: Any, field: str) -> str:
    raw = clean_text(value, field, 5)
    if raw != value or TIME_PATTERN.fullmatch(raw) is None:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must use HH:MM")
    try:
        parsed = datetime.strptime(raw, "%H:%M")
    except ValueError as exc:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be a valid 24-hour time") from exc
    if parsed.strftime("%H:%M") != raw:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must use HH:MM")
    return raw


def clock_minutes(value: str) -> int:
    """Convert an already validated fixed-clock HH:MM to minutes, without timezones."""
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def session_timezone(payload: dict[str, Any]) -> str:
    """Require an explicit IANA key; retain the older time_zone spelling."""
    supplied = [field for field in ("timezone", "time_zone") if field in payload]
    if not supplied:
        raise ApiError(
            HTTPStatus.BAD_REQUEST, "Time zone is required", {"field": "timezone"}
        )
    zones = []
    for field in supplied:
        try:
            key = clean_text(payload[field], "Time zone", 255)
            ZoneInfo(key)
        except (ApiError, ZoneInfoNotFoundError, ValueError) as exc:
            raise ApiError(
                HTTPStatus.BAD_REQUEST,
                "Time zone must be a valid IANA ZoneInfo name",
                {"field": field},
            ) from exc
        zones.append(key)
    if len(set(zones)) != 1:
        raise ApiError(
            HTTPStatus.BAD_REQUEST, "Time zone fields must agree", {"field": "timezone"}
        )
    return zones[0]


def session_utc_interval(
    session_date: str, start_time: str, duration: int, time_zone: str, fold: int = 0,
) -> tuple[str, str]:
    """Resolve a wall-clock start and elapsed duration to an absolute interval.

    Ambiguous starts default to fold=0 (the first occurrence); fold=1 selects
    the second occurrence. A UTC round trip rejects nonexistent local starts.
    UTC timestamps always use the same seconds-resolution +00:00 format so
    SQLite can compare their text values chronologically.
    """
    try:
        zone = ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ApiError(
            HTTPStatus.BAD_REQUEST, "Time zone must be a valid IANA ZoneInfo name",
            {"field": "timezone"},
        ) from exc
    try:
        local_start = datetime.fromisoformat(f"{session_date}T{start_time}")
        start = local_start.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
        if start.astimezone(zone).replace(tzinfo=None) != local_start:
            raise ApiError(
                HTTPStatus.BAD_REQUEST, "Start time does not exist in the selected time zone",
                {"field": "start_time", "timezone": time_zone},
            )
        end = start + timedelta(minutes=duration)
    except (ValueError, OverflowError) as exc:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Session interval is outside the supported calendar range") from exc
    return start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")


def positive_int(value: Any, field: str, minimum: int = 1, maximum: int | None = None) -> int:
    if isinstance(value, bool):
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be an integer")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and INTEGER_PATTERN.fullmatch(value.strip()):
        parsed = int(value.strip())
    else:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be an integer")
    if parsed < minimum or (maximum is not None and parsed > maximum):
        boundary = f"between {minimum} and {maximum}" if maximum is not None else f"at least {minimum}"
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{field} must be {boundary}")
    return parsed


class StudyRequestHandler(BaseHTTPRequestHandler):
    """Serve the browser interface and the local JSON API."""

    database: StudyDatabase

    def log_message(self, format: str, *args: Any) -> None:
        # Keep local use quiet while retaining normal HTTP server diagnostics.
        if self.path.startswith("/api/"):
            super().log_message(format, *args)

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def send_download(self, body: str | bytes, filename: str, content_type: str) -> None:
        encoded = body.encode("utf-8") if isinstance(body, str) else body
        safe_filename = re.sub(r"[^A-Za-z0-9._-]", "_", filename)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{safe_filename}"')
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_json(
        self, status: HTTPStatus, message: str, details: dict[str, Any] | None = None
    ) -> None:
        payload: dict[str, Any] = {"error": message, "details": details if details is not None else {}}
        if details is not None:
            payload["details"] = details
            # Keep the small aliases used by the existing browser client while
            # exposing the canonical structured form under details.
            if "blocked_by" in details:
                payload["blocked_by"] = details["blocked_by"]
                payload["blocked_prerequisites"] = details["blocked_by"]
            if "conflicts" in details:
                payload["conflicts"] = details["conflicts"]
                payload["conflict"] = details["conflicts"][0] if details["conflicts"] else None
        self.send_json(payload, status)

    def read_body(self, max_bytes: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                raise ValueError("negative content length")
            if length > max_bytes:
                raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")
            return self.rfile.read(length)
        except ApiError:
            raise
        except ValueError as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body length is invalid") from exc

    def read_payload(self, max_bytes: int = MAX_PAYLOAD_BYTES) -> dict[str, Any]:
        try:
            raw = self.read_body(max_bytes)
            payload = json.loads(raw.decode("utf-8") or "{}")
        except ApiError:
            raise
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object")
        return payload

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlparse(self.path).path
        try:
            if path == "/api/bootstrap":
                self.send_json(self.database.dashboard())
                return
            if path == "/api/courses":
                self.send_json({"courses": self.database.list_courses()})
                return
            if path == "/api/groups":
                self.send_json({"groups": self.database.list_groups()})
                return
            if path == "/api/sessions":
                self.send_json({"sessions": self.database.list_sessions()})
                return
            if path == "/api/progress":
                self.send_json(self.database.progress_summary())
                return
            if path == "/api/export.json":
                self.send_download(
                    json.dumps(self.database.export_workspace(), indent=2),
                    "study-workspace.json",
                    "application/json; charset=utf-8",
                )
                return
            if path == "/api/export.csv":
                self.send_download(
                    self.database.export_csv(),
                    "study-workspace.csv",
                    "text/csv; charset=utf-8",
                )
                return
            if path == "/api/backup":
                self.send_download(
                    self.database.backup_bytes(),
                    "study-workspace.sqlite",
                    "application/x-sqlite3",
                )
                return
            segments = [unquote(segment) for segment in path.split("/") if segment]
            if len(segments) == 4 and segments[:2] == ["api", "groups"] and segments[3] == "posts":
                group_id = positive_int(segments[2], "Study group")
                self.send_json(self.database.list_group_posts(group_id))
                return
            if path.startswith("/api/"):
                self.send_error_json(HTTPStatus.NOT_FOUND, "API route not found")
                return
            self.serve_static(path)
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message, exc.details)
        except Exception:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "Something went wrong in the local service")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlparse(self.path).path.rstrip("/")
        try:
            if path == "/api/restore":
                self.database.restore_bytes(self.read_body(MAX_BACKUP_PAYLOAD_BYTES))
                self.send_json({"restored": True})
                return
            if path == "/api/restore/validate":
                self.database.validate_restore_bytes(self.read_body(MAX_BACKUP_PAYLOAD_BYTES))
                self.send_json({"valid": True})
                return
            max_bytes = (
                MAX_BACKUP_PAYLOAD_BYTES
                if path in ("/api/backup/validate", "/api/backup/restore")
                else MAX_PAYLOAD_BYTES
            )
            payload = self.read_payload(max_bytes)
            if path == "/api/backup/validate":
                self.send_json(self.database.validate_backup_response(payload))
                return
            if path == "/api/backup/restore":
                self.send_json(self.database.restore_backup(payload))
                return
            if path == "/api/courses":
                self.send_json({"course": self.database.create_course(payload)}, HTTPStatus.CREATED)
                return
            if path == "/api/groups":
                self.send_json({"group": self.database.create_group(payload)}, HTTPStatus.CREATED)
                return
            if path == "/api/sessions":
                self.send_json({"session": self.database.create_session(payload)}, HTTPStatus.CREATED)
                return
            segments = [unquote(segment) for segment in path.split("/") if segment]
            if len(segments) == 4 and segments[:2] == ["api", "courses"] and segments[3] == "enroll":
                course_id = positive_int(segments[2], "Course")
                self.send_json(self.database.enroll(course_id))
                return
            if len(segments) == 4 and segments[:2] == ["api", "lessons"] and segments[3] == "complete":
                lesson_id = positive_int(segments[2], "Lesson")
                self.send_json(self.database.complete_lesson(lesson_id))
                return
            if len(segments) == 4 and segments[:2] == ["api", "groups"] and segments[3] == "join":
                group_id = positive_int(segments[2], "Study group")
                self.send_json({"group": self.database.join_group(group_id)})
                return
            if len(segments) == 4 and segments[:2] == ["api", "groups"] and segments[3] == "posts":
                group_id = positive_int(segments[2], "Study group")
                self.send_json({"post": self.database.create_group_post(group_id, payload)}, HTTPStatus.CREATED)
                return
            if len(segments) == 4 and segments[:2] == ["api", "sessions"] and segments[3] == "cancel":
                session_id = positive_int(segments[2], "Session")
                self.send_json({"session": self.database.cancel_session(session_id, payload)})
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, "API route not found")
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message, exc.details)
        except Exception:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "Something went wrong in the local service")

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlparse(self.path).path.rstrip("/")
        try:
            payload = self.read_payload()
            segments = [unquote(segment) for segment in path.split("/") if segment]
            if len(segments) == 3 and segments[:2] == ["api", "courses"]:
                course_id = positive_int(segments[2], "Course")
                self.send_json({"course": self.database.update_course(course_id, payload)})
                return
            if len(segments) == 5 and segments[:2] == ["api", "groups"] and segments[3] == "posts":
                group_id = positive_int(segments[2], "Study group")
                post_id = positive_int(segments[4], "Post")
                self.send_json({"post": self.database.update_group_post(group_id, post_id, payload)})
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, "API route not found")
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message, exc.details)
        except Exception:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "Something went wrong in the local service")

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlparse(self.path).path.rstrip("/")
        try:
            segments = [unquote(segment) for segment in path.split("/") if segment]
            if len(segments) == 3 and segments[:2] == ["api", "sessions"]:
                session_id = positive_int(segments[2], "Session")
                self.database.delete_session(session_id)
                self.send_json({"deleted": True})
                return
            if len(segments) == 5 and segments[:2] == ["api", "groups"] and segments[3] == "posts":
                group_id = positive_int(segments[2], "Study group")
                post_id = positive_int(segments[4], "Post")
                self.database.delete_group_post(group_id, post_id)
                self.send_json({"deleted": True})
                return
            self.send_error_json(HTTPStatus.NOT_FOUND, "API route not found")
        except ApiError as exc:
            self.send_error_json(exc.status, exc.message, exc.details)
        except Exception:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "Something went wrong in the local service")

    def serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        target = (PUBLIC_DIR / relative).resolve()
        try:
            target.relative_to(PUBLIC_DIR.resolve())
        except ValueError:
            self.send_error_json(HTTPStatus.NOT_FOUND, "File not found")
            return
        if not target.is_file():
            self.send_error_json(HTTPStatus.NOT_FOUND, "File not found")
            return
        body = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") or content_type == "application/javascript" else content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def create_server(
    host: str = "127.0.0.1", port: int = 8000, db_path: str | Path = DEFAULT_DB,
    *, clock: Callable[[], datetime] | None = None,
) -> ThreadingHTTPServer:
    database = StudyDatabase(db_path, clock=clock)

    class BoundStudyRequestHandler(StudyRequestHandler):
        pass

    BoundStudyRequestHandler.database = database
    server = ThreadingHTTPServer((host, port), BoundStudyRequestHandler)
    server.database = database  # type: ignore[attr-defined]
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the local Study Workspace")
    parser.add_argument("--host", default="127.0.0.1", help="Interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000)")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite database path")
    args = parser.parse_args()
    server = create_server(args.host, args.port, args.db)
    print(f"Study Workspace running at http://{args.host}:{args.port}")
    print(f"SQLite database: {Path(args.db).resolve()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Study Workspace")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
