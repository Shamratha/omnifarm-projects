# Local Study Workspace

A local-first learning workflow component for planning study without a cloud
account. It bundles courses, lessons, learner progress, study groups, group
discussions, planned sessions, prerequisites, and a weekly calendar behind a
small dependency-free Python service and SQLite database.

## Local setup

### Requirements

- Python 3.10 or newer. The service uses only the Python standard library.
- Node.js 18 or newer for the browser-rule checks in `tests/`.

No package installation is required. From this folder:

```bash
python3 app.py
```

Open <http://127.0.0.1:8000>. The default database is
`study_workspace.db`; use `--db path/to/another.db` to keep a separate local
workspace:

```bash
python3 app.py --host 127.0.0.1 --port 8000 --db data/study.db
```

The first run creates bundled example courses, lessons, groups, and current-
week sessions. Changes persist in SQLite. The browser flow supports creating a
course, enrolling locally, completing an available lesson, joining a group,
posting in a group discussion, and scheduling a session with an explicit IANA
time zone.

Prerequisites, all-lessons completion rules, fixed-clock UTC conflict checks,
daylight-saving `fold` handling, cancellation, duplicate-enrollment safety,
and deleted-lesson cleanup are enforced by the service rather than only by the
UI. The service binds to localhost by default; it is not an internet-facing
deployment configuration.

## Data model

SQLite is the only application persistence layer. The main tables are:

| Table | Purpose |
| --- | --- |
| `learners` | The local learner profile used by the workspace. |
| `courses` | Course title, description, category, level, accent, and timestamps. |
| `lessons` | Ordered course lessons and their content/duration. Lesson IDs are allocated monotonically. |
| `lesson_prerequisites` | Acyclic lesson-to-lesson prerequisite edges within a course. |
| `enrollments` | Learner/course enrollment records. |
| `lesson_progress` | One completion record per learner and lesson. |
| `study_groups` | Local study group metadata. |
| `group_members` | Learner membership in study groups. |
| `group_posts` | Plain-text discussion posts with author and edit timestamps. |
| `sessions` | Group study sessions, local wall-clock date/time, IANA timezone, UTC interval, and cancellation state. |
| `lesson_id_sequence` | Ensures deleted lesson IDs are not reused. |

The important relationships are learner → enrollments → courses → lessons,
lesson prerequisites → lessons in the same course, learner → group members →
groups, and group → sessions/posts. Completion is only available to an
enrolled learner after all prerequisite lessons are complete. Session conflicts
are checked using UTC intervals and the entered timezone, including repeated
daylight-saving times.

## Local data, export, and restore

The browser includes local-only JSON/CSV export plus SQLite backup/restore.
`GET /api/export.json` is a portable JSON export; `GET /api/export.csv` is a
tabular export; `GET /api/backup` downloads the SQLite file itself. SQLite
restore validates the uploaded database, required tables, integrity, foreign
keys, and workspace row constraints before atomically replacing the current
database. JSON backup validation/restore endpoints are also available for
portable snapshots.

Restore replaces all local state. Keep a backup before experimenting, and only
restore a SQLite or JSON file you trust. The browser performs client-side file
checks, but the backend remains authoritative.

## What is intentionally not included

This workspace is a local workflow component, not a hosted learning platform.
The following cloud features are explicitly out of scope or still missing:

- account registration, sign-in, password recovery, and multi-tenant identity;
- remote database storage, cloud synchronization, or conflict resolution across
  devices;
- server-side real-time discussion delivery, moderation, presence, or push
  notifications;
- email, SMS, calendar-provider, video-meeting, or external LMS integrations;
- hosted file/media attachments, cloud object storage, and collaborative
  document editing;
- cloud analytics, organization-wide reporting, administrator roles, billing,
  or a production deployment/authentication boundary.

The current learner and group model is intentionally local and small. These
limitations should be treated as product boundaries, not as guarantees about a
future hosted service.

## Checks and flow coverage

Run the complete service and browser-rule checks from this folder:

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile app.py
node --check public/app.js
node --test tests/test_browser_rules.js
```

The service integration suite uses a fixed, timezone-aware clock and exercises
course creation, enrollment, lesson completion and persistence, prerequisite
blocking, scheduling conflicts, timezone/DST behavior, cancellation, data
exports, SQLite backup/restore, JSON backup validation/restore, and atomic
failure behavior. The Node browser checks run the frontend rules in a VM and
cover course/session payload serialization, prerequisite selection, calendar
filters, conflict feedback wiring, and the presence of the main user-flow
controls. A full Playwright/Puppeteer browser runner is not currently part of
the repository; interactive visual checks remain a manual follow-up when a
browser harness is available.

## Attribution

The product direction is inspired by the Alpha One Labs Learn Platform / Open
Science Labs proposal in Google Summer of Code 2026:

<https://summerofcode.withgoogle.com/programs/2026/projects/c6IVMXpx>

This repository is a local, independent implementation for study-workspace
experimentation. It does not claim to be the proposal's official codebase or
to provide the proposal's unimplemented cloud capabilities.
