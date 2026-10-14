// Opt in: BROWSER_SMOKE=1 node --test test/browser-smoke.mjs
// Uses the external Playwright install; adds no workspace dependencies.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createDemoData } from "../src/planner.js";

test("UI browser smoke against the real planner", { skip: !process.env.BROWSER_SMOKE, timeout: 120_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || "/tmp/omnirush/node_modules/playwright/index.mjs").href);
  const root = new URL("../", import.meta.url);
  const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/styles.css": ["styles.css", "text/css"], "/src/planner.js": ["src/planner.js", "text/javascript"] };
  const server = createServer(async (request, response) => {
    const file = files[new URL(request.url, "http://localhost").pathname];
    if (!file) { response.writeHead(404).end(); return; }
    try { response.writeHead(200, { "Content-Type": file[1] }).end(await readFile(new URL(file[0], root))); }
    catch { response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.locator(".op").first().waitFor();

  async function exported() {
    const downloadReady = page.waitForEvent("download");
    await page.locator("#exportBtn").click();
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), "patchline-rollout-plan.json");
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function importJSON(value, valid = true) {
    await page.locator("#importStatus").evaluate((element) => { element.textContent = ""; });
    await page.locator("#fileInput").setInputFiles({ name: "model.json", mimeType: "application/json", buffer: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) });
    await page.waitForFunction(() => document.querySelector("#importStatus").textContent !== "");
    assert.match(await page.locator("#importStatus").innerText(), valid ? /^Imported/ : /^Import rejected:/);
  }
  async function changeTime(id, value) {
    await page.locator(id).fill(value);
    await page.locator(id).dispatchEvent("change");
  }
  async function assertBlockers(snapshot = undefined) {
    const { plan } = snapshot || await exported();
    assert.equal(await page.locator("#blockerList").count(), 1);
    const rendered = await page.locator("#blockerList .blocker-item").allTextContents();
    assert.equal(rendered.length, plan.blockers.length);
    assert.equal(await page.locator("#planState").innerText(), plan.blockers.length ? `${plan.blockers.length} blocker${plan.blockers.length === 1 ? "" : "s"}` : "Plan ready");
    if (plan.blockers.length) assert.equal(Number(await page.locator(".blocker-heading span").innerText()), plan.blockers.length);
    for (const [index, blocker] of plan.blockers.entries()) {
      assert.ok(rendered[index].includes(blocker.code));
      assert.ok(rendered[index].includes(blocker.message));
      if (blocker.remediation) assert.ok(rendered[index].includes(blocker.remediation));
    }
  }
  async function assertRollback(selector, paths) {
    assert.deepEqual(await page.locator(`${selector} .rollback-item`).evaluateAll((items) => items.map((item) => item.dataset.operationId)), paths.map((path) => path.operationId));
    for (const [index, path] of paths.entries()) {
      const item = page.locator(`${selector} .rollback-item`).nth(index);
      const text = await item.innerText();
      assert.equal(Number(await item.locator(".rollback-number").innerText()), path.order);
      for (const value of [path.hostName, path.patchName, ...path.methods, path.requiresReboot ? "reboot required" : "no reboot"]) assert.ok(text.includes(value));
      if (path.methods.length > 1) assert.ok(text.includes("OR"));
    }
  }

  const initial = await exported();
  assert.ok(initial.plan.blockers.length > 0);
  await assertBlockers(initial);
  await page.evaluate(() => { window.smokeBlockerContainer = document.querySelector("#blockerList"); });
  for (const choice of ["legacy", "modern", "defer", "legacy", "modern"]) {
    await page.locator(`[data-conflict="openssl-provider"][value="${choice}"]`).check();
    const snapshot = await exported();
    assert.equal(snapshot.model.selection.conflictChoices["openssl-provider"], choice);
    assert.equal(snapshot.plan.selectedPatchIds.includes("crypto-modern"), choice === "modern");
    assert.equal(snapshot.plan.selectedPatchIds.includes("crypto-legacy"), choice === "legacy");
    await assertBlockers(snapshot);
    assert.equal(await page.evaluate(() => window.smokeBlockerContainer === document.querySelector("#blockerList")), true);
  }

  const firstSlot = initial.plan.waves[0].startMinute;
  await changeTime("#windowStart", "02:10");
  const shifted = await exported();
  assert.equal(shifted.plan.waves[0].startMinute, firstSlot + 10);
  assert.match(await page.locator(".operation-time").first().innerText(), /^02:10/);
  await changeTime("#windowEnd", "06:00");
  const extended = await exported();
  assert.ok(extended.plan.waves.length > shifted.plan.waves.length);
  await assertBlockers(extended);
  const gate = extended.plan.canaryGroups[0];
  assert.equal(await page.locator(".member-chip").innerText(), "edge-01");
  assert.match(await page.locator(".gate-soak").innerText(), /15m/);
  assert.equal(await page.locator(".gate-release").innerText(), `Release ${String(Math.floor(gate.releaseMinute / 60)).padStart(2, "0")}:${String(gate.releaseMinute % 60).padStart(2, "0")}`);
  const moduleOp = page.locator('[data-operation-id="api-01::web-kmod-p7"].op .compatibility-state');
  assert.match(await moduleOp.innerText(), /Running kernel\s+14\.3-RELEASE-p7/);
  assert.match(await moduleOp.innerText(), /ABI\s+FreeBSD:14:amd64/);
  assert.match(await moduleOp.innerText(), /Kernel KBI\s+14\.3-p7-kbi/);
  assert.match(await page.locator("#fleetRows").innerText(), /14\.3-RELEASE-p6/);

  await changeTime("#windowStart", "");
  assert.equal(await page.locator("#windowStart").inputValue(), "");
  assert.equal(await page.locator("#windowStart").getAttribute("aria-invalid"), "true");
  assert.match(await page.locator("#windowValidation").innerText(), /start before end/);
  assert.ok((await exported()).plan.blockers.some((blocker) => blocker.code === "INVALID_WINDOW"));
  assert.doesNotMatch(await page.locator("#plan").innerText(), /NaN/);
  await changeTime("#windowStart", "07:00");
  assert.equal(await page.locator("#windowEnd").getAttribute("aria-invalid"), "true");
  await changeTime("#windowStart", "02:00");
  assert.equal(await page.locator("#windowStart").getAttribute("aria-invalid"), "false");

  const model = createDemoData();
  model.conflicts = [];
  model.selection = { hostIds: ["edge-01", "api-01", "worker-01"], patchIds: ["base-p7", "crypto-modern"], conflictChoices: {} };
  model.policy.changeWindow.end = "06:00";
  await importJSON(model);
  const roundtrip = await exported();
  await assertRollback("#rollbackPaths", roundtrip.plan.rollbackPaths);
  await page.locator("#failureHost").selectOption("api-01");
  await page.locator("#failureOutcome").selectOption("failed-after-apply");
  await page.locator("#simulateBtn").click();
  const failedOp = roundtrip.plan.orderedOperations.find((op) => op.hostId === "api-01");
  const expectedSteps = roundtrip.plan.rollbackPaths.filter((path) => path.operationId === failedOp.id);
  await assertRollback("#simulationResult", expectedSteps);
  assert.match(await page.locator("#simulationResult").innerText(), /Halted: yes/);
  await page.locator("#failureOutcome").selectOption("failed-before-apply");
  await page.locator("#simulateBtn").click();
  await assertRollback("#simulationResult", []);

  await page.locator("#resetBtn").click();
  await importJSON(roundtrip);
  assert.deepEqual(await exported(), roundtrip);
  await page.reload();
  await page.locator(".op").first().waitFor();
  assert.deepEqual(await exported(), roundtrip);
  for (const invalid of ["{", { ...model, groups: [null] }, { ...model, groups: [{ ...model.groups[0], soakMinutes: "bad" }] }]) {
    await importJSON(invalid, false);
    assert.deepEqual(await exported(), roundtrip);
  }

  // A blocked overflow gate must never advertise an effective release.
  model.selection.patchIds = ["base-p7"];
  model.policy.changeWindow.end = "02:49";
  await importJSON(model);
  assert.equal((await exported()).plan.canaryGroups[0].releaseMinute, null);
  assert.equal(await page.locator(".gate-release").innerText(), "Release blocked");
  assert.equal(await page.locator(".gate-proposed").innerText(), "Proposed soak release 02:50 · exceeds window");
  await assertBlockers();
  model.policy.changeWindow.end = "02:34";
  await importJSON(model);
  assert.equal(await page.locator(".gate-release").innerText(), "Release blocked");
  assert.equal(await page.locator(".gate-proposed").count(), 0);

  await page.reload();
  await page.locator(".gate-release").waitFor();
  assert.equal(await page.locator(".gate-release").innerText(), "Release blocked");
  assert.match(await page.locator(".gate-reasons").innerText(), /GROUP_BLOCKED/);
  assert.match(await page.locator(".boundary-slot").first().innerText(), /02:00–02:35 · not scheduled/);
  assert.match(await page.locator(".blocker-item .compatibility-state").first().innerText(), /ABI\s+FreeBSD:14:amd64/);
  model.policy.changeWindow.end = "02:49";
  await importJSON(model);
  assert.equal((await exported()).plan.canaryGroups[0].releaseMinute, null);
  assert.equal(await page.locator(".gate-release").innerText(), "Release blocked");
  assert.match(await page.locator(".gate-proposed").innerText(), /02:50/);

  // ABI conflict at the exact clock boundary, including blocked dependent.
  const boundary = createDemoData();
  boundary.conflicts = [];
  boundary.groups[0].soakMinutes = 0;
  boundary.selection = { hostIds: ["edge-01"], patchIds: ["window-fill", "abi-at-close", "after-abi"], conflictChoices: {} };
  const common = { ...boundary.patches[0], rebootRequired: false, durationMinutes: 1, target: {}, requiresPatchIds: [] };
  boundary.patches = [
    { ...common, id: "window-fill", name: "Fill window", durationMinutes: 120 },
    { ...common, id: "abi-at-close", name: "Boundary ABI conflict", requiresPatchIds: ["window-fill"], appliesTo: { ...common.appliesTo, abi: "FreeBSD:99:amd64" } },
    { ...common, id: "after-abi", name: "Blocked dependent", requiresPatchIds: ["abi-at-close"] }
  ];
  await importJSON(boundary);
  const boundaryExport = await exported();
  assert.deepEqual(boundaryExport.plan.orderedOperations.map((op) => op.patchId), ["window-fill"]);
  await assertBlockers(boundaryExport);
  assert.match(await page.locator("#blockerList").innerText(), /ABI_MISMATCH/);
  assert.match(await page.locator("#blockerList").innerText(), /DEPENDENCY_BLOCKED/);
  assert.match(await page.locator(".boundary-slot").innerText(), /04:00–04:01 · not scheduled/);
  assert.equal(await page.locator(".gate-release").innerText(), "Release blocked");
  await assertRollback("#rollbackPaths", boundaryExport.plan.rollbackPaths);
  await importJSON(boundaryExport);
  assert.deepEqual(await exported(), boundaryExport);

  model.hosts[0].name = `<img src=x onerror="window.injected=true">${"long-host-".repeat(30)}`;
  model.hosts[0].role = "<script>window.injected=true</script>";
  model.hosts[0].risk = '<img src=x onerror="window.injected=true">';
  model.patches[0].name = "Patch <unsafe> & detail";
  model.patches[0].rollback.methods = ["snapshot <one>", "recovery & two"];
  model.policy.changeWindow.end = "06:00";
  await importJSON(model);
  assert.equal(await page.locator("#fleetRows img, #plan img, #rollbackPaths img, #fleetRows script").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.ok((await page.locator(".op-main strong").first().innerText()).includes(model.hosts[0].name));
  await assertRollback("#rollbackPaths", (await exported()).plan.rollbackPaths);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > innerWidth + 1 && !element.closest(".table-wrap")).map((element) => element.className || element.tagName));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}px: ${overflow.join(", ")}`);
  }
  model.policy.changeWindow.end = "02:34";
  await importJSON(model);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertBlockers();
  assert.equal(await page.locator("#blockerList").evaluate((element) => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1), true, "all blocker content fits without clipping");
  assert.deepEqual(errors, []);
  t.diagnostic("Passed against real planner: all blockers/stable container, conflict repeats, window slots/invalid fields, boundary ABI conflict, canary membership/blocked and proposed release, projected ABI/kernel, operation rollback, export/import/persistence, invalid import, escaping, responsive layout, no page errors.");
});
