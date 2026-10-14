import { createDemoData, planRollout, simulateRollout, cloneData, formatMinute } from "./src/planner.js";

const STORAGE_KEY = "patchline-demo-v2";
const LEGACY_STORAGE_KEY = "patchline-demo-v1";
const DEFAULT_WINDOW = { start: "02:00", end: "04:00", timezone: "UTC" };
let data = loadData();
let plan = planRollout(data);

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
const minuteLabel = (value) => Number.isFinite(value) ? formatMinute(value) : "not scheduled";

function normalizeData(stored) {
  const defaults = createDemoData();
  if (!stored || typeof stored !== "object") return defaults;
  const mergeById = (fallback, value) => (Array.isArray(value) ? value.map((item) => ({ ...(fallback.find((candidate) => candidate.id === item.id) || {}), ...item })) : fallback);
  const policy = stored.policy || {};
  return {
    ...defaults,
    ...stored,
    schemaVersion: Math.max(2, Number(stored.schemaVersion) || 0),
    policy: { ...defaults.policy, ...policy, changeWindow: { ...DEFAULT_WINDOW, ...(policy.changeWindow || {}) } },
    hosts: mergeById(defaults.hosts, stored.hosts),
    patches: mergeById(defaults.patches, stored.patches),
    groups: mergeById(defaults.groups, stored.groups),
    conflicts: Array.isArray(stored.conflicts) ? stored.conflicts : defaults.conflicts,
    selection: { ...defaults.selection, ...(stored.selection || {}), conflictChoices: { ...(stored.selection?.conflictChoices || {}) } }
  };
}

function loadData() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    const candidate = normalizeData(stored ? JSON.parse(stored) : null);
    validateModel(candidate);
    planRollout(candidate);
    return candidate;
  } catch { return createDemoData(); }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); return true; }
  catch { return false; }
}

function resetRehearsal() {
  $("#rehearsalStatus").textContent = "Not run";
  $("#rehearsalStatus").className = "rehearsal-status";
  $("#simulationResult").classList.add("hidden");
  $("#simulationResult").innerHTML = "";
}

function refresh() {
  plan = planRollout(data);
  save();
  resetRehearsal();
  render();
}

function render() {
  renderMetrics(); renderWaves(); renderConflicts(); renderFleet(); renderPatches(); renderRollback(); renderRehearsalHosts();
  $("#navFleetCount").textContent = String(data.hosts.length).padStart(2, "0");
  $("#navPatchCount").textContent = String(data.selection.patchIds.length).padStart(2, "0");
  $("#navConflictCount").textContent = String(data.conflicts.length).padStart(2, "0");
  $("#conflictPill").textContent = String(data.conflicts.length).padStart(2, "0");
  $("#selectedPatchPill").textContent = String(plan.selectedPatchIds.length).padStart(2, "0");
  $("#windowSummary").textContent = `${plan.changeWindow.start} — ${plan.changeWindow.end} ${plan.changeWindow.timezone || "UTC"}`;
  renderWindowInputs();
  const state = $("#planState");
  state.innerHTML = plan.blockers.length ? `<span class="state-dot warning-dot"></span>${plan.blockers.length} blocker${plan.blockers.length === 1 ? "" : "s"}` : `<span class="state-dot"></span>Plan ready`;
}

function renderWindowInputs() {
  const start = $("#windowStart");
  const end = $("#windowEnd");
  start.value = plan.changeWindow.start ?? "";
  end.value = plan.changeWindow.end ?? "";
  const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const invalidOrder = validTime(start.value) && validTime(end.value) && end.value <= start.value;
  const invalidZone = !!plan.changeWindow.timezone && plan.changeWindow.timezone !== "UTC";
  const message = invalidZone ? "Use UTC for the change window (edit the imported model's timezone)." : "Enter a same-day window with start before end (HH:MM UTC).";
  for (const input of [start, end]) {
    const invalid = !validTime(input.value) || invalidOrder || invalidZone;
    input.setCustomValidity(invalid ? message : "");
    input.setAttribute("aria-invalid", String(invalid));
  }
  $("#windowValidation").textContent = start.validity.valid && end.validity.valid ? "" : message;
}

function renderMetrics() {
  const ready = Object.values(plan.hostStatuses).filter((item) => item.status === "ready").length;
  const risk = plan.totalRisk > 18 ? "Elevated" : plan.totalRisk > 9 ? "Moderate" : "Low";
  $("#metrics").innerHTML = [
    ["HOSTS IN SCOPE", data.selection.hostIds.length, `${ready} ready · ${data.selection.hostIds.length - ready} attention`, ""],
    ["OPERATIONS", plan.summary.operationCount, `${plan.summary.eligibleCount} eligible`, ""],
    ["BLOCKERS", plan.blockers.length, plan.blockers.length ? "Resolve before apply" : "No hard blockers", plan.blockers.length ? "bad" : ""],
    ["RISK INDEX", plan.totalRisk, `${risk} · synthetic score`, plan.totalRisk > 18 ? "accent" : ""]
  ].map(([label, value, note, klass]) => `<div class="metric"><span class="label">${label}</span><strong class="${klass}">${value}</strong><small>${note}</small></div>`).join("");
}

function operationSchedule(op) {
  if (!op.schedule) return `<span class="schedule-blocked">No placement · blocked</span>`;
  const schedule = op.schedule;
  const reboot = schedule.reboot ? ` · reboot ${formatMinute(schedule.reboot.startMinute)}–${formatMinute(schedule.reboot.endMinute)}` : " · no reboot";
  return `<span>${formatMinute(schedule.startMinute)}–${formatMinute(schedule.applyEndMinute)} apply${reboot} · end ${formatMinute(schedule.endMinute)}</span>`;
}

function dependencyLabels(op) {
  if (!op.dependencies?.length) return "No prerequisites";
  return `Depends on ${op.dependencies.map((id) => escapeHtml(id)).join(", ")}`;
}

function compatibilityState(op) {
  if (!op.projectedBefore) return `<small class="compatibility-state">Compatibility at operation start: not evaluated</small>`;
  const labels = { release: "Release", architecture: "Architecture", abi: "ABI", installedKernel: "Installed kernel", runningKernel: "Running kernel", kernelKbi: "Kernel KBI" };
  return `<div class="compatibility-state"><span>Compatibility at operation start</span><dl>${Object.entries(labels).filter(([key]) => op.projectedBefore[key] !== undefined).map(([key, label]) => `<div><dt>${label}</dt><dd>${escapeHtml(op.projectedBefore[key])}</dd></div>`).join("")}</dl></div>`;
}

function reasonDetails(reason) {
  const boundary = Number.isFinite(reason.earliestStartMinute) || Number.isFinite(reason.earliestEndMinute);
  return `${boundary ? `<small class="boundary-slot">Earliest proposed slot: ${minuteLabel(reason.earliestStartMinute)}–${minuteLabel(reason.earliestEndMinute)} · not scheduled</small>` : ""}${reason.remediation ? `<small>Remediation: ${escapeHtml(reason.remediation)}</small>` : ""}`;
}

function renderWaves() {
  $("#waves").innerHTML = plan.waves.length ? plan.waves.map((wave) => `<div class="wave">
    <div class="wave-head"><span class="wave-number">${String(wave.number).padStart(2, "0")}</span><span class="wave-name">${escapeHtml(wave.groupName)}</span>${wave.canary ? `<span class="canary-tag">CANARY GATE</span>` : ""}<div class="wave-meta"><span>${formatMinute(wave.startMinute)}–${formatMinute(wave.endMinute)}</span><span>${wave.operations.length} operation${wave.operations.length === 1 ? "" : "s"}</span>${wave.locked ? `<span class="locked-tag">⌑ locked</span>` : `<span>${wave.soakMinutes ? `${wave.soakMinutes}m soak` : "ready"}</span>`}</div></div>
    ${wave.operations.map((op) => `<div class="op" data-operation-id="${escapeHtml(op.id)}"><span class="op-marker ${op.risk >= 5 ? "risk" : ""}">${op.risk >= 5 ? "!" : "✓"}</span><div class="op-main"><strong>${escapeHtml(op.hostName)} <span class="slash">/</span> ${escapeHtml(op.patchName)}</strong><small>${escapeHtml(op.patchId)} · ${op.rebootRequired ? "reboot required" : "service restart only"}</small><small class="dependency-label">${dependencyLabels(op)}</small><small class="operation-time">${operationSchedule(op)}</small>${compatibilityState(op)}</div><div class="op-right"><span class="risk-label ${op.risk >= 5 ? "high" : ""}">${op.risk >= 5 ? "HIGH" : op.risk >= 3 ? "MEDIUM" : "LOW"}</span><span class="op-status">${wave.locked ? "gated" : "eligible"}</span></div></div>`).join("")}
  </div>`).join("") : "";
  $("#emptyPlan").classList.toggle("hidden", !!plan.waves.length);
  renderCanaryGates();
  const blockerList = $("#blockerList");
  blockerList.classList.toggle("hidden", !plan.blockers.length);
  blockerList.innerHTML = plan.blockers.length ? `<div class="blocker-heading"><strong>ALL BLOCKERS</strong><span>${plan.blockers.length}</span></div>${plan.blockers.map((blocker) => {
    const operation = plan.operations.find((op) => op.hostId === blocker.hostId && op.patchId === blocker.patchId);
    return `<div class="blocker-item"><span class="blocker-code">${escapeHtml(blocker.code)}</span><div><strong>${escapeHtml(blocker.message)}</strong>${reasonDetails(blocker)}${operation?.projectedBefore ? compatibilityState(operation) : ""}</div></div>`;
  }).join("")}` : "";
}

function renderCanaryGates() {
  $("#canaryGates").innerHTML = plan.canaryGroups.map((gate) => {
    const blocked = gate.status === "blocked";
    // Older plans used releaseMinute for soak overflow. It is only a proposal,
    // never a release, when blocked. New plans expose proposedReleaseMinute.
    const overflow = plan.blockers.some((reason) => reason.groupId === gate.groupId && reason.code === "SOAK_WINDOW_EXCEEDED") || gate.reasons?.some((reason) => reason.code === "SOAK_WINDOW_EXCEEDED");
    const proposed = gate.proposedReleaseMinute ?? (blocked && overflow ? gate.releaseMinute : null);
    const soakEnd = Number.isFinite(gate.soakStartMinute) ? gate.soakStartMinute + gate.soakMinutes : null;
    return `<div class="canary-gate" data-group-id="${escapeHtml(gate.groupId)}"><div class="gate-heading"><div><span class="eyebrow">CANARY GATE · GROUP ${escapeHtml(gate.groupId)}</span><strong>${escapeHtml(gate.name)}</strong></div><span class="gate-status ${escapeHtml(gate.status)}">${escapeHtml(gate.status)}</span></div><div class="gate-members"><span class="gate-label">MEMBERS</span>${gate.hostIds.map((hostId) => `<span class="member-chip">${escapeHtml(data.hosts.find((host) => host.id === hostId)?.name || hostId)}</span>`).join("")}</div><div class="gate-timing"><span class="gate-soak">${blocked && Number.isFinite(soakEnd) ? "Proposed soak" : "Soak"} ${Number.isFinite(soakEnd) ? `${minuteLabel(gate.soakStartMinute)}–${minuteLabel(soakEnd)} (${escapeHtml(gate.soakMinutes)}m)` : "not scheduled"}</span><span class="gate-release">Release ${blocked ? "blocked" : minuteLabel(gate.releaseMinute)}</span>${blocked && Number.isFinite(proposed) ? `<span class="gate-proposed">Proposed soak release ${minuteLabel(proposed)} · exceeds window</span>` : ""}</div>${gate.reasons?.length ? `<ul class="gate-reasons">${gate.reasons.map((reason) => `<li><code>${escapeHtml(reason.code)}</code> ${escapeHtml(reason.message)}${reasonDetails(reason)}</li>`).join("")}</ul>` : blocked ? `<p class="gate-explanation">Gate cannot release. Resolve the group blockers listed below.</p>` : `<p class="gate-explanation">Production remains gated until all members are healthy and the soak completes.</p>`}</div>`;
  }).join("");
}

function renderConflicts() {
  $("#conflictChoices").innerHTML = data.conflicts.map((conflict) => {
    const selectedChoice = data.selection.conflictChoices?.[conflict.id] || "";
    return `<div class="conflict-block"><div class="conflict-title">${escapeHtml(conflict.label)}</div><div class="conflict-reason">${escapeHtml(conflict.reason)}</div>${conflict.options.map((option) => `<label class="choice"><input type="radio" name="conflict-${escapeHtml(conflict.id)}" data-conflict="${escapeHtml(conflict.id)}" value="${escapeHtml(option.id)}" ${selectedChoice === option.id ? "checked" : ""}/> ${escapeHtml(option.label)} <code>${option.select.length ? escapeHtml(option.select.join(", ")) : "none"}</code></label>`).join("")}</div>`;
  }).join("");
  document.querySelectorAll("[data-conflict]").forEach((input) => input.addEventListener("change", (event) => { data.selection.conflictChoices[event.target.dataset.conflict] = event.target.value; refresh(); }));
}

function renderFleet() {
  $("#fleetRows").innerHTML = data.hosts.map((host) => {
    const status = plan.hostStatuses[host.id] || { status: "out-of-scope" };
    const label = status.status === "abi-blocked" ? "ABI blocked" : status.status === "ready" ? "Ready" : status.status;
    return `<tr><td class="host-cell"><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.id)}</small></td><td>${escapeHtml(host.role)}</td><td class="abi-cell">${escapeHtml(host.abi)}<br /><span>${escapeHtml(host.runningKernel)}${status.rebootPending ? " · reboot pending" : ""}</span></td><td><span class="risk-dot ${escapeHtml(host.risk)}"></span>${escapeHtml(host.risk)}</td><td><span class="status ${status.status === "ready" ? "ready" : status.status === "abi-blocked" || status.status === "blocked" ? "blocked" : "reboot"}">${escapeHtml(label)}</span></td></tr>`;
  }).join("");
}

function conflictMemberIds() {
  return new Set(data.conflicts.flatMap((conflict) => conflict.members || []));
}

function renderPatches() {
  const members = conflictMemberIds();
  $("#patchRows").innerHTML = data.patches.map((patch) => {
    const selected = plan.selectedPatchIds.includes(patch.id);
    const selectorOnly = members.has(patch.id);
    return `<label class="patch-row ${selectorOnly ? "selector-only" : ""}"><span class="patch-symbol">${patch.kind === "base update" ? "⌘" : patch.kind === "kernel module" ? "◈" : "◇"}</span><span><strong>${escapeHtml(patch.name)}</strong><small>${escapeHtml(patch.id)} · ${escapeHtml(patch.kind)}</small>${selectorOnly ? `<small class="patch-selection-note">Choose this provider in What-if conflicts.</small>` : ""}</span><input type="checkbox" data-patch="${escapeHtml(patch.id)}" ${selected ? "checked" : ""} ${selectorOnly ? "disabled" : ""} aria-label="${escapeHtml(patch.name)} ${selectorOnly ? "selected in conflict selector" : ""}"/><span class="patch-badge">${selectorOnly ? "selector only" : selected ? "selected" : "available"}</span></label>`;
  }).join("");
  document.querySelectorAll("[data-patch]:not(:disabled)").forEach((input) => input.addEventListener("change", (event) => {
    const id = event.target.dataset.patch;
    data.selection.patchIds = event.target.checked ? [...new Set([...data.selection.patchIds, id])] : data.selection.patchIds.filter((patchId) => patchId !== id);
    refresh();
  }));
}

function rollbackDetails(path) {
  return `<div class="rollback-item" data-operation-id="${escapeHtml(path.operationId)}"><span class="rollback-number">${escapeHtml(String(path.order).padStart(2, "0"))}</span><div><strong>${escapeHtml(path.patchName)}</strong><small class="rollback-host">${escapeHtml(path.hostName)} · wave ${escapeHtml(path.waveNumber ?? "—")}</small><small class="rollback-operation">${escapeHtml(path.operationId)}</small><p>${path.methods.map((method) => escapeHtml(method)).join(" <b>OR</b> ")}<br />${path.requiresReboot ? "reboot required" : "no reboot"} · reverse dependency order</p></div></div>`;
}

function renderRollback() {
  $("#rollbackPaths").innerHTML = plan.rollbackPaths.length ? plan.rollbackPaths.map(rollbackDetails).join("") : `<div class="empty-state">No scheduled operations have rollback paths.</div>`;
}

function renderRehearsalHosts() {
  const select = $("#failureHost");
  select.innerHTML = data.selection.hostIds.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(data.hosts.find((host) => host.id === id)?.name || id)}</option>`).join("");
}

function validateModel(candidate) {
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const fail = (message) => { throw new Error(message); };
  if (!object(candidate) || !object(candidate.selection) || !strings(candidate.selection.hostIds) || !strings(candidate.selection.patchIds)) fail("expected a planner model with hostIds and patchIds selections.");
  for (const key of ["hosts", "patches", "groups", "conflicts"]) {
    if (!Array.isArray(candidate[key])) fail(`expected a ${key} array.`);
    const ids = new Set();
    for (const item of candidate[key]) {
      if (!object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)) fail(`${key} need unique, nonempty IDs.`);
      ids.add(item.id);
      for (const field of ["name", "role", "groupId", "release", "architecture", "abi", "installedKernel", "runningKernel", "kernelKbi", "risk", "kind", "label", "reason"]) {
        if (item[field] !== undefined && typeof item[field] !== "string") fail(`${item.id}: ${field} must be text.`);
      }
    }
  }
  for (const patch of candidate.patches) {
    if (!object(patch.appliesTo) || !strings(patch.appliesTo.releases) || !strings(patch.appliesTo.architectures)) fail(`${patch.id}: expected release and architecture arrays.`);
    if (patch.requiresPatchIds !== undefined && !strings(patch.requiresPatchIds)) fail(`${patch.id}: invalid prerequisites.`);
    if (patch.rollback !== undefined && (!object(patch.rollback) || !strings(patch.rollback.methods))) fail(`${patch.id}: expected rollback methods as alternatives.`);
    if (patch.target !== undefined && !object(patch.target)) fail(`${patch.id}: expected a target object.`);
    for (const field of ["durationMinutes", "rebootMinutes"]) if (patch[field] !== undefined && !Number.isFinite(patch[field])) fail(`${patch.id}: ${field} must be a number.`);
  }
  for (const host of candidate.hosts) if (host.requiresHealthyHosts !== undefined && !strings(host.requiresHealthyHosts)) fail(`${host.id}: invalid health prerequisites.`);
  for (const group of candidate.groups) {
    if (group.hostIds !== undefined && !strings(group.hostIds)) fail(`${group.id}: invalid group host IDs.`);
    if (!Number.isInteger(group.order)) fail(`${group.id}: order must be an integer.`);
    if (group.maxParallel !== undefined && (!Number.isInteger(group.maxParallel) || group.maxParallel <= 0)) fail(`${group.id}: maxParallel must be a positive integer.`);
    if (group.soakMinutes !== undefined && (!Number.isInteger(group.soakMinutes) || group.soakMinutes < 0)) fail(`${group.id}: soakMinutes must be a nonnegative integer.`);
  }
  if (new Set(candidate.groups.map((group) => group.order)).size !== candidate.groups.length) fail("rollout groups need distinct integer orders.");
  for (const conflict of candidate.conflicts) {
    if (!strings(conflict.members) || !Array.isArray(conflict.options) || !conflict.options.every((option) => object(option) && typeof option.id === "string" && strings(option.select))) fail(`${conflict.id}: expected conflict members and selector options.`);
  }
  if (candidate.policy !== undefined && !object(candidate.policy)) fail("expected a policy object.");
  if (candidate.policy?.changeWindow !== undefined && !object(candidate.policy.changeWindow)) fail("expected a changeWindow object.");
  for (const field of ["start", "end", "timezone"]) if (candidate.policy?.changeWindow?.[field] !== undefined && typeof candidate.policy.changeWindow[field] !== "string") fail(`changeWindow ${field} must be text.`);
  if (candidate.selection.conflictChoices !== undefined && !object(candidate.selection.conflictChoices)) fail("expected conflictChoices as an object.");
}

$("#resetBtn").addEventListener("click", () => { data = createDemoData(); data.schemaVersion = 2; refresh(); $("#importStatus").textContent = "Demo restored"; });
$(".notice-close").addEventListener("click", (event) => event.currentTarget.closest(".notice").remove());
$("#exportBtn").addEventListener("click", () => {
  const payload = { exportedAt: "deterministic-demo", model: data, plan };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "patchline-rollout-plan.json"; link.click(); URL.revokeObjectURL(link.href);
});
$("#importBtn").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    const model = imported?.model || imported;
    validateModel(model);
    const candidate = normalizeData(cloneData(model));
    const candidatePlan = planRollout(candidate);
    data = candidate;
    plan = candidatePlan;
    const saved = save();
    resetRehearsal();
    render();
    $("#importStatus").textContent = saved ? "Imported and recalculated" : "Imported · local storage unavailable";
  } catch (error) {
    $("#importStatus").textContent = `Import rejected: ${error.message || "invalid planner JSON"}`;
  }
  event.target.value = "";
});
$("#windowStart").addEventListener("change", (event) => { data.policy.changeWindow.start = event.target.value; refresh(); });
$("#windowEnd").addEventListener("change", (event) => { data.policy.changeWindow.end = event.target.value; refresh(); });
$("#simulateBtn").addEventListener("click", () => {
  const outcomes = { [$("#failureHost").value]: $("#failureOutcome").value };
  const result = simulateRollout(plan, outcomes, { rollbackPolicy: $("#rollbackPolicy").value, haltOnFailure: true });
  const statusLabel = result.status === "healthy" ? "Healthy" : result.status === "blocked" ? "Blocked by plan" : `${result.halted ? "Halted · " : ""}Partial failure`;
  $("#rehearsalStatus").textContent = statusLabel;
  $("#rehearsalStatus").className = `rehearsal-status ${result.status}`;
  $("#simulationResult").classList.remove("hidden");
  $("#simulationResult").innerHTML = `<strong>${escapeHtml(statusLabel)}${result.failingWave ? ` · wave ${result.failingWave}` : ""}</strong><span class="sim-halted">Halted: ${result.halted ? "yes" : "no"}</span><div class="sim-section"><span class="sim-label">HOST STATES</span><div class="sim-tags">${Object.entries(result.hostStates).map(([host, state]) => `<span class="sim-tag ${state === "healthy" ? "ok" : state === "pending" || state === "blocked" ? "" : "fail"}">${escapeHtml(host)} · ${escapeHtml(state)}</span>`).join("")}</div></div><div class="sim-section"><span class="sim-label">CANARY GATES</span><div class="sim-tags">${Object.entries(result.gateStates).map(([groupId, state]) => `<span class="sim-tag ${state === "passed" ? "ok" : state === "blocked" || state === "failed" ? "fail" : ""}">${escapeHtml(groupId)} · ${escapeHtml(state)}</span>`).join("")}</div></div>${result.rollbackSteps.length ? `<div class="sim-section"><span class="sim-label">ACTUAL CHANGED OPERATIONS · REVERSE ROLLBACK ORDER</span><div class="rollback-summary">${result.rollbackSteps.map(rollbackDetails).join("")}</div><small class="rollback-hosts">Rollback hosts: ${result.rollback.map((item) => escapeHtml(item.hostId)).join(", ")}</small></div>` : `<div class="sim-section sim-muted">No changed operation paths require rollback.</div>`}`;
});

render();
