const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const context = { console, setTimeout, clearTimeout, Intl, Date, window: { addEventListener() {} } };
vm.runInNewContext(`${source}
  globalThis.browserRules = {
    existingPrerequisiteKeys,
    prerequisiteChoices,
    prerequisitePositions,
    selectedPrerequisiteTargets,
    sessionPayload,
    coursePayload,
    scheduleErrorMessage,
    filterCalendarSessions,
  };
`, context);

function field(key, id, title) {
  return {
    dataset: { lessonKey: key, lessonId: id || "" },
    querySelector: () => ({ value: title }),
  };
}

test("prerequisite choices include later lessons and retain key-based selections", () => {
  const first = field("id-10", 10, "First");
  const second = field("id-20", 20, "Second");
  const third = field("new-1", null, "Third");
  const fields = [first, second, third];

  assert.deepEqual(
    context.browserRules.prerequisiteChoices(fields, first).map((choice) => [choice.key, choice.position]),
    [["id-20", 2], ["new-1", 3]],
  );
  assert.deepEqual(
    context.browserRules.selectedPrerequisiteTargets(fields, first, new Set(["new-1"])),
    [third],
  );
  assert.deepEqual(
    context.browserRules.prerequisitePositions(fields, first, new Set(["new-1"])),
    [3],
  );

  third.querySelector = () => ({ value: "Renamed third" });
  assert.equal(context.browserRules.prerequisiteChoices(fields, first)[1].title, "Renamed third");
  assert.deepEqual(
    context.browserRules.selectedPrerequisiteTargets([first, second], first, new Set(["new-1"])),
    [],
  );
});

test("existing prerequisite IDs and positions initialize after all fields exist", () => {
  const fields = [field("id-10", 10, "First"), field("id-20", 20, "Second"), field("id-30", 30, "Third")];
  assert.deepEqual(
    [...context.browserRules.existingPrerequisiteKeys({ prerequisite_ids: [30], prerequisite_positions: [3] }, fields)],
    ["id-30"],
  );
  assert.deepEqual(
    [...context.browserRules.existingPrerequisiteKeys({ prerequisite_positions: [2] }, fields)],
    ["id-20"],
  );
});

test("session payload keeps the entered timezone and sends numeric fold", () => {
  const form = {
    title: { value: "DST study" },
    group_id: { value: "7" },
    course_id: { value: "" },
    session_date: { value: "2026-11-01" },
    start_time: { value: "01:30" },
    timezone: { value: "America/New_York" },
    fold: { value: "1" },
    duration_minutes: { value: "60" },
    notes: { value: "Second occurrence" },
  };
  const payload = context.browserRules.sessionPayload(form);
  assert.equal(payload.title, "DST study");
  assert.equal(payload.group_id, 7);
  assert.equal(payload.session_date, "2026-11-01");
  assert.equal(payload.start_time, "01:30");
  assert.equal(payload.duration_minutes, 60);
  assert.equal(payload.notes, "Second occurrence");
  assert.equal(payload.timezone, "America/New_York");
  assert.equal(payload.fold, 1);
  assert.equal(typeof payload.fold, "number");
});

test("course payload preserves lesson data and prerequisite positions", () => {
  const lesson = (key, title, duration, prerequisite = false) => ({
    dataset: { lessonKey: key, lessonId: key === "id-10" ? "10" : "" },
    querySelector(selector) {
      const values = {
        '[data-lesson="title"]': { value: title },
        '[data-lesson=title]': { value: title },
        '[data-lesson="summary"]': { value: `${title} summary` },
        '[data-lesson=summary]': { value: `${title} summary` },
        '[data-lesson="content"]': { value: `${title} content` },
        '[data-lesson=content]': { value: `${title} content` },
        '[data-lesson="duration_minutes"]': { value: String(duration) },
        '[data-lesson=duration_minutes]': { value: String(duration) },
      };
      return values[selector];
    },
    querySelectorAll(selector) {
      return selector === "[data-prerequisite]:checked" && prerequisite ? [{ value: "id-10" }] : [];
    },
  });
  const fields = [lesson("id-10", "First", 20), lesson("new-2", "Second", 25, true)];
  const form = {
    title: { value: "A browser course" },
    description: { value: "Description" },
    category: { value: "Testing" },
    level: { value: "Beginner" },
    accent: { value: "#123456" },
    querySelectorAll(selector) { return selector === ".lesson-field" ? fields : []; },
  };
  const payload = context.browserRules.coursePayload(form);
  assert.equal(payload.title, "A browser course");
  assert.equal(payload.lessons[0].duration_minutes, 20);
  assert.equal(payload.lessons[1].duration_minutes, 25);
  assert.deepEqual(Array.from(payload.lessons[1].prerequisite_positions), [1]);
});

test("browser wiring exposes the requested user-flow controls and conflict feedback", () => {
  for (const id of ["course-form", "session-form", "calendar-wrap", "restore-form", "restore-confirm"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(source, /\/api\/courses\/\$\{courseId\}\/enroll/);
  assert.match(source, /\/api\/lessons\/\$\{lesson\.id\}\/complete/);
  assert.match(source, /\/api\/sessions/);
  assert.match(source, /\/api\/backup/);
  assert.match(source, /\/api\/restore/);
  const message = context.browserRules.scheduleErrorMessage({
    status: 409,
    message: "That time overlaps an existing session.",
    payload: { conflict: { title: "Existing session", group_name: "Study group", session_date: "2026-10-16", start_time: "19:00", time_zone: "UTC" } },
  });
  assert.match(message, /Schedule conflict/);
  assert.match(message, /Existing session/);
});

test("calendar filters keep workspace sessions and narrow to the learner's groups or course", () => {
  const sessions = [
    { id: 1, group_id: 10, course_id: 20, status: "scheduled" },
    { id: 2, group_id: 11, course_id: null, status: "scheduled" },
    { id: 3, group_id: 10, course_id: 21, status: "cancelled" },
  ];
  const groups = [{ id: 10, joined: true }, { id: 11, joined: false }];
  assert.deepEqual(context.browserRules.filterCalendarSessions(sessions, groups).map((item) => item.id), [1, 2]);
  assert.deepEqual(context.browserRules.filterCalendarSessions(sessions, groups, "mine").map((item) => item.id), [1]);
  assert.deepEqual(context.browserRules.filterCalendarSessions(sessions, groups, "all", "none").map((item) => item.id), [2]);
  assert.deepEqual(context.browserRules.filterCalendarSessions(sessions, groups, "all", "20").map((item) => item.id), [1]);
});
