/**
 * Pure planning and simulation functions. This project never connects to a
 * host or applies a real FreeBSD update; all data and outcomes are synthetic.
 */

export function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

export function createDemoData() {
  return {
    schemaVersion: 2,
    policy: {
      haltOnCanaryFailure: true,
      haltOnAnyFailure: true,
      defaultRollback: "rollback-failed-wave",
      changeWindow: { start: "02:00", end: "04:00", timezone: "UTC" }
    },
    hosts: [
      {
        id: "edge-01", name: "edge-01", role: "web / canary", groupId: "canary",
        release: "14.3-RELEASE", architecture: "amd64", abi: "FreeBSD:14:amd64",
        installedKernel: "14.3-RELEASE-p7", runningKernel: "14.3-RELEASE-p7", kernelKbi: "14.3-p7-kbi",
        risk: "low", requiresHealthyHosts: [], healthChecks: ["ssh", "edge-http", "version-consistent"]
      },
      {
        id: "api-01", name: "api-01", role: "api", groupId: "production",
        release: "14.3-RELEASE", architecture: "amd64", abi: "FreeBSD:14:amd64",
        installedKernel: "14.3-RELEASE-p6", runningKernel: "14.3-RELEASE-p6", kernelKbi: "14.3-p6-kbi",
        risk: "medium", requiresHealthyHosts: ["edge-01"], healthChecks: ["ssh", "api-health", "version-consistent"]
      },
      {
        id: "worker-01", name: "worker-01", role: "queue worker", groupId: "production",
        release: "14.3-RELEASE", architecture: "amd64", abi: "FreeBSD:14:amd64",
        installedKernel: "14.3-RELEASE-p6", runningKernel: "14.3-RELEASE-p6", kernelKbi: "14.3-p6-kbi",
        risk: "medium", requiresHealthyHosts: ["api-01"], healthChecks: ["ssh", "queue-drain", "version-consistent"]
      },
      {
        id: "legacy-01", name: "legacy-01", role: "reporting", groupId: "production",
        release: "13.2-RELEASE", architecture: "amd64", abi: "FreeBSD:13:amd64",
        installedKernel: "13.2-RELEASE-p4", runningKernel: "13.2-RELEASE-p4", kernelKbi: "13.2-p4-kbi",
        risk: "high", requiresHealthyHosts: [], healthChecks: ["ssh", "reports"]
      }
    ],
    patches: [
      {
        id: "base-p7", name: "FreeBSD base security update p7", kind: "base update",
        appliesTo: { releases: ["14.3-RELEASE"], architectures: ["amd64"], abi: "FreeBSD:14:amd64" },
        target: { release: "14.3-RELEASE", kernel: "14.3-RELEASE-p7", kbi: "14.3-p7-kbi", abi: "FreeBSD:14:amd64" },
        requiresPatchIds: [], rebootRequired: true, durationMinutes: 20, rebootMinutes: 15, risk: "medium", touches: ["/boot/kernel", "/usr/lib"],
        rollback: { methods: ["boot environment", "freebsd-update rollback"], requiresReboot: true }
      },
      {
        id: "crypto-modern", name: "OpenSSL 3 provider", kind: "package",
        appliesTo: { releases: ["14.3-RELEASE"], architectures: ["amd64"], abi: "FreeBSD:14:amd64" },
        target: { release: "14.3-RELEASE" }, requiresPatchIds: ["base-p7"], rebootRequired: false, durationMinutes: 10,
        risk: "medium", touches: ["/usr/local/lib/libcrypto.so"], conflictSet: "openssl-provider",
        rollback: { methods: ["package snapshot"], requiresReboot: false }
      },
      {
        id: "crypto-legacy", name: "OpenSSL 1.1 compatibility provider", kind: "package",
        appliesTo: { releases: ["14.3-RELEASE"], architectures: ["amd64"], abi: "FreeBSD:14:amd64" },
        target: { release: "14.3-RELEASE" }, requiresPatchIds: ["base-p7"], rebootRequired: false, durationMinutes: 10,
        risk: "high", touches: ["/usr/local/lib/libcrypto.so"], conflictSet: "openssl-provider",
        rollback: { methods: ["package snapshot"], requiresReboot: false }
      },
      {
        id: "web-kmod-p7", name: "Edge packet filter KBI module", kind: "kernel module",
        appliesTo: { releases: ["14.3-RELEASE"], architectures: ["amd64"], abi: "FreeBSD:14:amd64" },
        target: { release: "14.3-RELEASE", kbi: "14.3-p7-kbi" }, requiresPatchIds: ["base-p7"],
        requiresKernelKbi: "14.3-p7-kbi", rebootRequired: true, durationMinutes: 15, rebootMinutes: 10, risk: "high", touches: ["/boot/modules/edge_pf.ko"],
        rollback: { methods: ["boot environment"], requiresReboot: true }
      }
    ],
    conflicts: [
      {
        id: "openssl-provider", label: "OpenSSL provider", reason: "Both providers replace /usr/local/lib/libcrypto.so.",
        members: ["crypto-modern", "crypto-legacy"],
        options: [
          { id: "modern", label: "Modern provider", select: ["crypto-modern"] },
          { id: "legacy", label: "Legacy compatibility", select: ["crypto-legacy"] },
          { id: "defer", label: "Defer this change", select: [] }
        ]
      }
    ],
    groups: [
      { id: "canary", name: "Canary", order: 1, canary: true, hostIds: ["edge-01"], maxParallel: 1, soakMinutes: 15 },
      { id: "production", name: "Production", order: 2, canary: false, hostIds: ["api-01", "worker-01", "legacy-01"], maxParallel: 2, soakMinutes: 0 }
    ],
    selection: {
      hostIds: ["edge-01", "api-01", "worker-01", "legacy-01"],
      patchIds: ["base-p7", "crypto-modern", "web-kmod-p7"],
      conflictChoices: { "openssl-provider": "modern" }
    }
  };
}

const riskWeight = { low: 1, medium: 2, high: 3 };
const keyFor = (hostId, patchId) => `${hostId}::${patchId}`;

function mapById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function effectivePatchIds(data, blockers) {
  const selected = new Set(data.selection.patchIds || []);
  for (const conflict of data.conflicts || []) {
    const members = new Set(conflict.members);
    const selectedMembers = [...selected].filter((id) => members.has(id));
    const choiceId = data.selection.conflictChoices?.[conflict.id];
    const option = conflict.options?.find((candidate) => candidate.id === choiceId);
    if (selectedMembers.length > 1 && !option) {
      blockers.push({ code: "CONFLICT_UNRESOLVED", severity: "blocker", message: `${conflict.label} has multiple selected members and no what-if choice.` });
    }
    if (option) {
      for (const id of members) selected.delete(id);
      for (const id of option.select) selected.add(id);
    }
  }
  return selected;
}

function addEdge(edges, from, to) {
  edges.get(to).add(from);
}

function findCycle(nodes, edges) {
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  function visit(node) {
    if (visiting.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (visited.has(node)) return null;
    visiting.add(node); path.push(node);
    for (const dep of edges.get(node) || []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop(); visiting.delete(node); visited.add(node); return null;
  }
  for (const node of nodes) { const cycle = visit(node); if (cycle) return cycle; }
  return null;
}

function stableOperationSort(a, b, groupOrder) {
  return (groupOrder.get(a.groupId) ?? 99) - (groupOrder.get(b.groupId) ?? 99) || a.hostId.localeCompare(b.hostId) || a.patchId.localeCompare(b.patchId);
}

export function formatMinute(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function windowMinutes(window) {
  const parse = (time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time || "") ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN;
  return { startMinute: parse(window.start), endMinute: parse(window.end) };
}

function block(op, code, message, remediation) {
  op.status = "blocked";
  op.reasons.push({ code, message, ...(remediation ? { remediation } : {}) });
}

// Actual state includes every completed same-host change. Separately replay
// qualified ancestors so unrelated changes cannot silently satisfy prerequisites.
function projectedHost(host, op, byId, edges, patches, qualifiedOnly = false) {
  const ancestors = new Set();
  function collect(id) {
    for (const dep of edges.get(id) || []) if (!ancestors.has(dep)) { ancestors.add(dep); collect(dep); }
  }
  collect(op.id);
  const projected = { ...host };
  const predecessors = [...byId.values()].filter((dep) => dep.hostId === host.id && dep.schedule && (!qualifiedOnly || ancestors.has(dep.id)))
    .sort((a, b) => a.schedule.endMinute - b.schedule.endMinute || a.id.localeCompare(b.id));
  for (const dep of predecessors) {
    const patch = patches.get(dep.patchId);
    const target = patch.target || {};
    if (target.kernel) projected.installedKernel = target.kernel;
    if (dep.schedule.reboot) {
      projected.runningKernel = target.kernel || projected.installedKernel;
      if (target.kbi) projected.kernelKbi = target.kbi;
    }
    if (target.release) projected.release = target.release;
    if (target.abi) projected.abi = target.abi;
  }
  return projected;
}

function checkCompatibility(op, patch, host) {
  if (!patch.appliesTo.releases.includes(host.release)) block(op, "RELEASE_UNSUPPORTED", `Patch targets ${patch.appliesTo.releases.join(", ")}; host is ${host.release}.`, "Select a patch for this release or plan an explicit upgrade prerequisite.");
  if (!patch.appliesTo.architectures.includes(host.architecture)) block(op, "ARCH_MISMATCH", `Patch targets ${patch.appliesTo.architectures.join(", ")}; host is ${host.architecture}.`);
  if (patch.appliesTo.abi && patch.appliesTo.abi !== host.abi) block(op, "ABI_MISMATCH", `Requires ${patch.appliesTo.abi}; host reports ${host.abi}.`, "Upgrade the base system and reboot before applying this patch.");
  if (patch.requiresKernelKbi && host.kernelKbi !== patch.requiresKernelKbi) block(op, "KBI_MISMATCH", `Requires kernel KBI ${patch.requiresKernelKbi}; host reports ${host.kernelKbi}.`, "Add a compatible base update and its completed reboot as a prerequisite.");
  if (patch.requiresKernelKbi && host.installedKernel !== host.runningKernel) block(op, "REBOOT_PENDING", `Installed kernel ${host.installedKernel} is not running (${host.runningKernel}). Reboot before loading this module.`);
}

export function planRollout(input) {
  const data = cloneData(input);
  const blockers = [];
  const warnings = [];
  const hosts = mapById(data.hosts || []);
  const patches = mapById(data.patches || []);
  const groups = mapById(data.groups || []);
  const orders = [...groups.values()].map((group) => group.order);
  const validGroupOrders = orders.every(Number.isInteger) && new Set(orders).size === orders.length;
  if (!validGroupOrders) blockers.push({ code: "GROUP_ORDER_CONFLICT", severity: "blocker", message: "Every rollout group must have a unique integer order.", remediation: "Assign distinct integer priorities; use the same group for parallel hosts." });
  const groupReasons = new Map([...groups.values()].map((group) => {
    const reasons = [];
    if (group.soakMinutes !== undefined && (!Number.isInteger(group.soakMinutes) || group.soakMinutes < 0)) reasons.push({ code: "INVALID_SOAK", message: `${group.name} soak must be a nonnegative integer number of minutes.`, remediation: "Set soakMinutes to 0 or a positive integer; no gate can release with an invalid soak." });
    if (group.maxParallel !== undefined && (!Number.isInteger(group.maxParallel) || group.maxParallel <= 0)) reasons.push({ code: "INVALID_PARALLELISM", message: `${group.name} maxParallel must be a positive integer.`, remediation: "Set maxParallel to at least 1." });
    blockers.push(...reasons.map((reason) => ({ ...reason, groupId: group.id, severity: "blocker" })));
    return [group.id, reasons];
  }));
  const groupOrder = new Map([...groups.values()].map((group) => [group.id, group.order]));
  const operations = [];
  const opByKey = new Map();
  const effectiveIds = effectivePatchIds(data, blockers);
  const changeWindow = data.policy?.changeWindow || { start: "02:00", end: "04:00", timezone: "UTC" };
  const bounds = windowMinutes(changeWindow);
  const validWindow = Number.isFinite(bounds.startMinute) && Number.isFinite(bounds.endMinute) && bounds.endMinute > bounds.startMinute && (!changeWindow.timezone || changeWindow.timezone === "UTC");
  if (!validWindow) blockers.push({ code: "INVALID_WINDOW", severity: "blocker", message: "Use a same-day UTC window with start before end (HH:MM)." });

  for (const hostId of [...new Set(data.selection.hostIds || [])].sort()) {
    const host = hosts.get(hostId);
    if (!host) { blockers.push({ code: "UNKNOWN_HOST", severity: "blocker", hostId, message: `Selected host ${hostId} does not exist.` }); continue; }
    const group = groups.get(host.groupId);
    if (!group) { blockers.push({ code: "UNKNOWN_GROUP", severity: "blocker", hostId, message: `${hostId} is not assigned to a rollout group.` }); continue; }
    for (const patchId of [...effectiveIds].sort()) {
      const patch = patches.get(patchId);
      if (!patch) { blockers.push({ code: "UNKNOWN_PATCH", severity: "blocker", patchId, message: `Selected patch ${patchId} does not exist.` }); continue; }
      const op = { id: keyFor(hostId, patchId), hostId, patchId, hostName: host.name, patchName: patch.name, groupId: group.id, groupName: group.name, risk: riskWeight[host.risk] + riskWeight[patch.risk], status: "ready", reasons: [], rebootRequired: patch.rebootRequired, rollback: patch.rollback };
      if (!validGroupOrders) block(op, "GROUP_ORDER_CONFLICT", "Resolve duplicate or invalid rollout group orders before scheduling.");
      for (const reason of groupReasons.get(group.id)) block(op, reason.code, reason.message, reason.remediation);
      if (!validWindow) block(op, "INVALID_WINDOW", "This operation cannot be placed in an invalid change window.");
      if (blockers.some((reason) => reason.code === "CONFLICT_UNRESOLVED") && data.conflicts.some((conflict) => conflict.members.includes(patchId) && !conflict.options?.some((option) => option.id === data.selection.conflictChoices?.[conflict.id]))) block(op, "CONFLICT_UNRESOLVED", "Resolve the mutually exclusive patch provider selection first.");
      operations.push(op); opByKey.set(op.id, op);
    }
  }

  const edges = new Map(operations.map((op) => [op.id, new Set()]));
  for (const op of operations) {
    const patch = patches.get(op.patchId);
    for (const dependencyId of patch.requiresPatchIds || []) {
      const dependency = opByKey.get(keyFor(op.hostId, dependencyId));
      if (!dependency) {
        op.status = "blocked";
        op.reasons.push({ code: "DEPENDENCY_BLOCKED", message: `${patch.name} requires ${patches.get(dependencyId)?.name || dependencyId} on the same host.` });
      } else addEdge(edges, dependency.id, op.id);
    }
    for (const dependencyHostId of hosts.get(op.hostId)?.requiresHealthyHosts || []) {
      const dependencyOps = operations.filter((candidate) => candidate.hostId === dependencyHostId);
      if (!dependencyOps.length) {
        op.status = "blocked";
        op.reasons.push({ code: "HOST_DEPENDENCY_BLOCKED", message: `${op.hostId} requires ${dependencyHostId} to be healthy first.` });
      } else for (const dependency of dependencyOps) addEdge(edges, dependency.id, op.id);
    }
  }
  for (const op of operations) {
    for (const other of operations) {
      if ((groupOrder.get(other.groupId) ?? 99) < (groupOrder.get(op.groupId) ?? 99)) addEdge(edges, other.id, op.id);
    }
  }
  const cycle = findCycle(operations.map((op) => op.id), edges);
  if (cycle) for (const op of operations) block(op, "DEPENDENCY_CYCLE", `Dependency cycle: ${cycle.join(" → ")}`, "Remove the cyclic prerequisite or conflicting group order before scheduling.");
  for (const op of operations) op.dependencies = [...edges.get(op.id)].sort();

  const ordered = [];
  const waves = [];
  const groupGates = [];
  let cursor = bounds.startMinute;
  // Conservative wave barrier: a wave completes its apply/reboot/health checks
  // before the next starts. Independent hosts can share a wave; one host cannot.
  for (const group of [...groups.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const groupOps = operations.filter((op) => op.groupId === group.id);
    if (!groupOps.length) continue;
    const remaining = new Map(groupOps.map((op) => [op.id, op]));
    const priorBlockedGate = groupGates.find((gate) => gate.status === "blocked" && gate.order < group.order);
    while (remaining.size) {
      let removed = false;
      for (const op of remaining.values()) {
        const blockedDeps = op.dependencies.filter((id) => opByKey.get(id).status === "blocked");
        if (op.status !== "blocked" && (blockedDeps.length || priorBlockedGate)) block(op, "DEPENDENCY_BLOCKED", blockedDeps.length ? `Blocked prerequisite: ${blockedDeps.join(", ")}.` : `Group gate ${priorBlockedGate.name} cannot release.`, "Resolve the prerequisite blockers, then recalculate the plan.");
        if (op.status === "blocked") { remaining.delete(op.id); removed = true; }
      }
      const available = [...remaining.values()].filter((op) => op.dependencies.every((id) => !!opByKey.get(id).schedule)).sort((a, b) => stableOperationSort(a, b, groupOrder));
      if (!available.length) {
        if (removed) continue;
        for (const op of remaining.values()) block(op, "DEPENDENCY_BLOCKED", "No completed prerequisite path is available.");
        remaining.clear(); break;
      }
      const batch = [];
      const batchHosts = new Set();
      for (const op of available) {
        if (batch.length >= Math.max(1, group.maxParallel || 1)) break;
        if (batchHosts.has(op.hostId)) continue;
        const patch = patches.get(op.patchId);
        const projected = projectedHost(hosts.get(op.hostId), op, opByKey, edges, patches);
        op.projectedBefore = { release: projected.release, architecture: projected.architecture, abi: projected.abi, installedKernel: projected.installedKernel, runningKernel: projected.runningKernel, kernelKbi: projected.kernelKbi };
        checkCompatibility(op, patch, projected);
        if (op.status !== "blocked") {
          const qualified = projectedHost(hosts.get(op.hostId), op, opByKey, edges, patches, true);
          const check = { status: "ready", reasons: [] };
          checkCompatibility(check, patch, qualified);
          if (check.status === "blocked") block(op, "COMPATIBILITY_PREREQUISITE_REQUIRED", "Compatibility depends on an earlier unrelated change, not an explicit prerequisite.", "Add the ABI/kernel-changing patch to requiresPatchIds before scheduling this operation.");
        }
        const duration = patch.durationMinutes ?? 10;
        const rebootDuration = patch.rebootRequired ? (patch.rebootMinutes ?? 10) : 0;
        if (!Number.isInteger(duration) || duration <= 0 || !Number.isInteger(rebootDuration) || rebootDuration < 0 || (patch.rebootRequired && rebootDuration === 0)) block(op, "INVALID_DURATION", "Apply and required reboot durations must be positive integer minutes.");
        const applyEnd = cursor + duration;
        const end = applyEnd + rebootDuration;
        // Report both incompatibility and placement problems at a boundary.
        if (end > bounds.endMinute) {
          block(op, "WINDOW_EXCEEDED", `Earliest slot ${formatMinute(cursor)}–${formatMinute(end)} exceeds window close ${changeWindow.end} UTC.`, "Choose a longer change window or a smaller patch set; no reboot is scheduled outside the window.");
          Object.assign(op.reasons.at(-1), { earliestStartMinute: cursor, earliestEndMinute: end });
        }
        remaining.delete(op.id);
        if (op.status === "blocked") continue;
        op.schedule = { startMinute: cursor, applyEndMinute: applyEnd, endMinute: end, reboot: rebootDuration ? { startMinute: applyEnd, endMinute: end } : null };
        op.waveNumber = waves.length + 1;
        batch.push(op); batchHosts.add(op.hostId);
      }
      if (batch.length) {
        const endMinute = Math.max(...batch.map((op) => op.schedule.endMinute));
        waves.push({ number: waves.length + 1, groupId: group.id, groupName: group.name, canary: !!group.canary, operations: batch, startMinute: cursor, endMinute, locked: groupGates.some((gate) => gate.canary), soakMinutes: 0 });
        ordered.push(...batch); cursor = endMinute;
      }
    }
    const soakMinutes = Number.isInteger(group.soakMinutes) && group.soakMinutes >= 0 ? group.soakMinutes : 0;
    const blocked = groupOps.some((op) => op.status === "blocked") || groupReasons.get(group.id).length > 0;
    const proposedReleaseMinute = blocked ? null : cursor + soakMinutes;
    const soakOverflow = proposedReleaseMinute !== null && proposedReleaseMinute > bounds.endMinute;
    const reasons = [...groupReasons.get(group.id)];
    if (blocked && !reasons.length) reasons.push({ code: "GROUP_BLOCKED", message: "Selected operations or prerequisite group gates are blocked; resolve the listed blockers." });
    if (soakOverflow) {
      const reason = { code: "SOAK_WINDOW_EXCEEDED", message: `${group.name} soak would end at ${formatMinute(proposedReleaseMinute)}, after window close ${changeWindow.end}.`, remediation: "Extend the window so the final health-check soak completes before production." };
      reasons.push(reason); blockers.push({ ...reason, severity: "blocker", groupId: group.id });
    }
    const releaseMinute = blocked || soakOverflow ? null : proposedReleaseMinute;
    groupGates.push({ groupId: group.id, name: group.name, order: group.order, canary: !!group.canary, hostIds: [...new Set(groupOps.map((op) => op.hostId))].sort(), status: blocked || soakOverflow ? "blocked" : "pending", reasons, soakMinutes, soakStartMinute: blocked ? null : cursor, proposedReleaseMinute, releaseMinute });
    if (releaseMinute !== null) cursor = releaseMinute;
  }
  for (const op of operations) if (op.status === "blocked") blockers.push(...op.reasons.map((reason) => ({ ...reason, severity: "blocker", hostId: op.hostId, patchId: op.patchId, message: `${op.hostName} / ${op.patchName}: ${reason.message}` })));
  const hostStatuses = {};
  for (const host of data.hosts) {
    const hostOps = operations.filter((op) => op.hostId === host.id);
    const blocked = hostOps.filter((op) => op.status === "blocked");
    hostStatuses[host.id] = blocked.length ? { status: blocked.some((op) => op.reasons.some((reason) => reason.code === "ABI_MISMATCH")) ? "abi-blocked" : "blocked", reasons: blocked.flatMap((op) => op.reasons) } : { status: hostOps.length ? "ready" : "out-of-scope", reasons: [] };
    if (host.installedKernel !== host.runningKernel) hostStatuses[host.id].rebootPending = true;
  }
  for (const host of data.hosts) if (host.installedKernel !== host.runningKernel) warnings.push({ code: "REBOOT_PENDING", hostId: host.id, message: `${host.name} has an installed kernel that is not running yet.` });
  const totalRisk = operations.reduce((sum, op) => sum + op.risk, 0);
  return {
    generatedAt: "deterministic-demo", selectedPatchIds: [...effectiveIds].sort(), blockers, warnings,
    changeWindow: { ...changeWindow, ...bounds }, groupGates, canaryGroups: groupGates.filter((gate) => gate.canary),
    operations, orderedOperations: ordered, waves, hostStatuses, totalRisk,
    summary: { hostCount: data.selection.hostIds?.length || 0, operationCount: operations.length, eligibleCount: ordered.length, blockerCount: blockers.length, waveCount: waves.length },
    rollbackPaths: [...ordered].reverse().map((op, index) => ({ operationId: op.id, patchName: op.patchName, hostId: op.hostId, hostName: op.hostName, methods: op.rollback?.methods || ["manual recovery"], requiresReboot: !!op.rollback?.requiresReboot, order: index + 1, waveNumber: op.waveNumber }))
  };
}

export function simulateRollout(plan, outcomes = {}, options = {}) {
  const haltOnFailure = options.haltOnFailure ?? true;
  const hostStates = {};
  const operationStates = {};
  const applied = new Set();
  const gateStates = Object.fromEntries(plan.canaryGroups.map((gate) => [gate.groupId, gate.status]));
  let halted = false;
  let failingWave = null;
  for (const wave of plan.waves) {
    const waveGroupOrder = plan.groupGates.find((gate) => gate.groupId === wave.groupId).order;
    const blockedGate = plan.canaryGroups.some((gate) => gateStates[gate.groupId] === "blocked" && gate.order < waveGroupOrder);
    const skipWave = halted || blockedGate;
    let waveFailed = false;
    for (const op of wave.operations) {
      const outcome = outcomes[op.id] || outcomes[op.hostId] || "healthy";
      const failedDependency = op.dependencies.some((id) => operationStates[id] !== "healthy");
      if (skipWave || failedDependency) { operationStates[op.id] = "pending"; if (!(op.hostId in hostStates)) hostStates[op.hostId] = "pending"; continue; }
      const state = outcome === "failed-before-apply" ? "failed-before-apply" : outcome === "failed-after-apply" ? "failed-after-apply" : outcome === "health-check-failed" ? "health-check-failed" : "healthy";
      operationStates[op.id] = state;
      const earlierFailure = hostStates[op.hostId]?.startsWith("failed-") || hostStates[op.hostId] === "health-check-failed";
      if (!earlierFailure) hostStates[op.hostId] = state;
      if (state !== "failed-before-apply") applied.add(op.id);
      if (state !== "healthy") { failingWave ??= wave.number; waveFailed = true; }
    }
    if (waveFailed && (haltOnFailure || wave.canary)) halted = true;
    if (wave.canary && waveFailed) gateStates[wave.groupId] = "failed";
    const lastGroupWave = !plan.waves.some((later) => later.groupId === wave.groupId && later.number > wave.number);
    if (wave.canary && lastGroupWave && !skipWave && !waveFailed && gateStates[wave.groupId] !== "failed" && gateStates[wave.groupId] !== "blocked") gateStates[wave.groupId] = "passed";
  }
  for (const operation of plan.operations.filter((op) => op.status === "blocked")) {
    operationStates[operation.id] = "blocked";
    if (!(operation.hostId in hostStates)) hostStates[operation.hostId] = "blocked";
  }
  const failedHosts = Object.entries(hostStates).filter(([, state]) => state.startsWith("failed-") || state === "health-check-failed").map(([hostId]) => hostId);
  const rollbackPolicy = options.rollbackPolicy || "rollback-failed-wave";
  const rollbackIds = new Set();
  if (failedHosts.length) {
    if (rollbackPolicy === "rollback-failed-host") for (const op of plan.orderedOperations) {
      if (failedHosts.includes(op.hostId) && applied.has(op.id)) rollbackIds.add(op.id);
    }
    else if (rollbackPolicy === "rollback-failed-wave") {
      for (const op of plan.waves.find((wave) => wave.number === failingWave).operations) if (applied.has(op.id)) rollbackIds.add(op.id);
    } else if (rollbackPolicy === "rollback-all-successful") for (const op of plan.orderedOperations) if (applied.has(op.id)) rollbackIds.add(op.id);
  }
  const rollbackSteps = plan.rollbackPaths.filter((path) => rollbackIds.has(path.operationId));
  const rollback = [...new Set(rollbackSteps.map((path) => path.hostId))].map((hostId) => ({ hostId, state: "rollback-pending", methods: [...new Set(rollbackSteps.filter((path) => path.hostId === hostId).flatMap((path) => path.methods))], requiresReboot: rollbackSteps.some((path) => path.hostId === hostId && path.requiresReboot) }));
  return { operationStates, hostStates, halted, failingWave, failedHosts, gateStates, rollbackPolicy, rollback, rollbackSteps, status: failedHosts.length ? "partial-failure" : plan.blockers.length ? "blocked" : "healthy" };
}
