import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(playwrightModule);
const root = fileURLToPath(new URL(".", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = join(root, relative);
  if (!file.startsWith(root)) {
    response.writeHead(403); response.end("Forbidden"); return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404); response.end("Not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const browser = await chromium.launch({ headless: true });

async function readDownload(page, selector) {
  const waiting = page.waitForEvent("download");
  await page.locator(selector).click();
  const download = await waiting;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { name: download.suggestedFilename(), json: JSON.parse(Buffer.concat(chunks).toString()) };
}

try {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#sampleCount")?.textContent !== "—");

  const recording = {
    title: "Browser import",
    participant: "Test participant",
    timeUnit: "ms",
    samples: [
      { t: 0, x: 0.2, y: 0.2, confidence: 1 },
      { t: 500, x: 0.22, y: 0.22, confidence: 1 },
      { t: 1000, x: 0.7, y: 0.6, confidence: 1 },
    ],
  };
  await page.locator("#fileInput").setInputFiles({
    name: "browser-import.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(recording)),
  });
  await page.waitForFunction(() => document.querySelector("#sessionLabel")?.textContent === "browser-import.json");
  assert.equal(await page.locator("#recordingTitle").textContent(), "Browser import · Test participant");
  assert.equal(await page.locator("#durationValue").textContent(), "00:01.0");

  await page.locator("#speedSelect").selectOption("2");
  await page.locator("#playButton").click();
  assert.equal(await page.locator("#playButton").getAttribute("aria-label"), "Pause recording");
  await page.waitForTimeout(80);
  await page.locator("#playButton").click();
  const paused = Number(await page.locator("#timeline").inputValue());
  assert.ok(paused > 0, "playback advanced");

  // Document shortcuts intentionally ignore focused controls; blur before seeking.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("ArrowRight");
  const afterRight = Number(await page.locator("#timeline").inputValue());
  assert.equal(afterRight, Math.min(1000, paused + 500));
  await page.keyboard.press("Shift+ArrowLeft");
  assert.equal(Number(await page.locator("#timeline").inputValue()), Math.max(0, afterRight - 100));
  await page.keyboard.press("End");
  assert.equal(await page.locator("#timeline").inputValue(), "1000");
  await page.keyboard.press("Home");
  assert.equal(await page.locator("#timeline").inputValue(), "0");

  const label = page.locator("#aoiLabel");
  await label.fill("Test AOI");
  await page.locator("#aoiX").fill("0.1");
  await page.locator("#aoiY").fill("0.1");
  await page.locator("#aoiWidth").fill("0.4");
  await page.locator("#aoiHeight").fill("0.4");
  await page.locator("#aoiSubmit").click();
  await page.waitForFunction(() => document.querySelector("#aoiRows")?.textContent.includes("Test AOI"));
  await page.locator("[data-action=edit]").last().click();
  await label.fill("Edited AOI");
  await page.locator("#aoiSubmit").click();
  await page.waitForFunction(() => document.querySelector("#aoiRows")?.textContent.includes("Edited AOI"));
  assert.match(await page.locator(".aoi-dwell").last().textContent(), / ms$/);

  const exported = await readDownload(page, "#exportButton");
  assert.deepEqual(exported.json.recording, recording);
  assert.equal(exported.json.analysis.schema, "gaze-overlay.analysis");
  assert.equal(exported.json.analysis.aois.at(-1).label, "Edited AOI");
  assert.ok(exported.name.endsWith("-gaze-analysis.json"));
  const summary = await readDownload(page, "#summaryButton");
  assert.equal(summary.json.schema, "gaze-overlay.analysis");
  assert.equal(summary.json.settings.maxGapMs, 1000);

  const wideViewport = await page.locator("#viewportSizeValue").textContent();
  await page.setViewportSize({ width: 620, height: 900 });
  await page.waitForFunction((previous) => document.querySelector("#viewportSizeValue")?.textContent !== previous, wideViewport);
  const boxes = await page.evaluate(() => ["samplePage", "gazeLayer"].map((id) => {
    const rect = document.getElementById(id).getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  }));
  assert.deepEqual(boxes[0], boxes[1]);
  assert.match(await page.locator("#viewportSizeValue").textContent(), /px$/);

  const regularAnimation = await page.evaluate(() => getComputedStyle(document.querySelector(".gaze-cursor"), "::after").animationName);
  assert.equal(regularAnimation, "breathe");
  await context.close();

  const reducedContext = await browser.newContext({ viewport: { width: 900, height: 700 }, reducedMotion: "reduce" });
  const reducedPage = await reducedContext.newPage();
  await reducedPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await reducedPage.waitForFunction(() => document.querySelector("#sampleCount")?.textContent !== "—");
  assert.equal(await reducedPage.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
  assert.equal(await reducedPage.evaluate(() => getComputedStyle(document.querySelector(".gaze-cursor"), "::after").animationName), "none");
  await reducedContext.close();

  assert.deepEqual(errors, []);
  console.log("PASS browser: import, playback, 2x speed, pause, seek, AOI add/edit, export, resize remapping, reduced-motion, no page errors");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
