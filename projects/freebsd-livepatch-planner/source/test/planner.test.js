import test from "node:test";
import assert from "node:assert/strict";
import { createDemoData, planRollout, simulateRollout, cloneData } from "../src/planner.js";

function oneHostData(hostId = "edge-01", patchIds = ["base-p7"]) {
  const data = createDemoData();
  data.conflicts = [];
  data.selection.conflictChoices = {};
  data.selection.hostIds = [hostId];
  data.selection.patchIds = patchIds;
  return data;
}

function patchFor(host, overrides = {}) {
  return {
    id: "test-patch",
    name: "Test patch",
    kind: "package",
    appliesTo: { releases: [host.release], architectures: [host.architecture], abi: host.abi },
    target: { release: host.release },
    requiresPatchIds: [],
    rebootRequired: false,
    durationMinutes: 1,
    risk: "low",
    rollback: { methods: ["package snapshot"], requiresReboot: false },
    ...overrides
  };
}

test("orders patch dependencies and host health dependencies deterministically", () => {
  const data = createDemoData();
  data.policy.changeWindow.end = "06:00";
  const plan = planRollout(data);
  const ids = plan.orderedOperations.map((operation) => operation.id);

  assert.equal(plan.blockers.some((blocker) => blocker.code === "DEPENDENCY_CYCLE"), false);
  assert.ok(ids.indexOf("edge-01::base-p7") < ids.indexOf("api-01::base-p7"));
  assert.ok(ids.indexOf("api-01::base-p7") < ids.indexOf("worker-01::base-p7"));
  assert.ok(ids.indexOf("api-01::base-p7") < ids.indexOf("api-01::crypto-modern"));
  assert.deepEqual(ids, planRollout(data).orderedOperations.map((operation) => operation.id));
});

test("marks an incompatible ABI as a hard blocker without blocking compatible hosts", () => {
  const data = createDemoData();
  const plan = planRollout(data);
  const legacyBlocker = plan.blockers.find((blocker) => blocker.hostId === "legacy-01" && blocker.code === "ABI_MISMATCH");

  assert.ok(legacyBlocker);
  assert.match(legacyBlocker.message, /FreeBSD:14:amd64/);
  assert.equal(plan.hostStatuses["legacy-01"].status, "abi-blocked");
  assert.equal(plan.hostStatuses["edge-01"].status, "ready");
  assert.equal(plan.operations.find((operation) => operation.id === "legacy-01::base-p7").status, "blocked");
});

test("what-if conflict choices replace the selected provider without mutating the fixture", () => {
  const data = createDemoData();
  const original = cloneData(data);
  const whatIf = cloneData(data);
  whatIf.selection.conflictChoices["openssl-provider"] = "legacy";
  const legacyPlan = planRollout(whatIf);

  assert.deepEqual(data, original);
  assert.ok(legacyPlan.selectedPatchIds.includes("crypto-legacy"));
  assert.equal(legacyPlan.selectedPatchIds.includes("crypto-modern"), false);
});

test("partial rollout failure halts the canary gate and preserves pending hosts", () => {
  const data = createDemoData();
  data.policy.changeWindow.end = "06:00";
  const plan = planRollout(data);
  const result = simulateRollout(plan, { "edge-01": "health-check-failed" }, { rollbackPolicy: "rollback-failed-wave" });

  assert.equal(result.status, "partial-failure");
  assert.equal(result.halted, true);
  assert.equal(result.hostStates["edge-01"], "health-check-failed");
  assert.equal(result.hostStates["api-01"], "pending");
  assert.equal(result.hostStates["worker-01"], "pending");
  assert.deepEqual(result.rollback.map((item) => item.hostId), ["edge-01"]);
});

test("an after-apply failure leaves successful and unstarted hosts distinct", () => {
  const data = createDemoData();
  data.policy.changeWindow.end = "06:00";
  data.groups[0].hostIds = ["edge-01"];
  data.groups[1].hostIds = ["api-01", "worker-01"];
  const plan = planRollout(data);
  const result = simulateRollout(plan, { "api-01": "failed-after-apply" }, { rollbackPolicy: "rollback-failed-host" });

  assert.equal(result.hostStates["edge-01"], "healthy");
  assert.equal(result.hostStates["api-01"], "failed-after-apply");
  assert.equal(result.hostStates["worker-01"], "pending");
  assert.deepEqual(result.rollback.map((item) => item.hostId), ["api-01"]);
});

test("an ABI-incompatible patch at the exact window close and its dependent are never scheduled", () => {
  const data = oneHostData("edge-01", ["window-fill", "abi-at-close", "after-abi"]);
  const host = data.hosts.find((item) => item.id === "edge-01");
  data.patches.push(
    patchFor(host, { id: "window-fill", name: "Window-filling patch", durationMinutes: 120 }),
    patchFor(host, {
      id: "abi-at-close",
      name: "ABI-incompatible patch",
      requiresPatchIds: ["window-fill"],
      appliesTo: { releases: [host.release], architectures: [host.architecture], abi: "FreeBSD:99:amd64" }
    }),
    patchFor(host, { id: "after-abi", name: "Dependent patch", requiresPatchIds: ["abi-at-close"] })
  );

  const plan = planRollout(data);
  const incompatible = plan.operations.find((operation) => operation.id === "edge-01::abi-at-close");
  const dependent = plan.operations.find((operation) => operation.id === "edge-01::after-abi");

  assert.equal(incompatible.status, "blocked");
  assert.ok(incompatible.reasons.some((reason) => reason.code === "ABI_MISMATCH"));
  assert.ok(incompatible.reasons.some((reason) => reason.code === "WINDOW_EXCEEDED"));
  assert.ok(!incompatible.schedule);
  assert.equal(dependent.status, "blocked");
  assert.ok(dependent.reasons.some((reason) => reason.code === "DEPENDENCY_BLOCKED"));
  assert.ok(!dependent.schedule);
  assert.deepEqual(plan.orderedOperations.map((operation) => operation.id), ["edge-01::window-fill"]);
  assert.equal(plan.orderedOperations[0].schedule.endMinute, 240);

  const exported = JSON.parse(JSON.stringify({ exportedAt: "deterministic-demo", model: data, plan }));
  assert.deepEqual(exported.model, data);
  assert.deepEqual(exported.plan, plan);
  assert.deepEqual(planRollout(exported.model), plan);
  for (const candidate of [plan, exported.plan, planRollout(exported.model)]) {
    const gate = candidate.canaryGroups.find((group) => group.groupId === "canary");
    assert.equal(gate.status, "blocked");
    assert.equal(gate.releaseMinute, null);
    for (const operationId of [incompatible.id, dependent.id]) {
      const operation = candidate.operations.find((item) => item.id === operationId);
      assert.equal(operation.status, "blocked");
      assert.ok(!operation.schedule);
      assert.equal(candidate.orderedOperations.some((item) => item.id === operationId), false);
      assert.equal(candidate.rollbackPaths.some((path) => path.operationId === operationId), false);
    }
    const result = simulateRollout(candidate, { "edge-01::window-fill": "failed-after-apply" }, {
      rollbackPolicy: "rollback-all-successful"
    });
    assert.equal(result.operationStates[incompatible.id], "blocked");
    assert.equal(result.operationStates[dependent.id], "blocked");
    assert.deepEqual(result.rollbackSteps.map((step) => step.operationId), ["edge-01::window-fill"]);
  }
});

test("allows an exact-fit reboot ending at the inclusive window close", () => {
  const exact = oneHostData();
  exact.policy.changeWindow.end = "02:35";
  const exactPlan = planRollout(exact);
  const exactOperation = exactPlan.operations.find((operation) => operation.id === "edge-01::base-p7");

  assert.equal(exactOperation.status, "ready");
  assert.deepEqual(exactOperation.schedule, {
    startMinute: 120,
    applyEndMinute: 140,
    endMinute: 155,
    reboot: { startMinute: 140, endMinute: 155 }
  });
  assert.deepEqual(exactPlan.orderedOperations.map((operation) => operation.id), ["edge-01::base-p7"]);
});

test("a window one minute short of the reboot blocks both the patch and its dependent", () => {
  const short = oneHostData();
  short.policy.changeWindow.end = "02:34";
  short.selection.patchIds = ["base-p7", "crypto-modern"];
  const shortPlan = planRollout(short);
  const shortOperation = shortPlan.operations.find((operation) => operation.id === "edge-01::base-p7");
  const shortDependent = shortPlan.operations.find((operation) => operation.id === "edge-01::crypto-modern");

  assert.equal(shortOperation.status, "blocked");
  assert.ok(shortOperation.reasons.some((reason) => reason.code === "WINDOW_EXCEEDED"));
  assert.ok(!shortOperation.schedule);
  assert.equal(shortDependent.status, "blocked");
  assert.deepEqual(shortDependent.dependencies, ["edge-01::base-p7"]);
  assert.ok(shortDependent.reasons.some((reason) => reason.code === "DEPENDENCY_BLOCKED"));
  assert.equal(shortPlan.orderedOperations.length, 0);
});

test("a nonzero operation starting at the exact window close is WINDOW_EXCEEDED", () => {
  const startsAtEnd = oneHostData("edge-01", ["a-window-fill", "b-start-at-end"]);
  const host = startsAtEnd.hosts.find((item) => item.id === "edge-01");
  startsAtEnd.patches.push(
    patchFor(host, { id: "a-window-fill", name: "Window-filling patch", durationMinutes: 120 }),
    patchFor(host, { id: "b-start-at-end", name: "Patch starting at window end", durationMinutes: 1, requiresPatchIds: ["a-window-fill"] })
  );
  const startsAtEndPlan = planRollout(startsAtEnd);
  const endingOperation = startsAtEndPlan.operations.find((operation) => operation.id === "edge-01::a-window-fill");
  const atEndOperation = startsAtEndPlan.operations.find((operation) => operation.id === "edge-01::b-start-at-end");

  assert.equal(endingOperation.status, "ready");
  assert.deepEqual(endingOperation.schedule, { startMinute: 120, applyEndMinute: 240, endMinute: 240, reboot: null });
  assert.equal(atEndOperation.status, "blocked");
  assert.ok(atEndOperation.reasons.some((reason) => reason.code === "WINDOW_EXCEEDED"));
  assert.equal(startsAtEndPlan.orderedOperations.some((operation) => operation.id === atEndOperation.id), false);
});

test("updates projected KBI only after the base patch reboot, allowing its module prerequisite", () => {
  const data = oneHostData("edge-01", ["base-p7", "web-kmod-p7"]);
  const host = data.hosts.find((item) => item.id === "edge-01");
  host.installedKernel = "14.3-RELEASE-p6";
  host.runningKernel = "14.3-RELEASE-p6";
  host.kernelKbi = "14.3-p6-kbi";
  const plan = planRollout(data);
  const base = plan.operations.find((operation) => operation.id === "edge-01::base-p7");
  const module = plan.operations.find((operation) => operation.id === "edge-01::web-kmod-p7");

  assert.equal(base.status, "ready");
  assert.equal(module.status, "ready");
  assert.deepEqual(module.dependencies, ["edge-01::base-p7"]);
  assert.equal(module.reasons.some((reason) => reason.code === "KBI_MISMATCH"), false);
  assert.deepEqual(plan.orderedOperations.map((operation) => operation.id), ["edge-01::base-p7", "edge-01::web-kmod-p7"]);
  assert.equal(module.schedule.startMinute, base.schedule.endMinute);
  assert.equal(module.schedule.reboot.startMinute, module.schedule.applyEndMinute);
});

test("projects a prerequisite release and ABI only after its scheduled reboot completes", () => {
  const data = oneHostData("edge-01", ["release-upgrade", "new-release-package"]);
  const host = data.hosts.find((item) => item.id === "edge-01");
  data.patches.push(
    patchFor(host, {
      id: "release-upgrade",
      name: "Release upgrade",
      rebootRequired: true,
      durationMinutes: 20,
      rebootMinutes: 15,
      target: { release: "15.0-RELEASE", abi: "FreeBSD:15:amd64" }
    }),
    patchFor(host, {
      id: "new-release-package",
      name: "New release package",
      requiresPatchIds: ["release-upgrade"],
      appliesTo: { releases: ["15.0-RELEASE"], architectures: [host.architecture], abi: "FreeBSD:15:amd64" },
      target: { release: "15.0-RELEASE" }
    })
  );

  const plan = planRollout(data);
  const upgrade = plan.operations.find((operation) => operation.id === "edge-01::release-upgrade");
  const packageOperation = plan.operations.find((operation) => operation.id === "edge-01::new-release-package");

  assert.equal(upgrade.status, "ready");
  assert.equal(packageOperation.status, "ready");
  assert.equal(packageOperation.reasons.length, 0);
  assert.equal(packageOperation.schedule.startMinute, upgrade.schedule.endMinute);
});

test("an actual earlier unrelated same-host ABI upgrade invalidates an old-ABI package", () => {
  const data = oneHostData("edge-01", ["a-abi-upgrade", "b-old-abi-package"]);
  const host = data.hosts.find((item) => item.id === "edge-01");
  data.patches.push(
    patchFor(host, {
      id: "a-abi-upgrade",
      rebootRequired: true,
      durationMinutes: 20,
      rebootMinutes: 15,
      target: { release: host.release, abi: "FreeBSD:15:amd64" }
    }),
    patchFor(host, { id: "b-old-abi-package" })
  );

  const plan = planRollout(data);
  const upgrade = plan.operations.find((operation) => operation.id === "edge-01::a-abi-upgrade");
  const oldPackage = plan.operations.find((operation) => operation.id === "edge-01::b-old-abi-package");

  assert.equal(upgrade.status, "ready");
  assert.equal(upgrade.schedule.endMinute, 155);
  assert.deepEqual(oldPackage.dependencies, []);
  assert.equal(oldPackage.status, "blocked");
  assert.ok(oldPackage.reasons.some((reason) => reason.code === "ABI_MISMATCH"));
  assert.ok(!oldPackage.schedule);
  assert.deepEqual(plan.orderedOperations.map((operation) => operation.id), [upgrade.id]);
  assert.equal(plan.rollbackPaths.some((path) => path.operationId === oldPackage.id), false);
});

test("an unrelated ABI update cannot establish compatibility without an explicit prerequisite", () => {
  const data = oneHostData("edge-01", ["a-abi-upgrade", "b-new-abi-package", "c-dependent"]);
  const host = data.hosts.find((item) => item.id === "edge-01");
  data.patches.push(
    patchFor(host, {
      id: "a-abi-upgrade",
      rebootRequired: true,
      durationMinutes: 20,
      rebootMinutes: 15,
      target: { release: host.release, abi: "FreeBSD:15:amd64" }
    }),
    patchFor(host, {
      id: "b-new-abi-package",
      appliesTo: { releases: [host.release], architectures: [host.architecture], abi: "FreeBSD:15:amd64" }
    }),
    patchFor(host, {
      id: "c-dependent",
      requiresPatchIds: ["b-new-abi-package"],
      appliesTo: { releases: [host.release], architectures: [host.architecture], abi: "FreeBSD:15:amd64" }
    })
  );

  const plan = planRollout(data);
  const upgrade = plan.operations.find((operation) => operation.id === "edge-01::a-abi-upgrade");
  const newPackage = plan.operations.find((operation) => operation.id === "edge-01::b-new-abi-package");
  const dependent = plan.operations.find((operation) => operation.id === "edge-01::c-dependent");

  assert.equal(upgrade.status, "ready");
  assert.deepEqual(newPackage.dependencies, []);
  assert.equal(newPackage.status, "blocked");
  assert.ok(newPackage.reasons.some((reason) => reason.code === "COMPATIBILITY_PREREQUISITE_REQUIRED"));
  assert.ok(plan.blockers.some((blocker) => blocker.code === "COMPATIBILITY_PREREQUISITE_REQUIRED"
    && blocker.hostId === host.id && blocker.patchId === newPackage.patchId));
  assert.ok(!newPackage.schedule);
  assert.equal(dependent.status, "blocked");
  assert.ok(dependent.reasons.some((reason) => reason.code === "DEPENDENCY_BLOCKED"));
  assert.ok(!dependent.schedule);
  assert.deepEqual(plan.orderedOperations.map((operation) => operation.id), [upgrade.id]);

  const explicit = cloneData(data);
  explicit.patches.find((patch) => patch.id === "b-new-abi-package").requiresPatchIds = ["a-abi-upgrade"];
  const explicitPlan = planRollout(explicit);
  assert.equal(explicitPlan.blockers.length, 0);
  assert.deepEqual(explicitPlan.orderedOperations.map((operation) => operation.id), [upgrade.id, newPackage.id, dependent.id]);
  assert.equal(explicitPlan.operations.find((operation) => operation.id === newPackage.id).schedule.startMinute,
    explicitPlan.operations.find((operation) => operation.id === upgrade.id).schedule.endMinute);
});

test("produces identical operation order and waves when source arrays and selections are shuffled", () => {
  const data = createDemoData();
  data.conflicts = [];
  data.selection.conflictChoices = {};
  data.selection.hostIds = ["edge-01", "api-01", "worker-01"];
  data.selection.patchIds = ["base-p7", "crypto-modern"];
  data.policy.changeWindow.end = "06:00";
  const shuffled = cloneData(data);
  shuffled.hosts.reverse();
  shuffled.patches.reverse();
  shuffled.groups.reverse();
  shuffled.selection.hostIds.reverse();
  shuffled.selection.patchIds.reverse();

  const describeWaves = (plan) => plan.waves.map((wave) => ({
    number: wave.number,
    groupId: wave.groupId,
    operationIds: wave.operations.map((operation) => operation.id)
  }));

  const plan = planRollout(data);
  const shuffledPlan = planRollout(shuffled);
  assert.equal(plan.orderedOperations.length, 6);
  assert.deepEqual(shuffledPlan.orderedOperations.map((operation) => operation.id), plan.orderedOperations.map((operation) => operation.id));
  assert.deepEqual(describeWaves(shuffledPlan), describeWaves(plan));
});

test("reports a self-dependent patch as a cycle and schedules no operation from it", () => {
  const data = oneHostData("edge-01", ["self-cycle"]);
  const host = data.hosts.find((item) => item.id === "edge-01");
  data.patches.push(patchFor(host, { id: "self-cycle", name: "Self cycle", requiresPatchIds: ["self-cycle"] }));

  const plan = planRollout(data);

  assert.ok(plan.blockers.some((blocker) => blocker.code === "DEPENDENCY_CYCLE"));
  assert.equal(plan.orderedOperations.length, 0);
  assert.equal(plan.waves.length, 0);
});

test("a blocked canary suppresses production operations and propagates a dependency blocker", () => {
  const data = createDemoData();
  data.conflicts = [];
  data.selection.conflictChoices = {};
  data.selection.hostIds = ["edge-01", "api-01"];
  data.selection.patchIds = ["base-p7"];
  data.hosts.find((host) => host.id === "edge-01").abi = "FreeBSD:13:amd64";
  data.hosts.find((host) => host.id === "api-01").requiresHealthyHosts = [];

  const plan = planRollout(data);
  const production = plan.operations.find((operation) => operation.id === "api-01::base-p7");
  const canaryGroup = plan.canaryGroups?.find((group) => group.groupId === "canary");

  assert.ok(canaryGroup, "plan exposes the blocked canary group");
  assert.equal(canaryGroup.status, "blocked");
  assert.equal(production.status, "blocked");
  assert.ok(production.reasons.some((reason) => reason.code === "DEPENDENCY_BLOCKED"));
  assert.equal(plan.orderedOperations.some((operation) => operation.id === production.id), false);
});

test("schedules one canary soak after the group's last operation", () => {
  const data = oneHostData("edge-01", ["base-p7", "web-kmod-p7"]);
  const plan = planRollout(data);
  const canary = plan.canaryGroups?.find((group) => group.groupId === "canary");
  assert.ok(canary, "plan exposes the pending canary group");
  const operations = plan.orderedOperations.filter((operation) => operation.groupId === "canary");
  assert.equal(operations.length, 2);
  assert.equal(operations[1].schedule.startMinute, operations[0].schedule.endMinute);
  const lastOperationEnd = Math.max(...operations.map((operation) => operation.schedule.endMinute));

  assert.deepEqual(canary.hostIds, ["edge-01"]);
  assert.equal(canary.status, "pending");
  assert.equal(canary.soakMinutes, 15);
  assert.equal(canary.releaseMinute, lastOperationEnd + canary.soakMinutes);
});

test("later groups wait for all earlier operations and the single final canary soak", () => {
  const data = oneHostData("edge-01", ["base-p7", "web-kmod-p7"]);
  data.selection.hostIds.push("api-01");
  data.hosts.find((host) => host.id === "api-01").requiresHealthyHosts = [];
  data.policy.changeWindow.end = "06:00";

  const plan = planRollout(data);
  const canary = plan.canaryGroups?.find((group) => group.groupId === "canary");
  assert.ok(canary, "plan exposes the canary release time");
  const production = plan.orderedOperations.filter((operation) => operation.groupId === "production");

  assert.equal(production.length, 2);
  assert.equal(canary.releaseMinute, 195);
  assert.equal(production[0].schedule.startMinute, canary.releaseMinute);
  assert.ok(production.every((operation) => operation.schedule.startMinute >= canary.releaseMinute));
  assert.ok(production[0].dependencies.includes("edge-01::base-p7"));
  assert.ok(production[0].dependencies.includes("edge-01::web-kmod-p7"));
});

test("rollback paths reverse ordered operations and start numbering at one", () => {
  const data = oneHostData("edge-01", ["base-p7", "web-kmod-p7"]);
  const plan = planRollout(data);
  const orderedIds = plan.orderedOperations.map((operation) => operation.id);

  assert.deepEqual(
    plan.rollbackPaths.map((path) => ({ operationId: path.operationId, order: path.order })),
    orderedIds.slice().reverse().map((operationId, index) => ({ operationId, order: index + 1 }))
  );
});

test("rollback-failed-wave excludes an earlier successful canary and a pending worker", () => {
  const data = createDemoData();
  data.conflicts = [];
  data.selection.conflictChoices = {};
  data.selection.hostIds = ["edge-01", "api-01", "worker-01"];
  data.selection.patchIds = ["base-p7"];
  const plan = planRollout(data);
  const result = simulateRollout(plan, { "api-01": "failed-after-apply" }, { rollbackPolicy: "rollback-failed-wave" });

  assert.equal(result.hostStates["edge-01"], "healthy");
  assert.equal(result.hostStates["api-01"], "failed-after-apply");
  assert.equal(result.hostStates["worker-01"], "pending");
  assert.deepEqual(result.rollback.map((item) => item.hostId), ["api-01"]);
});

for (const rollbackPolicy of ["rollback-failed-wave", "rollback-failed-host"]) {
  test(`${rollbackPolicy} scopes rollback steps for earlier success and later failure on the same host`, () => {
    const data = oneHostData("api-01", ["base-p7", "crypto-modern"]);
    data.hosts.find((host) => host.id === "api-01").requiresHealthyHosts = [];
    const plan = planRollout(data);
    assert.equal(plan.blockers.length, 0);
    assert.deepEqual(plan.waves.map((wave) => wave.operations.map((operation) => operation.id)), [
      ["api-01::base-p7"],
      ["api-01::crypto-modern"]
    ]);

    const result = simulateRollout(plan, { "api-01::crypto-modern": "failed-after-apply" }, { rollbackPolicy });

    assert.equal(result.operationStates["api-01::base-p7"], "healthy");
    assert.equal(result.operationStates["api-01::crypto-modern"], "failed-after-apply");
    assert.equal(result.status, "partial-failure");
    assert.equal(result.failingWave, 2);
    assert.deepEqual(result.rollback.map((item) => item.hostId), ["api-01"]);
    assert.deepEqual(result.rollbackSteps.map((step) => step.operationId), rollbackPolicy === "rollback-failed-wave"
      ? ["api-01::crypto-modern"]
      : ["api-01::crypto-modern", "api-01::base-p7"]);
  });
}

for (const soakMinutes of [-40, 1.5, "15", null]) {
  test(`invalid soakMinutes ${JSON.stringify(soakMinutes)} blocks the group gate and downstream scheduling`, () => {
    const data = oneHostData();
    data.selection.hostIds.push("api-01");
    data.hosts.find((host) => host.id === "api-01").requiresHealthyHosts = [];
    data.groups.find((group) => group.id === "canary").soakMinutes = soakMinutes;

    const plan = planRollout(data);
    const gate = plan.canaryGroups.find((group) => group.groupId === "canary");
    const production = plan.operations.find((operation) => operation.id === "api-01::base-p7");

    assert.ok(plan.blockers.some((blocker) => blocker.code === "INVALID_SOAK"
      && blocker.severity === "blocker" && blocker.groupId === "canary"));
    assert.equal(gate.status, "blocked");
    assert.equal(gate.releaseMinute, null);
    assert.equal(production.status, "blocked");
    assert.ok(!production.schedule);
    assert.equal(plan.orderedOperations.some((operation) => operation.groupId === "production"), false);
    assert.ok(plan.orderedOperations.every((operation) => Number.isFinite(operation.schedule.startMinute)
      && operation.schedule.startMinute >= plan.changeWindow.startMinute));
    assert.ok(plan.waves.every((wave) => Number.isFinite(wave.startMinute)
      && wave.startMinute >= plan.changeWindow.startMinute));
    assert.equal(simulateRollout(plan).status, "blocked");
  });
}

test("allows a canary soak ending exactly at the inclusive window close", () => {
  const data = oneHostData();
  data.policy.changeWindow.end = "02:50";
  const plan = planRollout(data);
  const gate = plan.canaryGroups.find((group) => group.groupId === "canary");

  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.orderedOperations.length, 1);
  assert.equal(plan.orderedOperations[0].schedule.endMinute, 155);
  assert.equal(gate.status, "pending");
  assert.equal(gate.soakStartMinute, 155);
  assert.equal(gate.soakMinutes, 15);
  assert.equal(gate.releaseMinute, 170);
  assert.equal(gate.releaseMinute, plan.changeWindow.endMinute);
  const result = simulateRollout(plan);
  assert.equal(result.gateStates.canary, "passed");
  assert.equal(result.status, "healthy");
});

test("an overflowing canary soak blocks gate release and production", () => {
  const data = oneHostData("edge-01", ["base-p7"]);
  data.selection.hostIds.push("api-01");
  data.policy.changeWindow.end = "02:49";
  const plan = planRollout(data);
  assert.ok(plan.blockers.some((reason) => reason.code === "SOAK_WINDOW_EXCEEDED"));
  assert.equal(plan.canaryGroups[0].status, "blocked");
  assert.equal(plan.canaryGroups[0].releaseMinute, null);
  assert.equal(typeof plan.canaryGroups[0].proposedReleaseMinute, "number");
  assert.equal(plan.canaryGroups[0].proposedReleaseMinute, 170);
  assert.ok(plan.canaryGroups[0].proposedReleaseMinute > plan.changeWindow.endMinute);
  const production = plan.operations.find((operation) => operation.id === "api-01::base-p7");
  assert.equal(production.status, "blocked");
  assert.ok(production.reasons.some((reason) => reason.code === "DEPENDENCY_BLOCKED"));
  assert.ok(!production.schedule);
  assert.equal(plan.orderedOperations.some((op) => op.groupId === "production"), false);
  assert.equal(simulateRollout(plan).status, "blocked");
});

for (const { label, order } of [
  { label: "duplicate", order: 1 },
  { label: "fractional", order: 1.5 },
  { label: "string", order: "2" },
  { label: "null", order: null },
  { label: "missing", order: undefined }
]) {
  test(`${label} group order is safely rejected: every group needs a unique integer order`, () => {
    const data = oneHostData();
    data.selection.hostIds.push("api-01");
    data.hosts.find((host) => host.id === "api-01").requiresHealthyHosts = [];
    data.groups.find((group) => group.id === "production").order = order;

    const plan = planRollout(data);

    assert.ok(plan.blockers.some((blocker) => blocker.code === "GROUP_ORDER_CONFLICT"));
    assert.equal(plan.orderedOperations.length, 0);
    assert.equal(plan.waves.length, 0);
    assert.equal(plan.rollbackPaths.length, 0);
    assert.ok(plan.operations.every((operation) => operation.status === "blocked" && !operation.schedule));
    assert.ok(plan.groupGates.every((gate) => gate.status === "blocked" && gate.releaseMinute === null));
    const result = simulateRollout(plan);
    assert.equal(result.status, "blocked");
    assert.ok(plan.operations.every((operation) => result.operationStates[operation.id] === "blocked"));
    assert.deepEqual(result.rollbackSteps, []);
  });
}

test("invalid windows block every operation without emitting NaN placements", () => {
  for (const window of [
    { start: "04:00", end: "02:00", timezone: "UTC" },
    { start: "bad", end: "04:00", timezone: "UTC" },
    { start: "02:00", end: "04:00", timezone: "PST" }
  ]) {
    const data = oneHostData();
    data.policy.changeWindow = window;
    const plan = planRollout(data);
    assert.ok(plan.blockers.some((reason) => reason.code === "INVALID_WINDOW"));
    assert.equal(plan.orderedOperations.length, 0);
    assert.ok(plan.operations.every((op) => op.status === "blocked" && !op.schedule));
  }
});

test("independent hosts share a wave but one host never runs parallel changes", () => {
  const data = oneHostData("api-01", ["base-p7", "crypto-modern"]);
  data.selection.hostIds.push("worker-01");
  for (const host of data.hosts) host.requiresHealthyHosts = [];
  const plan = planRollout(data);
  assert.equal(plan.waves[0].operations.length, 2);
  assert.equal(plan.waves[1].operations.length, 2);
  for (const wave of plan.waves) {
    assert.equal(new Set(wave.operations.map((op) => op.hostId)).size, wave.operations.length);
    assert.ok(wave.endMinute <= plan.changeWindow.endMinute);
  }
});

test("parallel-wave failure preserves successful peers and rolls back only applied operations", () => {
  const data = oneHostData("api-01", ["base-p7"]);
  data.selection.hostIds.push("worker-01");
  for (const host of data.hosts) host.requiresHealthyHosts = [];
  const plan = planRollout(data);
  const partial = simulateRollout(plan, { "api-01": "failed-after-apply" });
  assert.equal(partial.hostStates["worker-01"], "healthy");
  assert.deepEqual(partial.rollback.map((host) => host.hostId), ["worker-01", "api-01"]);
  const before = simulateRollout(plan, { "api-01": "failed-before-apply" });
  assert.deepEqual(before.rollback.map((host) => host.hostId), ["worker-01"]);
});

test("nonhalting simulation skips failed-prerequisite dependents and executes independent work", () => {
  const data = oneHostData("api-01", ["base-p7", "crypto-modern"]);
  data.selection.hostIds.push("worker-01");
  for (const host of data.hosts) host.requiresHealthyHosts = [];
  const plan = planRollout(data);
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.orderedOperations.length, 4);

  const result = simulateRollout(plan, { "api-01::base-p7": "failed-before-apply" }, { haltOnFailure: false });

  assert.equal(result.halted, false);
  assert.equal(result.operationStates["api-01::base-p7"], "failed-before-apply");
  assert.equal(result.operationStates["api-01::crypto-modern"], "pending");
  assert.equal(result.operationStates["worker-01::base-p7"], "healthy");
  assert.equal(result.operationStates["worker-01::crypto-modern"], "healthy");
  assert.equal(result.hostStates["worker-01"], "healthy");
  assert.deepEqual(result.failedHosts, ["api-01"]);
  assert.equal(result.status, "partial-failure");
  assert.equal(result.failingWave, 1);
  assert.equal(result.rollbackSteps.some((step) => step.operationId === "api-01::crypto-modern"), false);
});

test("nonhalting simulation preserves overall failure after later independent success on the same host", () => {
  const data = oneHostData("api-01", ["a-failure", "b-independent"]);
  const host = data.hosts.find((item) => item.id === "api-01");
  host.requiresHealthyHosts = [];
  data.patches.push(patchFor(host, { id: "a-failure" }), patchFor(host, { id: "b-independent" }));
  const plan = planRollout(data);
  assert.equal(plan.blockers.length, 0);
  assert.deepEqual(plan.operations.find((operation) => operation.id === "api-01::b-independent").dependencies, []);

  const result = simulateRollout(plan, { "api-01::a-failure": "failed-after-apply" }, { haltOnFailure: false });

  assert.equal(result.halted, false);
  assert.equal(result.operationStates["api-01::a-failure"], "failed-after-apply");
  assert.equal(result.operationStates["api-01::b-independent"], "healthy");
  assert.equal(result.status, "partial-failure");
  assert.deepEqual(result.failedHosts, ["api-01"]);
  assert.equal(result.failingWave, 1);
});

test("rollback-all-successful never includes pending operations even on an applied host", () => {
  const data = oneHostData("api-01", ["base-p7", "crypto-modern", "after-crypto"]);
  data.selection.hostIds.push("worker-01");
  for (const host of data.hosts) host.requiresHealthyHosts = [];
  const host = data.hosts.find((item) => item.id === "api-01");
  data.patches.push(patchFor(host, { id: "after-crypto", requiresPatchIds: ["crypto-modern"] }));
  const plan = planRollout(data);
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.orderedOperations.length, 6);

  const result = simulateRollout(plan, { "api-01::crypto-modern": "failed-after-apply" }, {
    rollbackPolicy: "rollback-all-successful"
  });

  assert.equal(result.status, "partial-failure");
  assert.equal(result.halted, true);
  assert.equal(result.operationStates["api-01::after-crypto"], "pending");
  assert.equal(result.operationStates["worker-01::after-crypto"], "pending");
  assert.deepEqual(result.rollback.map((item) => item.hostId), ["worker-01", "api-01"]);
  assert.deepEqual(result.rollbackSteps.map((step) => step.operationId), [
    "worker-01::crypto-modern",
    "api-01::crypto-modern",
    "worker-01::base-p7",
    "api-01::base-p7"
  ]);
  assert.ok(result.rollbackSteps.every((step) => ["healthy", "failed-after-apply"].includes(result.operationStates[step.operationId])));
});

test("a completed unrelated kernel reboot invalidates the original KBI for a later module", () => {
  const data = oneHostData("edge-01", ["a-kernel-change", "z-module"]);
  const host = data.hosts.find((item) => item.id === "edge-01");
  data.patches.push(
    patchFor(host, {
      id: "a-kernel-change", rebootRequired: true, rebootMinutes: 5,
      target: { kernel: "14.3-RELEASE-p8", kbi: "14.3-p8-kbi" }
    }),
    patchFor(host, { id: "z-module", requiresKernelKbi: host.kernelKbi })
  );
  const plan = planRollout(data);
  const module = plan.operations.find((op) => op.patchId === "z-module");
  assert.equal(module.status, "blocked");
  assert.ok(module.reasons.some((reason) => reason.code === "KBI_MISMATCH"));
  assert.equal(module.projectedBefore.runningKernel, "14.3-RELEASE-p8");
  assert.equal(module.projectedBefore.kernelKbi, "14.3-p8-kbi");
  assert.equal(plan.rollbackPaths.some((path) => path.operationId === module.id), false);
});

test("every dependency and reboot stays ordered and bounded over patch input permutations", () => {
  for (const patchIds of [
    ["base-p7", "crypto-modern", "web-kmod-p7"],
    ["web-kmod-p7", "base-p7", "crypto-modern"],
    ["crypto-modern", "web-kmod-p7", "base-p7"]
  ]) {
    const data = createDemoData();
    data.conflicts = [];
    data.selection.conflictChoices = {};
    data.selection.hostIds = ["worker-01", "edge-01", "api-01"];
    data.selection.patchIds = patchIds;
    data.policy.changeWindow.end = "06:00";
    const plan = planRollout(data);
    assert.equal(plan.blockers.length, 0);
    const scheduled = new Map(plan.orderedOperations.map((op, index) => [op.id, { op, index }]));
    for (const [index, op] of plan.orderedOperations.entries()) {
      const slot = op.schedule;
      assert.ok(slot.startMinute >= plan.changeWindow.startMinute);
      assert.ok(slot.endMinute <= plan.changeWindow.endMinute);
      assert.ok(slot.startMinute < slot.applyEndMinute && slot.applyEndMinute <= slot.endMinute);
      if (slot.reboot) assert.equal(slot.reboot.startMinute, slot.applyEndMinute);
      for (const depId of op.dependencies) {
        assert.ok(scheduled.get(depId).index < index);
        assert.ok(scheduled.get(depId).op.schedule.endMinute <= slot.startMinute);
      }
      for (const earlier of plan.orderedOperations.slice(0, index).filter((other) => other.hostId === op.hostId)) {
        assert.ok(earlier.schedule.endMinute <= slot.startMinute);
      }
    }
    for (const gate of plan.canaryGroups) for (const op of plan.orderedOperations.filter((item) => item.groupId !== gate.groupId)) {
      assert.ok(op.schedule.startMinute >= gate.releaseMinute);
    }
  }
});
