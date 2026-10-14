const state = {
  data: null,
  view: "dashboard",
  courseFilter: "all",
  calendarAnchor: null,
  calendarLearnerFilter: "all",
  calendarCourseFilter: "all",
  activeSession: null,
  progress: null,
  activeCourse: null,
  activeLesson: null,
  activeGroup: null,
  discussionPosts: [],
  activeModal: null,
  restoring: false,
  pendingBackupFile: null,
};

let discussionRequest = 0;
let summaryRequest = 0;
let refreshRequest = 0;
let modalCloseTimer;
let modalTrigger = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeColor(value, fallback = "#7255ed") {
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? value : fallback;
}

function progressPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function getCourse(id) {
  return state.data?.courses.find((course) => Number(course.id) === Number(id));
}

function getGroup(id) {
  return state.data?.groups.find((group) => Number(group.id) === Number(id));
}

function lessonPrerequisites(course, lesson) {
  if (Array.isArray(lesson.prerequisite_ids)) {
    return lesson.prerequisite_ids.map((id) => course.lessons.find((item) => Number(item.id) === Number(id))
      || { id, title: `Lesson ${id}`, completed: false });
  }
  if (lesson.prerequisites?.length) return lesson.prerequisites;
  return (lesson.prerequisite_positions ?? []).map((position) =>
    course.lessons.find((item) => Number(item.position) === Number(position))
    || { id: position, title: `Lesson ${position}`, completed: false });
}

function lessonStatus(course, lesson) {
  const prerequisites = lessonPrerequisites(course, lesson);
  const blocked = Array.isArray(lesson.blocked_by)
    ? lesson.blocked_by
    : prerequisites.filter((item) => !item.completed);
  const locked = !lesson.completed && (blocked.length > 0 || lesson.locked === true
    || lesson.is_locked === true || lesson.prerequisites_met === false);
  return { prerequisites, blocked, locked };
}

function prerequisiteHint(course, lesson) {
  const { prerequisites, blocked, locked } = lessonStatus(course, lesson);
  if (!prerequisites.length) return locked ? "Locked · Complete prerequisite lessons first." : "";
  const titles = prerequisites.map((item) => item.title).join(", ");
  const count = `${prerequisites.length} prerequisite${prerequisites.length === 1 ? "" : "s"}`;
  if (locked) return `Locked · ${blocked.length || prerequisites.length} of ${count} incomplete: ${titles}`;
  return `${count}: ${titles}${lesson.completed ? " · Completed lesson remains readable." : " · All complete."}`;
}

function nextCourseLesson(course) {
  const lessons = course.lessons || [];
  // A supplied null means the service has no available next lesson.
  const next = course.next_lesson_id !== undefined
    ? lessons.find((lesson) => Number(lesson.id) === Number(course.next_lesson_id))
    : lessons.find((lesson) => !lesson.completed && !lessonStatus(course, lesson).locked);
  return next && !next.completed && !lessonStatus(course, next).locked ? next : null;
}

function prerequisiteErrorMessage(error, course) {
  if (error.status !== 409) return error.message;
  const payload = error.payload || {};
  const blocked = payload.blocked_prerequisites ?? payload.blocked_prerequisite_titles
    ?? payload.blocked_prerequisite_ids ?? [];
  const titles = (Array.isArray(blocked) ? blocked : []).map((item) => {
    if (typeof item === "object") return item.title || course?.lessons.find((lesson) => Number(lesson.id) === Number(item.id))?.title;
    if (typeof item === "number") return course?.lessons.find((lesson) => Number(lesson.id) === item)?.title || `Lesson ${item}`;
    return item;
  }).filter(Boolean);
  return titles.length ? `${error.message} Complete these prerequisites first: ${titles.join(", ")}.` : error.message;
}

function scheduleErrorMessage(error) {
  const rawConflict = error.status === 409 && error.payload?.conflict;
  const conflict = rawConflict?.session || rawConflict?.existing_session || rawConflict;
  if (!conflict) return error.message;
  const group = conflict.group_name || getGroup(conflict.group_id)?.name;
  const time = conflict.start_time && conflict.end_time
    ? `${conflict.start_time}–${conflict.end_time}`
    : conflict.start_time;
  const zone = conflict.time_zone || conflict.timezone;
  const details = [conflict.title ? `“${conflict.title}”` : "An existing session", group, conflict.session_date, time, zone].filter(Boolean).join(" · ");
  return `Schedule conflict: ${details}. ${error.message} Choose another date or time; this session was not added.`;
}

async function request(path, options = {}) {
  const response = await requestBlob(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  return response.json().catch(() => ({}));
}

async function requestBlob(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { ...(options.headers || {}) },
  });
  if (!response.ok) {
    let payload = {};
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) payload = await response.json().catch(() => ({}));
    else payload = { error: await response.text().catch(() => "") };
    const error = new Error(payload.error || "The local service could not complete that action.");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return response;
}

function statusErrorMessage(error, messages = {}) {
  const context = messages[error.status];
  const detail = error.payload?.error || error.message;
  return context ? `${context}${detail ? ` ${detail}` : ""}` : detail || "The local service could not complete that action.";
}

const formFeedback = new WeakMap();
const feedbackForms = new WeakSet();
const reportingFormValidity = new WeakSet();

function clearFormError(form, targetId) {
  const feedback = formFeedback.get(form);
  if (feedback?.targetId === targetId) {
    feedback.fields.forEach(({ field, invalid, addedDescription }) => {
      if (invalid === null) field.removeAttribute("aria-invalid");
      else field.setAttribute("aria-invalid", invalid);
      if (addedDescription) {
        const descriptions = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== targetId);
        if (descriptions.length) field.setAttribute("aria-describedby", descriptions.join(" "));
        else field.removeAttribute("aria-describedby");
      }
    });
    formFeedback.delete(form);
  }
  const target = document.getElementById(targetId);
  if (target) {
    target.textContent = "";
    target.hidden = true;
  }
}

function formErrorField(form, path) {
  if (typeof path !== "string" || !path) return null;
  const prefix = `${form.id.replace(/-form$/, "")}.`;
  const name = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const lesson = /^lessons(?:\[(\d+)\]|\.(\d+))\.(title|summary|content|duration_minutes)$/.exec(name);
  if (lesson) {
    const row = $$(".lesson-field", form)[Number(lesson[1] ?? lesson[2])];
    return row ? $$("[data-lesson]", row).find((field) => field.dataset.lesson === lesson[3]) || null : null;
  }
  const matches = [...form.elements].filter((field) => form.contains(field)
    && field.matches("input, select, textarea") && (field.name === name || field.id === name));
  return matches.length === 1 ? matches[0] : null;
}

function renderFormError(form, targetId, message, fields = []) {
  clearFormError(form, targetId);
  const target = document.getElementById(targetId);
  if (!target) return;
  const visibleFields = fields.filter((field) => field && form.contains(field)
    && field.matches("input:not([type=hidden]), select, textarea") && !field.disabled
    && !field.closest("[hidden], [inert]") && field.getClientRects().length);
  const feedback = visibleFields.map((field) => {
    const invalid = field.getAttribute("aria-invalid");
    const descriptions = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    const addedDescription = !descriptions.includes(targetId);
    field.setAttribute("aria-invalid", "true");
    if (addedDescription) field.setAttribute("aria-describedby", [...descriptions, targetId].join(" "));
    return { field, invalid, addedDescription };
  });
  formFeedback.set(form, { targetId, fields: feedback });
  target.textContent = message;
  target.hidden = false;
  target.tabIndex = -1;
  (visibleFields[0] || target).focus();
}

function showFormError(form, targetId, error, message) {
  const field = formErrorField(form, error?.payload?.details?.field ?? error?.details?.field);
  renderFormError(form, targetId, message ?? error?.payload?.error ?? error?.message
    ?? "The local service could not complete that action.", field ? [field] : []);
}

function reportFormValidity(form, targetId) {
  reportingFormValidity.add(form);
  let valid;
  try { valid = form.reportValidity(); } finally { reportingFormValidity.delete(form); }
  if (valid) clearFormError(form, targetId);
  else {
    const fields = [...form.elements].filter((field) => field.willValidate && !field.validity.valid);
    const message = [...new Set(fields.map((field) => field.validationMessage).filter(Boolean))].join(" ");
    renderFormError(form, targetId, message || "Check the highlighted fields before saving.", fields);
  }
  return valid;
}

function setupFormFeedback(form, targetId) {
  if (!form || feedbackForms.has(form)) return;
  feedbackForms.add(form);
  const clearOnEdit = (event) => {
    const feedback = formFeedback.get(form);
    if (!event.target.matches("input, select, textarea") || feedback?.targetId !== targetId) return;
    const fields = feedback.fields.filter(({ field }) => form.contains(field));
    if (!fields.length || fields.some(({ field }) => field === event.target)) clearFormError(form, targetId);
  };
  form.addEventListener("input", clearOnEdit, true);
  form.addEventListener("change", clearOnEdit, true);
  let pendingInvalid = false;
  form.addEventListener("invalid", (event) => {
    event.preventDefault();
    if (reportingFormValidity.has(form) || pendingInvalid) return;
    pendingInvalid = true;
    queueMicrotask(() => {
      pendingInvalid = false;
      reportFormValidity(form, targetId);
    });
  }, true);
}

function beginFormSave(form, label) {
  const busy = form.getAttribute("aria-busy");
  const buttons = $$("button[type=submit], input[type=submit]", form).map((button) => ({
    button, disabled: button.disabled, busy: button.getAttribute("aria-busy"),
    label: button.tagName === "INPUT" ? button.value : button.innerHTML,
  }));
  form.dataset.saving = "true";
  form.setAttribute("aria-busy", "true");
  buttons.forEach(({ button }) => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (button.tagName === "INPUT") button.value = label;
    else button.textContent = label;
  });
  return () => {
    delete form.dataset.saving;
    if (busy === null) form.removeAttribute("aria-busy");
    else form.setAttribute("aria-busy", busy);
    buttons.forEach(({ button, disabled, busy: buttonBusy, label: originalLabel }) => {
      button.disabled = disabled;
      if (buttonBusy === null) button.removeAttribute("aria-busy");
      else button.setAttribute("aria-busy", buttonBusy);
      if (button.tagName === "INPUT") button.value = originalLabel;
      else button.innerHTML = originalLabel;
    });
  };
}

function responseFilename(response, fallback) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const encoded = disposition.match(/filename\*\s*=\s*(?:"?UTF-8'[^']*')([^;"\s]+)/i)?.[1];
  const plain = disposition.match(/filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i);
  let candidate = plain?.[1]?.replace(/\\(.)/g, "$1") || plain?.[2];
  try {
    if (encoded) candidate = decodeURIComponent(encoded);
  } catch { /* A malformed filename must not prevent a download. */ }
  const filename = String(candidate || fallback).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_").trim();
  return filename && filename !== "." && filename !== ".." ? filename : fallback;
}

async function downloadResponse(response, fallback) {
  const filename = responseFilename(response, fallback);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function refresh({ quiet = false, reportError = true } = {}) {
  const requestId = ++refreshRequest;
  const status = $("#refresh-status");
  const statusMessage = $("#refresh-status-message");
  const retry = $("#refresh-retry");
  if (status && statusMessage) {
    status.hidden = false;
    statusMessage.textContent = "Refreshing local workspace…";
    if (retry) retry.hidden = true;
  }
  try {
    const data = await request("/api/bootstrap");
    if (requestId !== refreshRequest) return false;
    state.data = data;
    state.progress = data.progress_summary || null;
    if (!state.calendarAnchor) state.calendarAnchor = workspaceToday();
    render();
    if (state.activeModal === "progress-summary-modal" && state.progress) {
      renderProgressSummary(state.progress);
    }
    if (status) status.hidden = true;
    return true;
  } catch (error) {
    if (requestId !== refreshRequest) return false;
    if (status && statusMessage) {
      status.hidden = false;
      statusMessage.textContent = `Could not refresh the workspace. ${error.message}`;
      if (retry) retry.hidden = false;
    }
    if (reportError) showToast(error.message, "error");
    return false;
  } finally {
    if (!quiet) document.body.classList.remove("is-loading");
  }
}

async function refreshAfterMutation(successMessage) {
  const refreshed = await refresh({ quiet: true, reportError: false });
  if (refreshed) {
    showToast(successMessage);
    return true;
  }
  showToast(`${successMessage} The local change was saved, but the latest workspace data could not be loaded.`, "error");
  return false;
}

function showToast(message, type = "success") {
  const toast = $("#toast");
  const icon = $(".toast-icon", toast);
  $("#toast-message", toast).textContent = message;
  icon.textContent = type === "error" ? "!" : "✓";
  toast.classList.toggle("error", type === "error");
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), type === "error" ? 10000 : 3600);
}

function dateFromISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function workspaceToday() {
  return state.data?.today ? dateFromISO(state.data.today) : new Date();
}

function isoDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function mondayFor(value) {
  const monday = new Date(value);
  const day = monday.getDay();
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function formatShortDate(value, options = {}) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...options }).format(value);
}

function formatLongDate(value) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(value);
}

function initials(name = "Alex Morgan") {
  return name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function render() {
  if (!state.data) return;
  const learner = state.data.learner;
  const firstName = learner.name.split(" ")[0];
  $("#sidebar-learner").textContent = learner.name;
  $("#welcome-name").textContent = firstName;
  const now = workspaceToday();
  $("#today-weekday").textContent = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now).toUpperCase();
  $("#today-label").textContent = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(now).toUpperCase();
  $("#week-summary").textContent = `${state.data.stats.upcoming_sessions} planned moment${state.data.stats.upcoming_sessions === 1 ? "" : "s"}`;
  renderStats();
  renderDashboardCourses();
  renderDashboardSessions();
  renderDashboardGroups();
  renderCourses();
  renderGroups();
  renderCalendar();
  populateSessionForm();
  syncView();
}

function renderStats() {
  const stats = state.data.stats || {};
  const summary = state.data.progress_summary?.summary || {};
  const overall = summary.overall_progress_percent ?? stats.overall_progress ?? 0;
  const completed = summary.lessons_completed ?? stats.completed_lessons ?? 0;
  const enrolled = summary.enrolled_courses ?? stats.enrolled_courses ?? 0;
  const upcoming = summary.upcoming_sessions ?? stats.upcoming_sessions ?? 0;
  $("#stat-progress").textContent = `${overall}%`;
  $("#stat-progress-bar").style.width = `${progressPercent(overall)}%`;
  $("#stat-progress-note").textContent = overall
    ? `${completed} lesson${completed === 1 ? "" : "s"} completed so far.`
    : "Start a course to build momentum.";
  $("#stat-lessons").textContent = completed;
  $("#stat-courses").textContent = enrolled;
  $("#stat-sessions").textContent = upcoming;
}

function progressPayload() {
  return state.progress || null;
}

function progressSummaryValues() {
  const payload = progressPayload();
  const summary = payload?.summary || {};
  const courses = Array.isArray(payload?.courses) ? payload.courses : [];
  const enrolled = courses.filter((course) => course.enrolled === true);
  const completedCourses = courses.filter((course) => course.enrolled === true && course.is_complete === true);
  const lessonsTotal = enrolled.reduce((total, course) => total + Number(course.lesson_count ?? course.total_lessons ?? course.lessons_total ?? 0), 0);
  const lessonsCompleted = enrolled.reduce((total, course) => total + Number(course.completed_count ?? course.completed_lessons ?? course.lessons_completed ?? 0), 0);
  const overall = summary.overall_progress ?? summary.progress_percent ?? summary.percentage
    ?? (lessonsTotal ? Math.round((lessonsCompleted / lessonsTotal) * 100) : 0);
  return {
    summary,
    courses,
    enrolled,
    completedCourses,
    enrolledCount: summary.enrolled_courses ?? summary.courses_enrolled ?? enrolled.length,
    completedCourseCount: summary.completed_courses ?? summary.courses_completed ?? completedCourses.length,
    lessonsCompleted: summary.completed_lessons ?? summary.lessons_completed ?? lessonsCompleted,
    lessonsTotal: summary.total_lessons ?? summary.lessons_total ?? lessonsTotal,
    overall: progressPercent(overall),
  };
}

function progressCourseTitle(course) {
  return course.title || course.course_title || course.name || "Untitled course";
}

function progressNextLesson(course) {
  const next = course.next_lesson || course.next_lesson_title || course.nextLesson;
  return typeof next === "object" && next ? next.title || next.name || "Next lesson" : next;
}

function progressRemaining(course) {
  const explicit = course.remaining_lessons ?? course.lessons_remaining;
  if (explicit !== undefined && explicit !== null) return explicit;
  const total = Number(course.lesson_count ?? course.total_lessons ?? course.lessons_total);
  const completed = Number(course.completed_count ?? course.completed_lessons ?? course.lessons_completed);
  return Number.isFinite(total) && Number.isFinite(completed) ? Math.max(0, total - completed) : null;
}

function renderProgress() {
  const dashboard = $("#dashboard-progress-summary");
  const detail = $("#courses-progress-detail");
  if (!dashboard || !detail) return;
  dashboard.replaceChildren();
  detail.replaceChildren();
  if (state.progressError || !state.progress) {
    const message = state.progressError ? "Progress details are temporarily unavailable." : "Progress details will appear when the local service provides them.";
    [dashboard, detail].forEach((target) => {
      const note = document.createElement("p");
      note.className = "form-hint";
      note.textContent = message;
      target.append(note);
    });
    return;
  }
  const values = progressSummaryValues();
  const dashboardHeading = document.createElement("div");
  dashboardHeading.className = "panel-heading";
  dashboardHeading.innerHTML = '<div><span class="section-kicker">YOUR PROGRESS</span><h2>Momentum at a glance</h2></div><span class="local-only-label">From your local records</span>';
  dashboard.append(dashboardHeading);
  const dashboardStats = document.createElement("div");
  dashboardStats.className = "progress-summary-grid compact-progress-grid";
  appendSummaryStat(dashboardStats, "OVERALL", `${values.overall}%`, "of enrolled lessons");
  appendSummaryStat(dashboardStats, "ENROLLED", values.enrolledCount);
  appendSummaryStat(dashboardStats, "COMPLETED COURSES", values.completedCourseCount);
  appendSummaryStat(dashboardStats, "LESSONS", values.lessonsCompleted, values.lessonsTotal ? `of ${values.lessonsTotal}` : "completed");
  dashboard.append(dashboardStats);

  const detailHeading = document.createElement("div");
  detailHeading.className = "panel-heading";
  detailHeading.innerHTML = '<div><span class="section-kicker">PROGRESS DETAIL</span><h2>Course progress</h2></div>';
  detail.append(detailHeading);
  const detailStats = document.createElement("div");
  detailStats.className = "progress-summary-grid compact-progress-grid";
  appendSummaryStat(detailStats, "OVERALL", `${values.overall}%`);
  appendSummaryStat(detailStats, "ENROLLED", values.enrolledCount);
  appendSummaryStat(detailStats, "COMPLETED COURSES", values.completedCourseCount);
  appendSummaryStat(detailStats, "LESSONS FINISHED", values.lessonsCompleted, values.lessonsTotal ? `of ${values.lessonsTotal}` : "");
  detail.append(detailStats);
  const rows = document.createElement("div");
  rows.className = "progress-course-list";
  values.enrolled.forEach((course) => {
    const row = document.createElement("div");
    row.className = "progress-course-row";
    const title = document.createElement("strong");
    title.textContent = progressCourseTitle(course);
    const percent = progressPercent(course.progress_percent ?? course.overall_progress ?? course.percentage ?? 0);
    const meta = document.createElement("span");
    const next = progressNextLesson(course);
    const remaining = progressRemaining(course);
    meta.textContent = `${percent}% · ${remaining === null ? "Remaining lessons unavailable" : `${remaining} remaining`} ${next ? `· Next: ${next}` : ""}`;
    row.append(title, meta);
    rows.append(row);
  });
  if (!values.enrolled.length) {
    const empty = document.createElement("p");
    empty.className = "form-hint";
    empty.textContent = "No enrolled courses yet.";
    rows.append(empty);
  }
  detail.append(rows);
}

function courseCard(course, compact = false) {
  const lessons = course.lessons || [];
  const nextLesson = nextCourseLesson(course);
  const readableLesson = nextLesson || lessons.find((lesson) => lesson.completed);
  const isComplete = course.is_complete ?? (lessons.length > 0 && lessons.every((lesson) => lesson.completed));
  const cardClass = compact ? "course-card compact-course" : "course-card";
  const lessonsMarkup = lessons.map((lesson) => {
    const { locked } = lessonStatus(course, lesson);
    const hint = prerequisiteHint(course, lesson);
    return `<button class="lesson-row ${lesson.completed ? "done" : ""} ${locked ? "locked" : ""}" data-action="open-lesson" data-lesson-id="${escapeHtml(lesson.id)}" data-course-id="${escapeHtml(course.id)}" ${!lesson.completed && (!course.enrolled || locked) ? "disabled" : ""}>
      <span class="lesson-check" aria-hidden="true">${lesson.completed ? "✓" : locked ? "🔒" : escapeHtml(String(lesson.position).padStart(2, "0"))}</span>
      <span class="lesson-label"><span class="lesson-title">${escapeHtml(lesson.title)}</span>${hint ? `<span class="lesson-hint">${escapeHtml(hint)}</span>` : ""}</span>
      <span class="lesson-time">${escapeHtml(lesson.duration_minutes)}m</span>
    </button>`;
  }).join("");
  const action = course.enrolled
    ? `<button class="button button-small button-coral" data-action="open-lesson" data-lesson-id="${escapeHtml(readableLesson?.id || "")}" data-course-id="${escapeHtml(course.id)}" ${readableLesson ? "" : "disabled"}>${nextLesson ? "Continue" : readableLesson ? "Review" : lessons.length ? "Lessons locked" : "No lessons yet"} <span>→</span></button>`
    : `<button class="button button-small button-dark" data-action="enroll" data-course-id="${escapeHtml(course.id)}">Enroll locally <span>→</span></button>`;
  const accent = safeColor(course.accent);
  const lessonCount = Number.isFinite(Number(course.lesson_count)) ? Number(course.lesson_count) : lessons.length;
  const progress = progressPercent(course.progress_percent);
  return `<article class="${cardClass}" style="--course-accent: ${accent}">
    <div class="course-card-top"><span class="course-tag">${escapeHtml(course.category)}</span><button class="course-edit" title="Edit course" data-action="edit-course" data-course-id="${escapeHtml(course.id)}">✎</button></div>
    <h3>${escapeHtml(course.title)}</h3><p class="course-description">${escapeHtml(course.description)}</p>
    <div class="course-meta"><span>${escapeHtml(course.level)}</span><span>${lessonCount} lessons</span>${course.enrolled ? `<span>${progress}% complete</span>` : ""}</div>
    ${course.enrolled ? `<div class="course-progress"><span style="width: ${progress}%"></span></div>` : `<div class="course-open-line"><span class="open-dot"></span> Ready when you are</div>`}
    <p class="course-rule">${isComplete ? '<span class="completion-badge">✓ Course complete · All lessons finished</span>' : "Complete all lessons to finish this course."}</p>
    ${course.enrolled && nextLesson ? `<p class="next-lesson">Next: ${escapeHtml(nextLesson.title)}</p>` : ""}
    ${compact ? `<div class="card-action-row">${action}</div>` : `<div class="course-lessons">${lessonsMarkup || `<div class="empty-lessons">No lessons yet. Edit the course to add one.</div>`}</div><div class="card-action-row">${action}</div>`}
  </article>`;
}

function renderDashboardCourses() {
  const target = $("#dashboard-courses");
  const courses = filteredCourses().filter((course) => course.enrolled).sort((a, b) => b.progress_percent - a.progress_percent);
  const visible = courses.length ? courses.slice(0, 2) : filteredCourses().slice(0, 2);
  target.innerHTML = visible.length ? visible.map((course) => courseCard(course)).join("") : emptyState("No courses yet", "Create your first learning path to see it here.", "Create course", "open-course-editor");
}

function renderDashboardSessions() {
  const target = $("#dashboard-sessions");
  const sessions = state.data.sessions.filter(sessionIsUpcoming).slice(0, 3);
  target.innerHTML = sessions.length ? sessions.map(sessionRow).join("") : `<div class="empty-inline"><span class="empty-symbol">◷</span><div><strong>No sessions planned yet</strong><p>Give your next study moment a home.</p><button class="text-button" data-open-session-editor>Plan a session <span>→</span></button></div></div>`;
}

function sessionIsUpcoming(session) {
  const now = state.data?.now_utc ? Date.parse(state.data.now_utc) : Date.now();
  return session.status !== "cancelled" && (!session.start_utc || Date.parse(session.start_utc) >= now);
}

function sessionRow(session, detailsAction = false) {
  const day = dateFromISO(session.session_date);
  const zone = session.timezone || session.time_zone || "UTC";
  const duration = Number.isFinite(Number(session.duration_minutes)) ? Number(session.duration_minutes) : 0;
  const action = detailsAction
    ? `<button class="session-arrow" data-action="open-session-details" data-session-id="${escapeHtml(session.id)}" aria-label="View details for ${escapeHtml(session.title)}">→</button>`
    : `<button class="session-arrow" data-navigate="calendar" aria-label="View calendar">→</button>`;
  return `<div class="session-row"><div class="date-block"><strong>${day.toLocaleDateString("en-US", { day: "2-digit" })}</strong><span>${day.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</span></div><div class="session-main"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.start_time)} · ${duration} min · ${escapeHtml(session.group_name)} · ${escapeHtml(zone)}</span></div><button class="session-cancel" data-action="cancel-session" data-session-id="${escapeHtml(session.id)}" title="Cancel session" aria-label="Cancel ${escapeHtml(session.title)}">×</button>${action}</div>`;
}

function renderDashboardGroups() {
  const target = $("#dashboard-groups");
  const groups = state.data.groups.filter((group) => group.joined).slice(0, 3);
  target.innerHTML = groups.length ? groups.map(groupRow).join("") : `<div class="empty-inline"><span class="empty-symbol">◎</span><div><strong>Find a study group</strong><p>Learning is easier with a little company.</p><button class="text-button" data-navigate="groups">Browse groups <span>→</span></button></div></div>`;
}

function groupRow(group) {
  return `<div class="group-row"><div class="group-avatar" style="--group-color: ${safeColor(group.color, "#19c3a3")}">${escapeHtml(String(group.name || "G").slice(0, 1).toUpperCase())}</div><div class="group-row-info"><strong>${escapeHtml(group.name)}</strong><span>${Number(group.member_count) || 0} member${Number(group.member_count) === 1 ? "" : "s"}</span></div><button class="group-discussion-link" data-action="open-discussion" data-group-id="${escapeHtml(group.id)}">Discussion <span>→</span></button></div>`;
}

function renderCourses() {
  const target = $("#library-courses");
  let courses = filteredCourses();
  if (state.courseFilter === "enrolled") courses = courses.filter((course) => course.enrolled);
  if (state.courseFilter === "available") courses = courses.filter((course) => !course.enrolled);
  $("#course-count").textContent = `${courses.length} course${courses.length === 1 ? "" : "s"}`;
  target.innerHTML = courses.length ? courses.map((course) => courseCard(course)).join("") : emptyState("Nothing here yet", "Try another filter or create a new course.", "Create course", "open-course-editor");
  $$(".filter-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.filter === state.courseFilter));
}

function filteredCourses() {
  return [...(state.data?.courses || [])];
}

function renderGroups() {
  const target = $("#groups-directory");
  target.innerHTML = state.data.groups.length
    ? state.data.groups.map((group) => `<article class="group-card" style="--group-color: ${safeColor(group.color, "#19c3a3")}"><div class="group-card-top"><div class="group-avatar large">${escapeHtml(String(group.name || "G").slice(0, 1).toUpperCase())}</div><span class="group-status ${group.joined ? "joined" : ""}">${group.joined ? "Joined" : "Open to join"}</span></div><h2>${escapeHtml(group.name)}</h2><p>${escapeHtml(group.description)}</p><div class="group-card-footer"><span>${Number(group.member_count) || 0} member${Number(group.member_count) === 1 ? "" : "s"}</span><div class="group-card-actions"><button class="text-button" data-action="open-discussion" data-group-id="${escapeHtml(group.id)}">Discussion <span>→</span></button>${group.joined ? `<button class="text-button" data-open-session-editor data-group-id="${escapeHtml(group.id)}">Plan a session <span>→</span></button>` : `<button class="button button-small button-dark" data-action="join-group" data-group-id="${escapeHtml(group.id)}">Join group <span>→</span></button>`}</div></div></article>`).join("")
    : emptyState("No study groups yet", "Create a group to make your next study step easier to keep.", "Create group", "open-group-editor");
}

function postAuthor(post) {
  if (typeof post.author === "object" && post.author) return post.author.name || post.author.display_name || "Group member";
  return post.author_name || post.learner_name || post.user_name || post.display_name || post.author || "Group member";
}

function postTimestamp(post) {
  const value = post.created_at || post.timestamp || post.posted_at || post.created || "";
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function postBelongsToLearner(post) {
  if (!state.activeGroup?.joined) return false;
  if (post.can_delete === true || post.can_edit === true || post.is_mine === true || post.own === true) return true;
  const authorId = post.learner_id ?? post.author_id ?? post.user_id ?? post.author?.id;
  return authorId != null && state.data?.learner?.id !== undefined && Number(authorId) === Number(state.data.learner.id);
}

function renderDiscussionPosts() {
  const target = $("#discussion-posts");
  target.replaceChildren();
  if (!state.discussionPosts.length) {
    const empty = document.createElement("div");
    empty.className = "discussion-empty";
    empty.textContent = "No posts yet. Start the conversation with a question or a small update.";
    target.append(empty);
    return;
  }
  state.discussionPosts.forEach((post) => {
    const article = document.createElement("article");
    article.className = "discussion-post";
    const header = document.createElement("div");
    header.className = "discussion-post-header";
    const author = document.createElement("strong");
    author.textContent = postAuthor(post);
    const timestamp = document.createElement("time");
    timestamp.textContent = postTimestamp(post);
    if (post.updated_at && post.updated_at !== post.created_at) {
      timestamp.textContent += ` · edited ${postTimestamp({ created_at: post.updated_at })}`;
    }
    if (post.created_at || post.timestamp || post.posted_at) timestamp.dateTime = String(post.created_at || post.timestamp || post.posted_at);
    header.append(author, timestamp);
    const body = document.createElement("p");
    body.textContent = post.body || post.content || "";
    article.append(header, body);
    if (postBelongsToLearner(post) && post.id !== undefined) {
      const footer = document.createElement("div");
      footer.className = "discussion-post-footer";
      const remove = document.createElement("button");
      remove.className = "text-button danger-button";
      remove.type = "button";
      remove.dataset.action = "delete-post";
      remove.dataset.postId = post.id;
      remove.textContent = "Delete post";
      footer.append(remove);
      article.append(footer);
    }
    target.append(article);
  });
}

function discussionErrorMessage(error, action = "load") {
  const messages = action === "delete"
    ? { 400: "That post could not be deleted.", 403: "You can only delete your own posts in this group.", 404: "That post or group could not be found.", 409: "The discussion changed before the post could be deleted." }
    : action === "post"
      ? { 400: "Write a post before sending it.", 403: "Join this group before posting in its discussion.", 404: "This study group could not be found.", 409: "Your post could not be added because the discussion changed." }
      : { 400: "The discussion request was invalid.", 403: "You must be a member of this group to view its discussion.", 404: "This study group could not be found.", 409: "The discussion is temporarily unavailable; please try again." };
  return statusErrorMessage(error, messages);
}

async function loadDiscussion() {
  if (!state.activeGroup) return;
  const groupId = state.activeGroup.id;
  const requestId = ++discussionRequest;
  const target = $("#discussion-posts");
  const errorTarget = $("#discussion-error");
  errorTarget.hidden = true;
  target.replaceChildren();
  if (!state.activeGroup.joined) return false;
  const loading = document.createElement("p");
  loading.className = "discussion-loading";
  loading.textContent = "Loading discussion…";
  target.append(loading);
  try {
    const payload = await request(`/api/groups/${encodeURIComponent(groupId)}/posts`);
    if (requestId !== discussionRequest || Number(state.activeGroup?.id) !== Number(groupId)) return;
    if (payload.group) {
      state.activeGroup = { ...state.activeGroup, ...payload.group };
      setDiscussionAccess(state.activeGroup);
      $("#discussion-group-label").textContent = state.activeGroup.name;
    }
    state.discussionPosts = Array.isArray(payload) ? payload : payload.posts || payload.data || [];
    if (!Array.isArray(state.discussionPosts)) state.discussionPosts = [];
    renderDiscussionPosts();
    return true;
  } catch (error) {
    if (requestId !== discussionRequest || Number(state.activeGroup?.id) !== Number(groupId)) return;
    target.replaceChildren();
    errorTarget.textContent = discussionErrorMessage(error);
    errorTarget.hidden = false;
    return false;
  }
}

function setDiscussionAccess(group) {
  $("#discussion-form").hidden = !group.joined;
  $("#discussion-join-note").hidden = !!group.joined;
  $("#discussion-join-button").dataset.groupId = group.id;
  $("#discussion-composer-note").textContent = group.joined
    ? "Posts are visible to group members."
    : "Join this group to post in its discussion.";
}

function openDiscussion(groupId) {
  const group = getGroup(groupId);
  if (!group) {
    showToast("This study group could not be found.", "error");
    return;
  }
  state.activeGroup = group;
  state.discussionPosts = [];
  $("#discussion-title").textContent = "Discussion";
  $("#discussion-group-label").textContent = group.name;
  setDiscussionAccess(group);
  openModal("discussion-modal");
  loadDiscussion();
}

async function saveDiscussionPost(event) {
  event.preventDefault();
  if (!state.activeGroup?.joined) return;
  const form = event.currentTarget;
  if (form.dataset.saving === "true" || !reportFormValidity(form, "discussion-error")) return;
  if (!form.elements.body.value.trim()) {
    showFormError(form, "discussion-error", { details: { field: "body" } }, "Write a post before sending it.");
    return;
  }
  const groupId = state.activeGroup.id;
  const finishSaving = beginFormSave(form, "Posting…");
  try {
    try {
      await request(`/api/groups/${encodeURIComponent(groupId)}/posts`, {
        method: "POST",
        body: JSON.stringify({ body: form.elements.body.value.trim() }),
      });
    } catch (error) {
      if (Number(state.activeGroup?.id) === Number(groupId)) {
        showFormError(form, "discussion-error", error, discussionErrorMessage(error, "post"));
      }
      return;
    }
    if (Number(state.activeGroup?.id) === Number(groupId)) {
      form.reset();
      const loaded = await loadDiscussion();
      showToast(loaded === false ? "Post saved. Refresh posts to reload the discussion." : "Your post was added to the discussion.");
    }
  } finally {
    finishSaving();
  }
}

async function deleteDiscussionPost(postId) {
  const post = state.discussionPosts.find((item) => String(item.id) === String(postId));
  if (!state.activeGroup || !post || !postBelongsToLearner(post) || !window.confirm("Delete your post from this discussion?")) return;
  const groupId = state.activeGroup.id;
  const buttons = $$('[data-action="delete-post"]').filter((button) => button.dataset.postId === String(postId));
  if (buttons.some((button) => button.disabled)) return;
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await request(`/api/groups/${encodeURIComponent(groupId)}/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
    if (Number(state.activeGroup?.id) === Number(groupId)) {
      const loaded = await loadDiscussion();
      showToast(loaded === false ? "Post deleted. Refresh posts to reload the discussion." : "Post deleted.");
    }
  } catch (error) {
    if (Number(state.activeGroup?.id) !== Number(groupId)) return;
    $("#discussion-error").textContent = discussionErrorMessage(error, "delete");
    $("#discussion-error").hidden = false;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function summaryValue(summary, keys, fallback = 0) {
  for (const key of keys) {
    if (summary?.[key] !== undefined && summary[key] !== null) return summary[key];
  }
  return fallback;
}

function appendSummaryStat(target, label, value, note = "") {
  const card = document.createElement("div");
  card.className = "progress-summary-stat";
  const labelNode = document.createElement("span");
  labelNode.className = "section-kicker";
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = String(value);
  card.append(labelNode, valueNode);
  if (note) {
    const noteNode = document.createElement("small");
    noteNode.textContent = note;
    card.append(noteNode);
  }
  target.append(card);
}

function renderProgressSummary(payload) {
  const summary = payload?.summary || payload?.progress || payload || {};
  const courses = Array.isArray(payload?.courses) ? payload.courses : (Array.isArray(summary.courses) ? summary.courses : []);
  const recent = Array.isArray(payload?.recent_completed_lessons)
    ? payload.recent_completed_lessons
    : (Array.isArray(summary.recent_completed_lessons) ? summary.recent_completed_lessons : []);
  const stats = $("#progress-summary-stats");
  const nextTarget = $("#progress-summary-next");
  const recentTarget = $("#progress-summary-recent");
  stats.replaceChildren();
  nextTarget.replaceChildren();
  recentTarget.replaceChildren();
  const totals = { ...summary, ...(summary.stats || {}), ...(typeof summary.overall === "object" ? summary.overall : {}) };
  const overall = summaryValue(totals, ["overall_progress", "overall_progress_percent", "overall_percentage", "progress_percent", "percentage"], null);
  const completedLessons = summaryValue(totals, ["completed_lessons", "completed_lesson_count", "lessons_completed"], "—");
  const enrolledCourses = summaryValue(totals, ["enrolled_courses", "enrolled_course_count", "courses_enrolled"], "—");
  const completedCourses = summaryValue(totals, ["completed_courses", "completed_course_count", "courses_completed"], "—");
  const upcomingSessions = summaryValue(totals, ["upcoming_sessions", "upcoming_session_count"], "—");
  const activeGroups = summaryValue(totals, ["active_groups", "groups_active"], "—");
  appendSummaryStat(stats, "OVERALL", overall === null ? "—" : `${progressPercent(overall)}%`, "of enrolled lessons");
  appendSummaryStat(stats, "LESSONS COMPLETED", completedLessons);
  appendSummaryStat(stats, "COURSES ENROLLED", enrolledCourses);
  appendSummaryStat(stats, "COURSES COMPLETED", completedCourses);
  appendSummaryStat(stats, "UPCOMING SESSIONS", upcomingSessions);
  appendSummaryStat(stats, "ACTIVE GROUPS", activeGroups);
  const nextCourse = courses.find((course) => course.enrolled && !course.course_complete && course.next_lesson);
  const note = document.createElement("p");
  note.className = "progress-next-note";
  if (nextCourse) {
    note.textContent = `Next lesson: ${nextCourse.next_lesson.title} · ${nextCourse.title} · ${nextCourse.remaining_count} remaining`;
  } else {
    note.textContent = "No unlocked next lesson is waiting right now.";
  }
  nextTarget.append(note);
  if (!recent.length) {
    const empty = document.createElement("p");
    empty.className = "form-hint";
    empty.textContent = "Complete a lesson to see it here.";
    recentTarget.append(empty);
    return;
  }
  recent.forEach((item) => {
    const entry = document.createElement("p");
    entry.className = "progress-recent-item";
    const completedAt = item.completed_at ? new Date(item.completed_at).toLocaleDateString([], { dateStyle: "medium" }) : "recently";
    entry.textContent = `${item.title} · ${item.course_title} · ${completedAt}`;
    recentTarget.append(entry);
  });
}

async function openProgressSummary() {
  const requestId = ++summaryRequest;
  $("#progress-summary-error").hidden = true;
  $("#progress-summary-stats").replaceChildren();
  $("#progress-summary-next").replaceChildren();
  const loading = document.createElement("p");
  loading.className = "form-hint";
  loading.textContent = "Loading your progress…";
  $("#progress-summary-next").append(loading);
  openModal("progress-summary-modal");
  try {
    const payload = await request("/api/progress");
    if (requestId !== summaryRequest || state.activeModal !== "progress-summary-modal") return;
    renderProgressSummary(payload);
  } catch (error) {
    if (requestId !== summaryRequest || state.activeModal !== "progress-summary-modal") return;
    $("#progress-summary-next").replaceChildren();
    $("#progress-summary-error").textContent = statusErrorMessage(error, { 400: "The progress summary request was invalid.", 404: "Progress summaries are not available in this workspace." });
    $("#progress-summary-error").hidden = false;
  }
}

async function exportWorkspace(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $("button[type=submit]", form);
  if (submit.disabled) return;
  const errorTarget = $("#export-error");
  errorTarget.hidden = true;
  submit.disabled = true;
  try {
    const format = form.elements.format.value;
    if (!["json", "csv"].includes(format)) throw new Error("Choose a valid export format.");
    const path = format === "json" ? "/api/export.json" : "/api/export.csv";
    const response = await requestBlob(path);
    await downloadResponse(response, `study-workspace-export.${format}`);
    if (state.activeModal === "export-modal") closeModals();
    showToast(`${format.toUpperCase()} export downloaded.`);
  } catch (error) {
    errorTarget.textContent = statusErrorMessage(error, { 400: "Choose a valid export format.", 404: "Export is not available in this workspace." });
    errorTarget.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

async function downloadBackup() {
  const button = $("#download-backup");
  if (button.disabled) return;
  const errorTarget = $("#backup-error");
  errorTarget.hidden = true;
  button.disabled = true;
  try {
    const response = await requestBlob("/api/backup");
    await downloadResponse(response, "study-workspace.sqlite");
    showToast("Workspace backup downloaded.");
  } catch (error) {
    const message = statusErrorMessage(error, { 404: "Backup is not available in this workspace." });
    errorTarget.textContent = message;
    errorTarget.hidden = false;
    showToast(message, "error");
  } finally {
    button.disabled = false;
  }
}

function restoreErrorMessage(error) {
  return statusErrorMessage(error, { 400: "That file is not a valid workspace backup.", 413: "This backup is too large for the local service." });
}

async function parseAndValidateBackup() {
  const file = $("#restore-file").files[0];
  const errorTarget = $("#restore-error");
  const countsTarget = $("#restore-counts");
  const confirmTarget = $("#restore-confirm");
  errorTarget.hidden = true;
  countsTarget.hidden = true;
  confirmTarget.disabled = true;
  state.pendingBackupFile = null;
  if (!file) throw new Error("Choose a SQLite backup file first.");
  if (!/\.(sqlite|sqlite3|db)$/i.test(file.name)) throw new Error("Choose a .sqlite, .sqlite3, or .db backup file.");
  if (file.size === 0 || file.size > 50 * 1024 * 1024) throw new Error(file.size === 0 ? "The selected backup file is empty." : "Choose a backup file smaller than 50 MB.");
  state.pendingBackupFile = file;
  countsTarget.replaceChildren();
  countsTarget.textContent = `Selected ${file.name} (${Math.ceil(file.size / 1024)} KB). The service will validate it before replacement.`;
  countsTarget.hidden = false;
  $("#restore-confirmation").textContent = "Confirm to upload and validate this SQLite backup, then replace the current local workspace.";
  $("#restore-confirmation").hidden = false;
  confirmTarget.disabled = false;
}

async function restoreWorkspace() {
  if (state.restoring) return;
  const errorTarget = $("#restore-error");
  errorTarget.hidden = true;
  if (!state.pendingBackupFile) {
    try { await parseAndValidateBackup(); } catch (error) { errorTarget.textContent = restoreErrorMessage(error); errorTarget.hidden = false; }
    return;
  }
  if (!window.confirm("Restore this validated backup? It will replace the current local workspace.")) return;
  const submit = $("#restore-confirm");
  const closeButtons = $$('[data-close-modal]', $("#settings-modal"));
  const fileInput = $("#restore-file");
  state.restoring = true;
  submit.disabled = true;
  fileInput.disabled = true;
  $("#download-backup").disabled = true;
  closeButtons.forEach((button) => { button.disabled = true; });
   submit.textContent = "Restoring workspace…";
   try {
      const raw = await state.pendingBackupFile.arrayBuffer();
      await requestBlob("/api/restore", {
        method: "POST",
        body: raw,
        headers: { "Content-Type": "application/x-sqlite3" },
      });
    state.activeCourse = null;
    state.activeLesson = null;
    state.activeGroup = null;
    state.discussionPosts = [];
    state.calendarAnchor = null;
    $("#course-form").reset();
    $("#lesson-fields").replaceChildren();
    $("#session-form").reset();
    $("#group-form").reset();
    $("#discussion-form").reset();
    $("#discussion-posts").replaceChildren();
    $("#progress-summary-stats").replaceChildren();
     $("#progress-summary-next").replaceChildren();
    const refreshed = await refresh({ quiet: true, reportError: false });
    showToast(refreshed ? "Workspace restored. All local data has been refreshed." : "Workspace restored, but the refreshed workspace could not be loaded.", refreshed ? "success" : "error");
     $("#restore-form").reset();
      state.pendingBackupFile = null;
    state.restoring = false;
    if (refreshed) closeModals();
    else {
      errorTarget.textContent = "The backup was restored, but the workspace could not be reloaded. Close this panel and use Refresh data to try again.";
      errorTarget.hidden = false;
    }
  } catch (error) {
    errorTarget.textContent = restoreErrorMessage(error);
    errorTarget.hidden = false;
  } finally {
    state.restoring = false;
    submit.disabled = false;
     submit.textContent = "Restore this backup →";
    fileInput.disabled = false;
    $("#download-backup").disabled = false;
    closeButtons.forEach((button) => { button.disabled = false; });
  }
}

function emptyState(title, message, actionLabel, action) {
  return `<div class="empty-state"><span class="empty-orb">✦</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p><button class="button button-dark" data-action="${action}">${escapeHtml(actionLabel)} <span>→</span></button></div>`;
}

function filterCalendarSessions(sessions, groups, learnerFilter = "all", courseFilter = "all") {
  const joinedGroupIds = new Set(groups.filter((group) => group.joined).map((group) => Number(group.id)));
  return sessions.filter((session) => {
    if (session.status === "cancelled") return false;
    if (learnerFilter === "mine" && !joinedGroupIds.has(Number(session.group_id))) return false;
    if (courseFilter === "none" && session.course_id != null) return false;
    if (courseFilter !== "all" && courseFilter !== "none"
      && Number(session.course_id) !== Number(courseFilter)) return false;
    return true;
  });
}

function calendarVisibleSessions() {
  return filterCalendarSessions(
    state.data?.sessions || [],
    state.data?.groups || [],
    state.calendarLearnerFilter,
    state.calendarCourseFilter,
  );
}

function populateCalendarFilters() {
  const courseFilter = $("#calendar-course-filter");
  if (!courseFilter || !state.data) return;
  const current = state.calendarCourseFilter;
  courseFilter.innerHTML = `<option value="all">All courses</option><option value="none">No related course</option>${state.data.courses.map((course) => `<option value="${escapeHtml(course.id)}">${escapeHtml(course.title)}</option>`).join("")}`;
  state.calendarCourseFilter = current === "all" || current === "none"
    || state.data.courses.some((course) => String(course.id) === String(current)) ? current : "all";
  courseFilter.value = state.calendarCourseFilter;
  $("#calendar-learner-filter").value = state.calendarLearnerFilter;
}

function renderCalendarAgenda(sessions) {
  const target = $("#calendar-agenda-list");
  if (!target) return;
  target.innerHTML = sessions.length
    ? sessions.slice().sort((a, b) => a.start_utc.localeCompare(b.start_utc)).map((session) => `<li>${sessionRow(session, true)}</li>`).join("")
    : `<li class="agenda-empty">No sessions match these filters this week.</li>`;
}

function renderCalendar() {
  if (!state.data) return;
  populateCalendarFilters();
  const monday = mondayFor(state.calendarAnchor);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return day;
  });
  const today = workspaceToday();
  const thisMonday = mondayFor(today);
  const sameWeek = monday.getTime() === thisMonday.getTime();
  const weekLabel = sameWeek ? "This week" : `${formatShortDate(days[0])} — ${formatShortDate(days[6])}`;
  $("#calendar-week-label").textContent = weekLabel;
  $("#calendar-jump-date").value = isoDate(monday);
  $("#calendar-head").innerHTML = `<div class="calendar-time-head"></div>${days.map((day) => `<div class="calendar-day-head ${isoDate(day) === isoDate(today) ? "today" : ""}" aria-label="${escapeHtml(day.toLocaleDateString("en-US", { dateStyle: "full" }))}"><span>${day.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()}</span><strong>${day.getDate()}</strong></div>`).join("")}`;

  const firstHour = 0;
  const hours = Array.from({ length: 24 }, (_, index) => firstHour + index);
  const sessionsByDay = new Map();
  const visibleSessions = calendarVisibleSessions();
  visibleSessions.filter((session) => days.some((day) => isoDate(day) === session.session_date)).forEach((session) => {
    const index = days.findIndex((day) => isoDate(day) === session.session_date);
    if (index >= 0) {
      if (!sessionsByDay.has(index)) sessionsByDay.set(index, []);
      sessionsByDay.get(index).push(session);
    }
  });
  $("#calendar-body").innerHTML = `<div class="calendar-time-column">${hours.map((hour) => `<div class="time-label">${formatHour(hour)}</div>`).join("")}</div><div class="calendar-columns">${days.map((day, dayIndex) => `<div class="calendar-day-column" aria-label="${escapeHtml(day.toLocaleDateString("en-US", { dateStyle: "full" }))}"><div class="calendar-slots">${hours.map(() => "<div class=\"calendar-slot\"></div>").join("")}</div>${layoutSessions(sessionsByDay.get(dayIndex) || []).map((item) => calendarEvent(item.session, firstHour, item.lane, item.laneCount)).join("")}</div>`).join("")}</div>`;
  const weekSessions = visibleSessions.filter((session) => days.some((day) => isoDate(day) === session.session_date));
  const filterLabel = state.calendarLearnerFilter === "mine" || state.calendarCourseFilter !== "all" ? " with the selected filters" : "";
  $("#calendar-status").textContent = `${weekSessions.length} session${weekSessions.length === 1 ? "" : "s"} shown${filterLabel}.`;
  const empty = $("#calendar-empty");
  empty.hidden = weekSessions.length > 0;
  if (!weekSessions.length) {
    empty.innerHTML = `<strong>No sessions planned ${sameWeek ? "this week" : "for this week"}${filterLabel}.</strong> <span>Choose another week or plan a session.</span> <button type="button" class="text-button" data-open-session-editor>Plan a session <span>→</span></button>`;
  }
  renderCalendarAgenda(weekSessions);
}

function formatHour(hour) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 || 12;
  return `${display} ${suffix}`;
}

function layoutSessions(sessions) {
  const lanes = [];
  const items = [];
  [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id - b.id).forEach((session) => {
    const [hour, minute] = session.start_time.split(":").map(Number);
    const start = hour * 60 + minute;
    const end = start + session.duration_minutes;
    let lane = lanes.findIndex((laneEnd) => laneEnd <= start);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = end;
    items.push({ session, lane });
  });
  return items.map((item) => ({ ...item, laneCount: Math.max(1, lanes.length) }));
}

function calendarEvent(session, firstHour, lane = 0, laneCount = 1) {
  const [hour, minute] = session.start_time.split(":").map(Number);
  const height = Math.max(42, (session.duration_minutes / 60) * 56 - 5);
  const top = Math.max(0, Math.min(((hour + minute / 60) - firstHour) * 56, 24 * 56 - height));
  const left = (lane * 100) / laneCount;
  const width = 100 / laneCount;
  const color = session.course_title?.toLowerCase().includes("data") ? "mint" : safeColor(session.group_color) === "#ffb547" ? "gold" : "violet";
  const duration = Number.isFinite(Number(session.duration_minutes)) ? Number(session.duration_minutes) : 0;
  const zone = session.timezone || session.time_zone || "UTC";
  const detail = `${session.title} · ${session.group_name} · ${session.session_date} ${session.start_time} · ${zone}${session.notes ? ` · ${session.notes}` : ""}`;
  return `<div class="calendar-event ${color}" style="top: ${top}px; min-height: ${height}px; left: calc(${left}% + 5px); width: calc(${width}% - 10px); right: auto" aria-label="${escapeHtml(detail)}"><button type="button" class="calendar-event-details" data-action="open-session-details" data-session-id="${escapeHtml(session.id)}" aria-label="View details for ${escapeHtml(session.title)}"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.start_time)} · ${duration}m</span><span class="calendar-event-zone">${escapeHtml(zone)}</span></button><button type="button" class="calendar-event-cancel" data-action="cancel-session" data-session-id="${escapeHtml(session.id)}" title="Cancel session (keep local record)" aria-label="Cancel ${escapeHtml(session.title)}">×</button></div>`;
}

function openSessionDetails(sessionId) {
  const session = state.data?.sessions.find((item) => String(item.id) === String(sessionId));
  if (!session) return;
  state.activeSession = session;
  const zone = session.timezone || session.time_zone || "UTC";
  const content = $("#session-details-content");
  content.replaceChildren();
  const details = [
    ["When", `${session.session_date} at ${session.start_time} · ${zone}`],
    ["Group", session.group_name || "Study group"],
    ["Duration", `${session.duration_minutes} minutes`],
  ];
  const list = document.createElement("dl");
  details.forEach(([label, value]) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    list.append(term, description);
  });
  content.append(list);
  if (session.notes) {
    const notes = document.createElement("p");
    notes.textContent = session.notes;
    content.append(notes);
  }
  $("#session-details-title").textContent = session.title;
  $("#session-details-cancel").hidden = session.status === "cancelled";
  openModal("session-details-modal");
}

function populateSessionForm() {
  const groupSelect = $("#session-group");
  const courseSelect = $("#session-course");
  if (!groupSelect || !courseSelect || !state.data) return;
  const currentGroup = groupSelect.value;
  const currentCourse = courseSelect.value;
  const joinedGroups = state.data.groups.filter((group) => group.joined);
  groupSelect.innerHTML = joinedGroups.length
    ? joinedGroups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("")
    : `<option value="" disabled selected>Join or create a group first</option>`;
  courseSelect.innerHTML = `<option value="">No specific course</option>${state.data.courses.map((course) => `<option value="${escapeHtml(course.id)}">${escapeHtml(course.title)}</option>`).join("")}`;
  if (joinedGroups.some((group) => String(group.id) === currentGroup)) groupSelect.value = currentGroup;
  if (state.data.courses.some((course) => String(course.id) === currentCourse)) courseSelect.value = currentCourse;
  groupSelect.disabled = !joinedGroups.length;
  $("#session-group-hint").textContent = joinedGroups.length
    ? "Only groups you have joined can be scheduled."
    : "Join a study group or create one before planning a session.";
  // A session's local date may differ from the workspace UTC date.
  $("#session-date").removeAttribute("min");
  $("#session-date-hint").textContent = "Date in the selected time zone; the calendar preserves the entered date and clock.";
  updateSessionValidation();
}

function updateSessionValidation() {
  const form = $("#session-form");
  const fields = form.elements;
  [fields.group_id, fields.session_date, fields.start_time, fields.timezone, fields.duration_minutes].forEach((field) => field.setCustomValidity(""));
  const errors = [];
  const invalid = (field, message) => { field.setCustomValidity(message); errors.push(message); };
  const hasGroup = !!getGroup(fields.group_id.value)?.joined;
  if (!hasGroup) invalid(fields.group_id, "Join or create a study group before scheduling a session.");
  const time = fields.start_time.value;
  try {
    const zone = fields.timezone.value.trim();
    if (!zone) throw new Error("Empty time zone");
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    invalid(fields.timezone, "Enter an IANA time zone such as UTC or America/New_York.");
  }
  const duration = Number(fields.duration_minutes.value);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) invalid(fields.start_time, "Use a valid local time in HH:MM format.");
  if (fields.duration_minutes.value && (!Number.isInteger(duration) || duration < 15 || duration > 480)) {
    invalid(fields.duration_minutes, "Choose a duration of 15–480 whole minutes.");
  }
  const message = $("#session-validation");
  if (formFeedback.get(form)?.targetId !== "session-validation") {
    message.textContent = errors.join(" ");
    message.hidden = !errors.length;
  }
  $("button[type=submit]", form).disabled = !hasGroup || form.dataset.saving === "true";
}

function syncView() {
  $$(".page-view").forEach((page) => page.classList.toggle("active", page.dataset.page === state.view));
  $$(".nav-item").forEach((item) => {
    const active = item.dataset.view === state.view;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const label = { dashboard: "Overview", courses: "Courses", calendar: "Calendar", groups: "Study groups" }[state.view] || "Overview";
  $("#breadcrumb-current").textContent = label;
  document.body.classList.toggle("dashboard-view", state.view === "dashboard");
  setMobileNavigation(false);
}

function navigate(view) {
  state.view = ["dashboard", "courses", "calendar", "groups"].includes(view) ? view : "dashboard";
  if (window.location.hash !== `#${state.view}`) history.pushState(null, "", `#${state.view}`);
  syncView();
}

function syncLocation() {
  const hash = window.location.hash.replace("#", "");
  state.view = ["dashboard", "courses", "calendar", "groups"].includes(hash) ? hash : "dashboard";
  syncView();
}

function openModal(id) {
  if (state.restoring) return;
  clearTimeout(modalCloseTimer);
  if (!state.activeModal) modalTrigger = document.activeElement;
  $$(".modal").forEach((item) => {
    if (item.id !== id) {
      item.hidden = true;
      item.classList.remove("show");
    }
  });
  state.activeModal = id;
  $("#modal-backdrop").hidden = false;
  $("#modal-backdrop").classList.add("show");
  const modal = $(`#${id}`);
  modal.hidden = false;
  modal.tabIndex = -1;
  requestAnimationFrame(() => {
    if (state.activeModal !== id) return;
    modal.classList.add("show");
    ($( "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)", modal) || modal).focus();
  });
  $(".app-shell").inert = true;
  document.body.classList.add("modal-open");
}

function closeModals() {
  if (state.restoring || !state.activeModal) return;
  clearTimeout(modalCloseTimer);
  state.activeModal = null;
  discussionRequest++;
  summaryRequest++;
  $$(".modal.show").forEach((modal) => modal.classList.remove("show"));
  $("#modal-backdrop").classList.remove("show");
  modalCloseTimer = setTimeout(() => {
    $$(".modal").forEach((modal) => { modal.hidden = true; });
    $("#modal-backdrop").hidden = true;
    (modalTrigger?.isConnected ? modalTrigger : $("#refresh-button")).focus();
    modalTrigger = null;
  }, 180);
  $(".app-shell").inert = false;
  document.body.classList.remove("modal-open");
  state.activeLesson = null;
  state.activeGroup = null;
  state.activeSession = null;
}

function handleModalKeydown(event) {
  if (!state.activeModal && event.key === "Escape" && $("#workspace-sidebar")?.classList.contains("mobile-open")) {
    event.preventDefault();
    setMobileNavigation(false);
    return;
  }
  if (!state.activeModal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeModals();
    return;
  }
  if (event.key !== "Tab") return;
  const modal = document.getElementById(state.activeModal);
  const controls = $$("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex='0']", modal)
    .filter((element) => element.getClientRects().length);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first) {
    event.preventDefault();
    modal.focus();
  } else if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

let lessonFieldSequence = 0;

function lessonPrerequisiteReferences(lesson = {}) {
  const ids = [];
  const addId = (value) => {
    const id = typeof value === "object" && value ? value.id : value;
    if (id !== undefined && id !== null && id !== "") ids.push(String(id));
  };
  if (Array.isArray(lesson.prerequisite_ids)) lesson.prerequisite_ids.forEach(addId);
  if (Array.isArray(lesson.prerequisites)) lesson.prerequisites.forEach(addId);
  const positions = Array.isArray(lesson.prerequisite_positions)
    ? lesson.prerequisite_positions.map((position) => String(position))
    : [];
  return { ids, positions };
}

function lessonFieldTitle(field) {
  return $("[data-lesson=title]", field).value.trim() || "Untitled lesson";
}

function prerequisiteChoices(fields, field) {
  return fields.filter((candidate) => candidate !== field).map((candidate) => ({
    field: candidate,
    key: candidate.dataset.lessonKey,
    position: fields.indexOf(candidate) + 1,
    title: lessonFieldTitle(candidate),
  }));
}

function selectedPrerequisiteTargets(fields, field, selectedKeys) {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys);
  return prerequisiteChoices(fields, field)
    .filter((choice) => selected.has(choice.key))
    .map((choice) => choice.field);
}

function prerequisitePositions(fields, field, selectedKeys) {
  return selectedPrerequisiteTargets(fields, field, selectedKeys)
    .map((target) => fields.indexOf(target) + 1);
}

function existingPrerequisiteKeys(lesson, fields) {
  const { ids, positions } = lessonPrerequisiteReferences(lesson);
  const keys = new Set();
  ids.forEach((id) => {
    const target = fields.find((field) => String(field.dataset.lessonId || "") === id);
    if (target) keys.add(target.dataset.lessonKey);
  });
  positions.forEach((position) => {
    const target = fields[Number(position) - 1];
    if (target) keys.add(target.dataset.lessonKey);
  });
  return keys;
}

function addLessonField(lesson = {}) {
  if ($$(".lesson-field").length >= 20) {
    showToast("A course can have at most 20 lessons.", "error");
    return;
  }
  const index = $$(".lesson-field").length + 1;
  const wrapper = document.createElement("div");
  wrapper.className = "lesson-field";
  wrapper.dataset.lessonId = lesson.id || "";
  wrapper.dataset.lessonKey = lesson.id ? `id-${lesson.id}` : `new-${++lessonFieldSequence}`;
  const references = lessonPrerequisiteReferences(lesson);
  wrapper.dataset.prerequisiteIds = references.ids.join(",");
  wrapper.dataset.prerequisitePositions = references.positions.join(",");
  wrapper.innerHTML = `<div class="lesson-number">${String(index).padStart(2, "0")}</div><div class="lesson-field-content"><div class="form-grid"><label>Lesson title<input data-lesson="title" value="${escapeHtml(lesson.title || "")}" placeholder="e.g. Start with a question" required maxlength="120" /></label><label>Minutes<input data-lesson="duration_minutes" type="number" min="5" max="240" step="1" value="${lesson.duration_minutes || 30}" required /></label></div><label>Short summary<input data-lesson="summary" value="${escapeHtml(lesson.summary || "")}" placeholder="What will this lesson unlock?" maxlength="500" /></label><label>Lesson content<textarea data-lesson="content" rows="3" placeholder="Add a few paragraphs of guidance..." maxlength="4000">${escapeHtml(lesson.content || "")}</textarea></label><fieldset class="prerequisite-picker"><legend>Prerequisites <span class="optional">optional · select any other lesson</span></legend><div class="prerequisite-options"></div></fieldset></div><button type="button" class="remove-lesson" data-action="remove-lesson" aria-label="Remove lesson">×</button>`;
  $("#lesson-fields").appendChild(wrapper);
  renumberLessons();
}

function renumberLessons() {
  const fields = $$(".lesson-field", $("#course-form"));
  fields.forEach((field, index) => {
    $(".lesson-number", field).textContent = String(index + 1).padStart(2, "0");
    $(".remove-lesson", field).setAttribute("aria-label", `Remove lesson ${index + 1}`);
    const selected = new Set($$("[data-prerequisite]:checked", field).map((checkbox) => checkbox.value));
    $(".prerequisite-options", field).innerHTML = prerequisiteChoices(fields, field).map((choice) => {
      return `<label class="prerequisite-option"><input type="checkbox" data-prerequisite value="${escapeHtml(choice.key)}" ${selected.has(choice.key) ? "checked" : ""} /><span>${choice.position}. ${escapeHtml(choice.title)}</span></label>`;
    }).join("") || '<p class="form-hint">No other lessons. This lesson has no prerequisites.</p>';
  });
  const addButton = $("#add-lesson");
  addButton.disabled = fields.length >= 20;
  addButton.textContent = fields.length >= 20 ? "20 / 20 lessons · limit reached" : `＋ Add lesson (${fields.length}/20)`;
}

function initializePrerequisiteSelections() {
  const fields = $$(".lesson-field", $("#course-form"));
  fields.forEach((field) => {
    const selected = existingPrerequisiteKeys({
      prerequisite_ids: String(field.dataset.prerequisiteIds || "").split(",").filter(Boolean),
      prerequisite_positions: String(field.dataset.prerequisitePositions || "").split(",").filter(Boolean),
    }, fields);
    $$(`[data-prerequisite]`, field).forEach((checkbox) => {
      checkbox.checked = selected.has(checkbox.value);
    });
  });
}

function openCourseEditor(course = null) {
  state.activeCourse = course;
  $("#course-editor-title").textContent = course ? "Edit course" : "Create a course";
  const form = $("#course-form");
  clearFormError(form, "course-error");
  form.reset();
  if (course) {
    form.title.value = course.title;
    form.category.value = course.category;
    ensureSelectValue(form.level, course.level, "Saved level");
    ensureSelectValue(form.accent, course.accent, "Saved color");
    form.description.value = course.description;
  }
  $("#lesson-fields").innerHTML = "";
  if (course) (course.lessons || []).forEach(addLessonField);
  else addLessonField();
  renumberLessons();
  if (course) initializePrerequisiteSelections();
  openModal("course-editor-modal");
  setTimeout(() => $("#course-form input[name=title]").focus(), 80);
}

function ensureSelectValue(select, value, labelPrefix) {
  if (!value) return;
  const exists = [...select.options].some((option) => option.value === value);
  if (!exists) select.add(new Option(`${labelPrefix} (${value})`, value));
  select.value = value;
}

function openSessionEditor(groupId = null) {
  const form = $("#session-form");
  clearFormError(form, "session-validation");
  form.reset();
  populateSessionForm();
  if (groupId && getGroup(groupId)?.joined) $("#session-group").value = String(groupId);
  const date = state.view === "calendar" ? new Date(state.calendarAnchor || workspaceToday()) : workspaceToday();
  if (state.view !== "calendar") date.setDate(date.getDate() + 1);
  $("#session-date").value = isoDate(date) < isoDate(workspaceToday()) ? isoDate(workspaceToday()) : isoDate(date);
  updateSessionValidation();
  openModal("session-editor-modal");
  setTimeout(() => $("#session-form input[name=title]").focus(), 80);
}

function openGroupEditor() {
  clearFormError($("#group-form"), "group-error");
  $("#group-form").reset();
  openModal("group-editor-modal");
  setTimeout(() => $("#group-form input[name=name]").focus(), 80);
}

function openLesson(course, lesson) {
  if (!lesson.completed && !course.enrolled) {
    showToast("Enroll in this course before opening lessons.", "error");
    return;
  }
  if (lessonStatus(course, lesson).locked) {
    showToast(prerequisiteHint(course, lesson), "error");
    return;
  }
  state.activeLesson = { course, lesson };
  $("#lesson-course-label").textContent = `${course.category.toUpperCase()} · ${course.title.toUpperCase()}`;
  $("#lesson-modal-title").textContent = lesson.title;
  $("#lesson-modal-meta").innerHTML = `<span>${escapeHtml(lesson.duration_minutes)} minutes</span><span>${lesson.completed ? "Completed" : "Ready to study"}</span>`;
  const prerequisiteNote = $("#lesson-modal-prerequisites");
  prerequisiteNote.textContent = prerequisiteHint(course, lesson);
  prerequisiteNote.hidden = !prerequisiteNote.textContent;
  $("#lesson-modal-content").innerHTML = escapeHtml(lesson.content || "This lesson is ready for your notes. Add guidance in the course editor when you are ready.").replaceAll("\n", "<br><br>");
  const button = $("#complete-lesson-button");
  button.disabled = lesson.completed;
  button.innerHTML = lesson.completed ? "Lesson complete <span>✓</span>" : "Mark lesson complete <span>✓</span>";
  button.classList.toggle("completed-button", lesson.completed);
  openModal("lesson-modal");
}

async function enrollCourse(courseId) {
  try {
    const result = await request(`/api/courses/${courseId}/enroll`, { method: "POST", body: "{}" });
    const message = result.created === false || result.course?.already_enrolled
      ? "You’re already enrolled; your progress is unchanged."
      : "You are enrolled locally. Your next step is ready.";
    await refreshAfterMutation(message);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function joinGroup(groupId) {
  try {
    await request(`/api/groups/${groupId}/join`, { method: "POST", body: "{}" });
    await refreshAfterMutation("You joined the study group.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function joinDiscussionGroup() {
  if (!state.activeGroup) return;
  const groupId = state.activeGroup.id;
  try {
    await request(`/api/groups/${encodeURIComponent(groupId)}/join`, { method: "POST", body: "{}" });
    const refreshed = await refresh({ quiet: true, reportError: false });
    state.activeGroup = getGroup(groupId);
    setDiscussionAccess(state.activeGroup);
    await loadDiscussion();
    showToast(refreshed
      ? "You joined the study group. You can now post in its discussion."
      : "You joined the study group, but the latest workspace data could not be loaded.", refreshed ? "success" : "error");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function completeActiveLesson() {
  if (!state.activeLesson || state.activeLesson.lesson.completed) return;
  const button = $("#complete-lesson-button");
  if (button.disabled) return;
  const { course, lesson } = state.activeLesson;
  button.disabled = true;
  try {
    const result = await request(`/api/lessons/${lesson.id}/complete`, { method: "POST", body: "{}" });
    closeModals();
    await refreshAfterMutation(result.course?.is_complete ? "Course complete! All lessons are finished. ✦" : "Lesson complete. Keep the thread going ✦");
  } catch (error) {
    button.disabled = false;
    showToast(prerequisiteErrorMessage(error, course), "error");
  }
}

function coursePayload(form) {
  const fields = $$(".lesson-field", form);
  if (fields.length > 20) throw new Error("A course can have at most 20 lessons.");
  return {
    title: form.title.value,
    description: form.description.value,
    category: form.category.value,
    level: form.level.value,
    accent: form.accent.value,
    lessons: fields.map((field, index) => {
      const lesson = {
        title: $("[data-lesson=title]", field).value,
        summary: $("[data-lesson=summary]", field).value,
        content: $("[data-lesson=content]", field).value,
        duration_minutes: Number($("[data-lesson=duration_minutes]", field).value),
      };
      const selected = new Set($$("[data-prerequisite]:checked", field).map((checkbox) => checkbox.value));
      if (field.dataset.lessonId) {
        lesson.id = Number(field.dataset.lessonId);
      }
      // Positions work for both persisted and unsaved prerequisite targets.
      lesson.prerequisite_positions = prerequisitePositions(fields, field, selected);
      return lesson;
    }),
  };
}

function sessionPayload(form) {
  return {
    title: form.title.value,
    group_id: Number(form.group_id.value),
    course_id: form.course_id.value ? Number(form.course_id.value) : null,
    session_date: form.session_date.value,
    start_time: form.start_time.value,
    timezone: form.timezone.value.trim(),
    fold: Number(form.fold.value),
    duration_minutes: Number(form.duration_minutes.value),
    notes: form.notes.value,
  };
}

async function saveCourse(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.saving === "true" || !reportFormValidity(form, "course-error")) return;
  const course = state.activeCourse;
  const finishSaving = beginFormSave(form, "Saving course…");
  try {
    try {
      const method = course ? "PUT" : "POST";
      const path = course ? `/api/courses/${course.id}` : "/api/courses";
      await request(path, { method, body: JSON.stringify(coursePayload(form)) });
    } catch (error) {
      showFormError(form, "course-error", error);
      return;
    }
    closeModals();
    await refreshAfterMutation(course ? "Course changes saved." : "Course created. It is ready for local enrollment.");
    if (course) navigate("courses");
  } finally {
    finishSaving();
  }
}

async function saveSession(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.saving === "true") return;
  clearFormError(form, "session-validation");
  updateSessionValidation();
  if (!getGroup(form.group_id.value)?.joined) {
    showFormError(form, "session-validation", { details: { field: "group_id" } }, "Join or create a study group before scheduling a session.");
    return;
  }
  if (!reportFormValidity(form, "session-validation")) return;
  const submit = $("button[type=submit]", form);
  const finishSaving = beginFormSave(form, "Adding to calendar…");
  try {
    const sessionDate = form.session_date.value;
    let result;
    try {
      result = await request("/api/sessions", {
        method: "POST",
        body: JSON.stringify(sessionPayload(form)),
      });
    } catch (error) {
      showFormError(form, "session-validation", error, scheduleErrorMessage(error));
      return;
    }
    state.calendarAnchor = dateFromISO(result.session?.session_date || sessionDate);
    if (result.session && state.data) {
      state.data.sessions = [...state.data.sessions.filter((session) => session.id !== result.session.id), result.session]
        .sort((a, b) => a.session_date.localeCompare(b.session_date) || a.start_time.localeCompare(b.start_time));
    }
    closeModals();
    navigate("calendar");
    // The confirmed response is rendered immediately, then bootstrap catches up.
    // This keeps the new event visible even if the follow-up read is transiently unavailable.
    if (state.data) render();
    await refreshAfterMutation("Session added to your weekly calendar.");
    if (result.session) requestAnimationFrame(() => {
      const removeButton = $$('[data-action="cancel-session"]', $("#calendar-body")).find((button) => button.dataset.sessionId === String(result.session.id));
      removeButton?.closest(".calendar-event").scrollIntoView({ block: "center", inline: "nearest" });
    });
  } finally {
    finishSaving();
    submit.disabled = !getGroup(form.group_id.value)?.joined;
  }
}

async function saveGroup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.saving === "true" || !reportFormValidity(form, "group-error")) return;
  const finishSaving = beginFormSave(form, "Creating group…");
  try {
    try {
      await request("/api/groups", { method: "POST", body: JSON.stringify({ name: form.name.value, description: form.description.value }) });
    } catch (error) {
      showFormError(form, "group-error", error);
      return;
    }
    closeModals();
    await refreshAfterMutation("New study group created.");
    navigate("groups");
  } finally {
    finishSaving();
  }
}

async function cancelSession(sessionId) {
  const reason = window.prompt("Cancel this session? Add an optional reason:", "");
  if (reason === null) return;
  try {
    await request(`/api/sessions/${sessionId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
    await refreshAfterMutation("Session cancelled. Its time is available again; the record is kept locally.");
    if (state.activeModal === "session-details-modal") closeModals();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function moveCalendarWeek(offset) {
  const anchor = new Date(state.calendarAnchor || workspaceToday());
  anchor.setDate(anchor.getDate() + offset * 7);
  state.calendarAnchor = anchor;
  renderCalendar();
}

function jumpCalendarWeek(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  state.calendarAnchor = dateFromISO(value);
  renderCalendar();
}

function setMobileNavigation(open) {
  const sidebar = $("#workspace-sidebar");
  const menu = $("#mobile-menu");
  if (!sidebar || !menu) return;
  sidebar.classList.toggle("mobile-open", open);
  sidebar.inert = !open;
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  if (open) {
    const first = $(".nav-item", sidebar);
    first?.focus();
  } else if (document.activeElement && sidebar.contains(document.activeElement)) {
    menu.focus();
  }
}

function handleCalendarKeydown(event) {
  if (state.view !== "calendar") return;
  if (!event.currentTarget.contains(document.activeElement)) return;
  if (event.key === "PageUp") {
    event.preventDefault();
    moveCalendarWeek(-1);
  } else if (event.key === "PageDown") {
    event.preventDefault();
    moveCalendarWeek(1);
  } else if (event.key === "Home") {
    event.preventDefault();
    state.calendarAnchor = workspaceToday();
    renderCalendar();
  }
}

function handleClick(event) {
  const navigateTarget = event.target.closest("[data-navigate]");
  if (navigateTarget) {
    event.preventDefault();
    navigate(navigateTarget.dataset.navigate);
    return;
  }
  const openCourse = event.target.closest("[data-open-course-editor]");
  if (openCourse) {
    event.preventDefault();
    openCourseEditor();
    return;
  }
  const openSession = event.target.closest("[data-open-session-editor]");
  if (openSession) {
    event.preventDefault();
    openSessionEditor(openSession.dataset.groupId || null);
    return;
  }
  const openGroup = event.target.closest("[data-open-group-editor]");
  if (openGroup) {
    event.preventDefault();
    openGroupEditor();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const { action: actionName } = action.dataset;
  if (actionName === "enroll") enrollCourse(action.dataset.courseId);
  if (actionName === "join-group") joinGroup(action.dataset.groupId);
  if (actionName === "cancel-session") cancelSession(action.dataset.sessionId);
  if (actionName === "open-session-details") openSessionDetails(action.dataset.sessionId);
  if (actionName === "open-discussion") openDiscussion(action.dataset.groupId);
  if (actionName === "join-discussion-group") joinDiscussionGroup();
  if (actionName === "delete-post") deleteDiscussionPost(action.dataset.postId);
  if (actionName === "remove-lesson") {
    const field = action.closest(".lesson-field");
    const lesson = state.activeCourse?.lessons.find((item) => Number(item.id) === Number(field?.dataset.lessonId));
    if (lesson?.completed && !window.confirm("Remove this completed lesson? Saving the course will also remove its completion record. Other lessons keep their progress.")) return;
    field?.remove();
    renumberLessons();
  }
  if (actionName === "open-course-editor") openCourseEditor();
  if (actionName === "edit-course") {
    const course = getCourse(action.dataset.courseId);
    if (course) openCourseEditor(course);
  }
  if (actionName === "open-lesson") {
    const course = getCourse(action.dataset.courseId);
    const lesson = course?.lessons.find((item) => Number(item.id) === Number(action.dataset.lessonId));
    if (course && lesson) openLesson(course, lesson);
  }
}

function initialize() {
  setupFormFeedback($("#course-form"), "course-error");
  setupFormFeedback($("#group-form"), "group-error");
  setupFormFeedback($("#session-form"), "session-validation");
  setupFormFeedback($("#discussion-form"), "discussion-error");
  setMobileNavigation(false);
  $("#course-form").addEventListener("submit", saveCourse);
  $("#session-form").addEventListener("submit", saveSession);
  $("#session-form").addEventListener("input", updateSessionValidation);
  $("#session-form").addEventListener("change", updateSessionValidation);
  $("#group-form").addEventListener("submit", saveGroup);
  $("#discussion-form").addEventListener("submit", saveDiscussionPost);
  $("#export-form").addEventListener("submit", exportWorkspace);
  $("#restore-form").addEventListener("submit", restoreWorkspace);
  $("#restore-file").addEventListener("change", () => {
    state.pendingBackupFile = null;
    $("#restore-counts").hidden = true;
    $("#restore-confirmation").hidden = true;
    $("#restore-confirm").disabled = false;
  });
  $("#download-backup").addEventListener("click", downloadBackup);
  $("#reload-discussion").addEventListener("click", loadDiscussion);
  $("#reload-progress-summary").addEventListener("click", openProgressSummary);
  $("#complete-lesson-button").addEventListener("click", completeActiveLesson);
  $("#add-lesson").addEventListener("click", () => addLessonField());
  $("#lesson-fields").addEventListener("input", (event) => {
    if (event.target.matches("[data-lesson=title]")) renumberLessons();
  });
  $("#refresh-button").addEventListener("click", () => refresh());
  $("#previous-week").addEventListener("click", () => moveCalendarWeek(-1));
  $("#next-week").addEventListener("click", () => moveCalendarWeek(1));
  $("#today-button").addEventListener("click", () => { state.calendarAnchor = workspaceToday(); renderCalendar(); });
  $("#calendar-jump-date").addEventListener("change", (event) => jumpCalendarWeek(event.target.value));
  $("#calendar-learner-filter").addEventListener("change", (event) => { state.calendarLearnerFilter = event.target.value; renderCalendar(); });
  $("#calendar-course-filter").addEventListener("change", (event) => { state.calendarCourseFilter = event.target.value; renderCalendar(); });
  $("#calendar-wrap").addEventListener("keydown", handleCalendarKeydown);
  $("#mobile-menu").addEventListener("click", () => setMobileNavigation(!$("#workspace-sidebar").classList.contains("mobile-open")));
  $("#refresh-retry").addEventListener("click", () => refresh());
  $("#session-details-cancel").addEventListener("click", () => {
    if (state.activeSession) cancelSession(state.activeSession.id);
  });
  $$('[data-open-progress-summary]').forEach((button) => button.addEventListener("click", openProgressSummary));
  $$('[data-open-export]').forEach((button) => button.addEventListener("click", () => openModal("export-modal")));
  $$('[data-open-settings]').forEach((button) => button.addEventListener("click", () => openModal("settings-modal")));
  document.addEventListener("click", handleClick);
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  $$("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModals));
  $("#modal-backdrop").addEventListener("click", closeModals);
  document.addEventListener("keydown", handleModalKeydown);
  $$(".filter-tab").forEach((tab) => tab.addEventListener("click", () => {
    state.courseFilter = tab.dataset.filter;
    renderCourses();
    renderDashboardCourses();
  }));
  window.addEventListener("hashchange", syncLocation);
  window.addEventListener("popstate", syncLocation);
  syncLocation();
  refresh();
}

window.addEventListener("DOMContentLoaded", initialize);
