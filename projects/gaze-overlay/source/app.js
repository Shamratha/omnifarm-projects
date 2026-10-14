import {
  normalizeRecording, processRecording, sampleAt, analyzeFixations, fixationAt, heatmapAt, computeAOIDwell,
} from "./gaze-processing.mjs";
import {
  buildAnalysisSummary, buildExportPayload, remapNormalizedPoint, NORMALIZED_MAPPING_POLICY,
} from "./gaze-export.mjs";

const state = {
  recording: null,
  processed: null,
  currentTime: 0,
  speed: 1,
  playing: false,
  frameId: null,
  lastFrame: 0,
  sourceName: "Demo recording",
  settings: { minConfidence: 0.7, alpha: 0.35, maxGapMs: 1000 },
  smoothingEnabled: false,
  mode: "raw",
  view: "path",
  fixationSettings: { radius: 0.06, minDurationMs: 100 },
  fixations: [],
  aois: [
    { id: "hero-copy", label: "Hero copy", x: 0.05, y: 0.09, width: 0.43, height: 0.28 },
    { id: "hero-art", label: "Hero illustration", x: 0.58, y: 0.08, width: 0.39, height: 0.39 },
  ],
  nextAoiId: 1,
  editingAoiId: null,
  overlaysVisible: true,
  viewport: { width: 0, height: 0 },
};

const $ = (id) => document.getElementById(id);
const els = {
  importButton: $("importButton"),
  exportButton: $("exportButton"),
  summaryButton: $("summaryButton"),
  fileInput: $("fileInput"),
  loadDemoButton: $("loadDemoButton"),
  resetButton: $("resetButton"),
  playButton: $("playButton"),
  timeline: $("timeline"),
  speedSelect: $("speedSelect"),
  confidenceThreshold: $("confidenceThreshold"),
  confidenceThresholdValue: $("confidenceThresholdValue"),
  smoothingToggle: $("smoothingToggle"),
  alphaSlider: $("alphaSlider"),
  alphaValue: $("alphaValue"),
  maxGap: $("maxGap"),
  rawModeButton: $("rawModeButton"),
  smoothedModeButton: $("smoothedModeButton"),
  rawPathLayer: $("rawPathLayer"),
  smoothPathLayer: $("smoothPathLayer"),
  gazeCursor: $("gazeCursor"),
  gazeLayer: $("gazeLayer"),
  outsideTag: $("outsideTag"),
  focusStatus: $("focusStatus"),
  focusLabel: $("focusLabel"),
  focusSubtext: $("focusSubtext"),
  processingStatus: $("processingStatus"),
  processingStatusDetail: $("processingStatusDetail"),
  confidenceValue: $("confidenceValue"),
  confidenceBar: $("confidenceBar"),
  xValue: $("xValue"),
  yValue: $("yValue"),
  currentTime: $("currentTime"),
  inspectorTime: $("inspectorTime"),
  totalTime: $("totalTime"),
  durationValue: $("durationValue"),
  sampleCount: $("sampleCount"),
  sessionLabel: $("sessionLabel"),
  recordingTitle: $("recordingTitle"),
  xReadoutLabel: $("xReadoutLabel"),
  yReadoutLabel: $("yReadoutLabel"),
  modeValue: $("modeValue"),
  acceptedValue: $("acceptedValue"),
  segmentsValue: $("segmentsValue"),
  invalidCoordinatesValue: $("invalidCoordinatesValue"),
  invalidConfidenceValue: $("invalidConfidenceValue"),
  lowConfidenceValue: $("lowConfidenceValue"),
  invalidTimeValue: $("invalidTimeValue"),
  toast: $("toast"),
  fixationRadius: $("fixationRadius"),
  fixationMinDuration: $("fixationMinDuration"),
  pathViewButton: $("pathViewButton"),
  heatmapViewButton: $("heatmapViewButton"),
  fixationViewButton: $("fixationViewButton"),
  aoiLayer: $("aoiLayer"),
  heatmapLayer: $("heatmapLayer"),
  fixationLayer: $("fixationLayer"),
  overlayEmptyState: $("overlayEmptyState"),
  analyticsStatus: $("analyticsStatus"),
  heatmapLegend: $("heatmapLegend"),
  overlayLegend: $("overlayLegend"),
  fixationCount: $("fixationCount"),
  aoiForm: $("aoiForm"),
  aoiSubmit: $("aoiSubmit"),
  aoiCancel: $("aoiCancel"),
  aoiRows: $("aoiRows"),
  aoiEmpty: $("aoiEmpty"),
  gazePath: $("gazePath"),
  overlayToggle: $("overlayToggle"),
  samplePage: $("samplePage"),
  viewportSizeValue: $("viewportSizeValue"),
  mappingPolicyValue: $("mappingPolicyValue"),
  mappingStatusValue: $("mappingStatusValue"),
  panelConfidenceValue: $("panelConfidenceValue"),
  panelGapValue: $("panelGapValue"),
  panelRadiusValue: $("panelRadiusValue"),
  panelDurationValue: $("panelDurationValue"),
  panelModeValue: $("panelModeValue"),
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(milliseconds, includeHours = false) {
  const totalSeconds = Math.max(0, milliseconds) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const tenths = Math.floor((totalSeconds % 1) * 10);
  const hours = Math.floor(minutes / 60);
  const minutePart = String(minutes % 60).padStart(2, "0");
  const secondPart = String(seconds).padStart(2, "0");
  return `${includeHours && hours ? `${String(hours).padStart(2, "0")}:` : ""}${minutePart}:${secondPart}.${tenths}`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => els.toast.classList.remove("visible"), 3600);
}

function effectiveMode() {
  return state.mode === "smoothed" && state.smoothingEnabled ? "smoothed" : "raw";
}

function settingsFromControls() {
  if (!validNumberControl(els.maxGap, 0)) return;
  state.settings = {
    minConfidence: Number(els.confidenceThreshold.value),
    alpha: Number(els.alphaSlider.value),
    maxGapMs: Number(els.maxGap.value),
  };
}

function validNumberControl(input, min, max = Infinity) {
  input.setCustomValidity("");
  const number = Number(input.value);
  const valid = input.value.trim() !== "" && Number.isFinite(number) && number >= min && number <= max;
  if (!valid) input.setCustomValidity(`Enter a finite value ${max === Infinity ? `of at least ${min}` : `from ${min} to ${max}`}.`);
  input.setAttribute("aria-invalid", String(!valid));
  return valid;
}

function analysisSettingsFromControls() {
  const radiusValid = validNumberControl(els.fixationRadius, 0, 1);
  const durationValid = validNumberControl(els.fixationMinDuration, 0);
  if (!radiusValid || !durationValid) return false;
  const radius = Number(els.fixationRadius.value);
  const minDurationMs = Number(els.fixationMinDuration.value);
  state.fixationSettings = { radius, minDurationMs };
  return true;
}

function updateProcessingControls() {
  const smoothingEnabled = els.smoothingToggle.checked;
  state.smoothingEnabled = smoothingEnabled;
  if (!smoothingEnabled) state.mode = "raw";
  els.alphaSlider.disabled = !smoothingEnabled;
  els.confidenceThresholdValue.value = Number(els.confidenceThreshold.value).toFixed(2);
  els.confidenceThresholdValue.textContent = Number(els.confidenceThreshold.value).toFixed(2);
  els.alphaValue.value = Number(els.alphaSlider.value).toFixed(2);
  els.alphaValue.textContent = Number(els.alphaSlider.value).toFixed(2);
  for (const button of [els.rawModeButton, els.smoothedModeButton]) {
    const active = button.dataset.mode === effectiveMode();
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  els.smoothedModeButton.disabled = !smoothingEnabled;
}

function updateViewportMetrics() {
  if (!els.samplePage) return;
  const rect = els.samplePage.getBoundingClientRect();
  state.viewport = { width: rect.width, height: rect.height };
  els.viewportSizeValue.textContent = `${state.viewport.width} × ${state.viewport.height} px`;
  els.mappingPolicyValue.textContent = NORMALIZED_MAPPING_POLICY;
  els.mappingStatusValue.textContent = state.viewport.width && state.viewport.height
    ? "Active · raw normalized values unchanged"
    : "Waiting for visible sample page";
  els.panelConfidenceValue.textContent = `${state.settings.minConfidence} normalized 0–1`;
  els.panelGapValue.textContent = `${state.settings.maxGapMs} ms · no bridge`;
  els.panelRadiusValue.textContent = `${state.fixationSettings.radius} normalized`;
  els.panelDurationValue.textContent = `${state.fixationSettings.minDurationMs} ms`;
  els.panelModeValue.textContent = `${effectiveMode()} · smoothing ${state.smoothingEnabled ? "on" : "off"} · EMA α ${state.settings.alpha} (unitless 0–1)`;
}

function rebuildProcessedRecording() {
  if (!state.recording) return;
  settingsFromControls();
  state.processed = processRecording(state.recording, state.settings);
  if (!analysisSettingsFromControls()) {
    state.fixationSettings = { ...state.fixationSettings };
  }
  state.fixations = analyzeFixations(state.processed, { ...state.fixationSettings, maxGapMs: state.settings.maxGapMs });
  updateProcessingControls();
  render();
}

function svgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function plotCoordinate(value) {
  return clamp(value, -0.5, 1.5);
}

function renderPath() {
  if (!state.processed) return;
  const layers = [els.rawPathLayer, els.smoothPathLayer];
  for (const layer of layers) layer.replaceChildren();
  const active = effectiveMode();
  layers[0].classList.toggle("is-hidden", active !== "raw");
  layers[1].classList.toggle("is-hidden", active !== "smoothed");
  for (const [layer, smoothed] of [[els.rawPathLayer, false], [els.smoothPathLayer, true]]) {
    for (const segment of state.processed.segments) {
      const visible = segment.filter((point) => point.t <= state.currentTime);
      const coordinates = visible.map((point) => `${plotCoordinate(smoothed ? point.smoothX : point.x)},${plotCoordinate(smoothed ? point.smoothY : point.y)}`);
      if (visible.length && state.currentTime > visible[visible.length - 1].t && state.currentTime < segment[segment.length - 1].t) {
        const cursor = sampleAt(state.processed, state.currentTime, { smoothed });
        if (cursor) coordinates.push(`${plotCoordinate(cursor.x)},${plotCoordinate(cursor.y)}`);
      }
      if (coordinates.length > 1) {
        layer.append(svgElement("path", { class: "gaze-segment", d: `M ${coordinates.join(" L ")}` }));
      }
      for (const point of visible) {
        layer.append(svgElement("circle", {
          class: "gaze-point",
          cx: plotCoordinate(smoothed ? point.smoothX : point.x),
          cy: plotCoordinate(smoothed ? point.smoothY : point.y),
          r: coordinates.length === 1 ? "0.012" : "0.006",
        }));
      }
    }
  }
}

function renderAnalytics() {
  const mode = state.view;
  els.gazeLayer.hidden = !state.overlaysVisible;
  els.pathViewButton.classList.toggle("is-active", mode === "path");
  els.heatmapViewButton.classList.toggle("is-active", mode === "heatmap");
  els.fixationViewButton.classList.toggle("is-active", mode === "fixations");
  for (const button of [els.pathViewButton, els.heatmapViewButton, els.fixationViewButton]) {
    button.setAttribute("aria-pressed", String(button.dataset.view === mode));
  }
  els.gazePath.classList.toggle("is-hidden", !state.overlaysVisible || mode !== "path");
  els.heatmapLayer.classList.toggle("is-hidden", !state.overlaysVisible || mode !== "heatmap");
  els.fixationLayer.classList.toggle("is-hidden", !state.overlaysVisible || mode !== "fixations");
  els.aoiLayer.classList.toggle("is-hidden", !state.overlaysVisible);
  els.heatmapLegend.classList.toggle("is-hidden", !state.overlaysVisible || mode !== "heatmap");
  els.analyticsStatus.classList.toggle("is-hidden", !state.overlaysVisible);
  els.overlayLegend.classList.toggle("is-hidden", !state.overlaysVisible);
  els.aoiLayer.replaceChildren();
  for (const aoi of state.aois) {
    els.aoiLayer.append(Object.assign(document.createElement("div"), {
      className: "aoi-rectangle",
      title: `${aoi.label}: ${aoi.x}, ${aoi.y}, ${aoi.width}, ${aoi.height}`,
    }));
    const box = els.aoiLayer.lastElementChild;
    box.style.left = `${aoi.x * 100}%`; box.style.top = `${aoi.y * 100}%`;
    box.style.width = `${aoi.width * 100}%`; box.style.height = `${aoi.height * 100}%`;
    box.append(Object.assign(document.createElement("span"), { textContent: aoi.label }));
  }
  els.heatmapLayer.replaceChildren();
  const completed = state.processed ? heatmapAt(state.fixations, state.currentTime) : [];
  for (const fixation of completed) {
    const point = document.createElement("div");
    point.className = "heatmap-point";
    point.style.left = `${plotCoordinate(fixation.x) * 100}%`;
    point.style.top = `${plotCoordinate(fixation.y) * 100}%`;
    // Fixed 0–1000 ms color scale; no per-frame normalization.
    point.style.setProperty("--heat-color", `hsl(${220 * (1 - clamp(fixation.intensity / 1000, 0, 1))} 90% 50%)`);
    point.setAttribute("aria-label", `Completed fixation, ${Math.round(fixation.durationMs)} ms`);
    els.heatmapLayer.append(point);
  }
  els.fixationLayer.replaceChildren();
  const active = state.processed ? fixationAt(state.fixations, state.currentTime) : null;
  for (const [index, fixation] of state.fixations.entries()) {
    if (fixation.start > state.currentTime) continue;
    const marker = document.createElement("div");
    marker.className = `fixation-marker${active && active.start === fixation.start ? " is-current" : ""}`;
    marker.style.left = `${plotCoordinate(fixation.x) * 100}%`;
    marker.style.top = `${plotCoordinate(fixation.y) * 100}%`;
    marker.innerHTML = `<b>${index + 1}</b><span>${Math.round(fixation.durationMs)} ms${active && active.start === fixation.start ? " · active full interval" : ""}</span>`;
    els.fixationLayer.append(marker);
  }
  const emptyMessage = mode === "heatmap" && completed.length === 0
    ? "No completed fixations at this time."
    : mode === "fixations" && !els.fixationLayer.childElementCount ? "No fixations at or before this time." : "";
  els.overlayEmptyState.textContent = emptyMessage;
  els.overlayEmptyState.classList.toggle("visible", state.overlaysVisible && Boolean(emptyMessage) && mode !== "path");
  els.analyticsStatus.textContent = `${completed.length} completed fixations · raw accepted coordinates · ${Math.round(state.currentTime)} ms elapsed. Active markers show offline full-run centroid and duration.`;
  els.fixationCount.textContent = completed.length;
  els.overlayToggle.textContent = state.overlaysVisible ? "Hide overlays" : "Show overlays";
  els.overlayToggle.setAttribute("aria-pressed", String(!state.overlaysVisible));
}

function renderAOITable() {
  els.aoiEmpty.classList.toggle("is-hidden", state.aois.length > 0);
  const dwell = state.processed ? computeAOIDwell(state.processed, state.aois, state.currentTime, { maxGapMs: state.settings.maxGapMs, gapPolicy: "no-bridge" }) : [];
  // Keep action buttons stable during playback so keyboard focus is preserved.
  const signature = JSON.stringify(state.aois);
  if (renderAOITable.signature !== signature) {
    renderAOITable.signature = signature;
    els.aoiRows.replaceChildren();
    for (const aoi of state.aois) {
      const row = document.createElement("tr");
      row.innerHTML = `<th scope="row">${escapeHTML(aoi.label)}</th><td>${aoi.x.toFixed(2)}, ${aoi.y.toFixed(2)} · ${aoi.width.toFixed(2)} × ${aoi.height.toFixed(2)}</td><td class="aoi-dwell"></td><td><button class="aoi-action" type="button" data-action="edit" data-aoi-id="${aoi.id}" aria-label="Edit ${escapeHTML(aoi.label)}">Edit</button> <button class="aoi-action" type="button" data-action="remove" data-aoi-id="${aoi.id}" aria-label="Remove ${escapeHTML(aoi.label)}">Remove</button></td>`;
      els.aoiRows.append(row);
    }
  }
  for (const [index, cell] of [...els.aoiRows.querySelectorAll(".aoi-dwell")].entries()) {
    cell.textContent = `${(dwell[index]?.dwellMs || 0).toFixed(1)} ms`;
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function renderProcessingStats() {
  const { stats } = state.processed;
  els.acceptedValue.textContent = stats.accepted;
  els.segmentsValue.textContent = state.processed.segments.length;
  els.invalidCoordinatesValue.textContent = stats.invalidCoordinates;
  els.invalidConfidenceValue.textContent = stats.invalidConfidence;
  els.lowConfidenceValue.textContent = stats.lowConfidence;
  els.invalidTimeValue.textContent = state.recording.stats.invalidTime;
}

function render() {
  if (!state.recording || !state.processed) return;
  const mode = effectiveMode();
  const sample = sampleAt(state.processed, state.currentTime, { smoothed: mode === "smoothed" });
  const time = formatTime(state.currentTime);
  els.xReadoutLabel.textContent = `${mode === "smoothed" ? "Smoothed" : "Raw"} X`;
  els.yReadoutLabel.textContent = `${mode === "smoothed" ? "Smoothed" : "Raw"} Y`;
  els.modeValue.textContent = mode === "smoothed" ? "Smoothed" : "Raw";
  els.currentTime.textContent = time;
  els.inspectorTime.textContent = time;
  els.timeline.value = String(state.currentTime);
  els.timeline.setAttribute("aria-valuetext", `${time} of ${formatTime(state.recording.duration)}`);
  renderProcessingStats();
  renderPath();
  renderAnalytics();
  renderAOITable();
  updateViewportMetrics();
  if (!sample) {
    els.gazeCursor.classList.add("hidden");
    els.outsideTag.classList.remove("visible");
    els.focusStatus.classList.remove("outside");
    const empty = state.processed.stats.accepted === 0;
    els.focusLabel.textContent = empty ? "No usable gaze" : "Gap / no gaze";
    els.focusSubtext.textContent = empty
      ? "All coordinate or confidence checks filtered this recording"
      : "No cursor at this time; filtered rows and gaps break segments";
    els.processingStatus.textContent = empty ? "No usable data" : "Gap in processed data";
    els.processingStatusDetail.textContent = empty
      ? "Lower the confidence threshold or inspect the imported values."
      : `No sample at ${time}; gaps longer than ${state.settings.maxGapMs} ms are not bridged.`;
    els.confidenceValue.textContent = "—";
    els.confidenceBar.style.width = "0";
    els.xValue.textContent = "—";
    els.yValue.textContent = "—";
    return;
  }
  els.gazeCursor.classList.remove("hidden");
  const mapped = remapNormalizedPoint(sample, state.viewport);
  els.gazeCursor.style.left = `${(mapped.displayX ?? 0.5) * 100}%`;
  els.gazeCursor.style.top = `${(mapped.displayY ?? 0.5) * 100}%`;
  els.gazeCursor.classList.toggle("is-hidden", !state.overlaysVisible);
  els.gazeCursor.classList.toggle("outside", sample.outside);
  els.gazeCursor.classList.toggle("low-confidence", sample.confidence < 0.7);
  els.outsideTag.classList.toggle("visible", state.overlaysVisible && sample.outside);
  els.focusStatus.classList.toggle("outside", sample.outside);
  els.focusLabel.textContent = sample.outside ? "Outside viewport" : "In viewport";
  els.focusSubtext.textContent = sample.outside ? "Gaze coordinates beyond page bounds" : "Tracking page coordinates";
  els.processingStatus.textContent = `Tracking · ${mode === "smoothed" ? "Smoothed" : "Raw"}`;
  els.processingStatusDetail.textContent = `${state.processed.stats.accepted} accepted samples across ${state.processed.segments.length} segment${state.processed.segments.length === 1 ? "" : "s"}.`;
  els.confidenceValue.textContent = `${Math.round(sample.confidence * 100)}%`;
  els.confidenceBar.style.width = `${sample.confidence * 100}%`;
  els.xValue.textContent = sample.x.toFixed(3);
  els.yValue.textContent = sample.y.toFixed(3);
}

function renderMetadata() {
  const { samples, duration, title, participant, stats } = state.recording;
  els.sampleCount.textContent = stats.total;
  els.durationValue.textContent = formatTime(duration);
  els.totalTime.textContent = formatTime(duration);
  els.timeline.max = String(duration);
  els.timeline.step = "any";
  els.recordingTitle.textContent = participant ? `${title} · ${participant}` : title;
  els.sessionLabel.textContent = state.sourceName;
  updateViewportMetrics();
}

function setRecording(payload, sourceName) {
  // Our export keeps source data in a separate member; a round-trip import
  // reopens that data, not the computed summary or saved display state.
  const source = payload?.analysis?.schema === "gaze-overlay.analysis"
    && Object.hasOwn(payload, "recording") ? payload.recording : payload;
  state.recording = normalizeRecording(source);
  state.sourceName = sourceName;
  state.currentTime = 0;
  state.playing = false;
  cancelPlaybackFrame();
  state.frameId = null;
  els.exportButton.disabled = false;
  els.summaryButton.disabled = false;
  renderMetadata();
  updatePlayButton();
  rebuildProcessedRecording();
}

function exportRecording(analysisOnly = false) {
  if (!state.recording || !state.processed) return;
  updateViewportMetrics();
  const options = {
    recording: state.recording,
    processed: state.processed,
    fixations: state.fixations,
    aois: state.aois,
    settings: state.settings,
    fixationSettings: state.fixationSettings,
    currentTimeMs: state.currentTime,
    sourceName: state.sourceName,
    smoothingEnabled: state.smoothingEnabled,
    viewport: state.viewport,
    generatedAt: new Date().toISOString(),
    displayMode: effectiveMode(),
  };
  const payload = analysisOnly ? buildAnalysisSummary(options) : buildExportPayload(options);
  const title = String(state.recording.title || "recording").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recording";
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title}-${analysisOnly ? "analysis" : "gaze-analysis"}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${anchor.download}`);
}

function cancelPlaybackFrame() {
  if (state.frameId !== null) cancelAnimationFrame(state.frameId);
  state.frameId = null;
}

function updatePlayButton() {
  els.playButton.innerHTML = state.playing ? "Ⅱ <span>Pause</span>" : "▶ <span>Play</span>";
  els.playButton.setAttribute("aria-label", state.playing ? "Pause recording" : "Play recording");
}

function animate(now) {
  state.frameId = null;
  if (!state.playing) return;
  if (!state.lastFrame) state.lastFrame = now;
  state.currentTime += (now - state.lastFrame) * state.speed;
  state.lastFrame = now;
  if (state.currentTime >= state.recording.duration) {
    state.currentTime = state.recording.duration;
    state.playing = false;
    state.lastFrame = 0;
    updatePlayButton();
    cancelPlaybackFrame();
  }
  render();
  if (state.playing) state.frameId = requestAnimationFrame(animate);
}

function togglePlayback() {
  if (!state.recording) return;
  if (!state.playing && state.currentTime >= state.recording.duration) state.currentTime = 0;
  state.playing = !state.playing;
  state.lastFrame = 0;
  updatePlayButton();
  if (state.playing) state.frameId = requestAnimationFrame(animate);
  else cancelPlaybackFrame();
}

async function loadDemo() {
  try {
    const response = await fetch("demo-recording.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Demo recording could not be loaded.");
    setRecording(await response.json(), "Demo recording");
  } catch (error) {
    showToast("Start a local server to load the bundled demo recording.");
    console.error(error);
  }
}

function importFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      setRecording(JSON.parse(reader.result), file.name);
      showToast(`Loaded ${file.name} · ${state.recording.samples.length} samples`);
    } catch (error) {
      showToast(error.message || "That JSON file could not be read.");
    }
  };
  reader.onerror = () => showToast("The recording file could not be opened.");
  reader.readAsText(file);
}

els.importButton.addEventListener("click", () => els.fileInput.click());
els.exportButton.addEventListener("click", () => exportRecording());
els.summaryButton.addEventListener("click", () => exportRecording(true));
els.fileInput.addEventListener("change", (event) => {
  importFile(event.target.files[0]);
  event.target.value = "";
});
els.loadDemoButton.addEventListener("click", loadDemo);
els.resetButton.addEventListener("click", () => {
  state.currentTime = 0;
  state.playing = false;
  state.lastFrame = 0;
  cancelPlaybackFrame();
  updatePlayButton();
  render();
});
els.playButton.addEventListener("click", togglePlayback);
els.timeline.addEventListener("input", (event) => {
  state.currentTime = Number(event.target.value);
  state.playing = false;
  state.lastFrame = 0;
  cancelPlaybackFrame();
  updatePlayButton();
  render();
});
els.speedSelect.addEventListener("change", (event) => { state.speed = Number(event.target.value); });
els.confidenceThreshold.addEventListener("input", rebuildProcessedRecording);
els.alphaSlider.addEventListener("input", rebuildProcessedRecording);
els.maxGap.addEventListener("input", () => {
  if (validNumberControl(els.maxGap, 0)) rebuildProcessedRecording();
});
for (const input of [els.fixationRadius, els.fixationMinDuration]) {
  input.addEventListener("input", () => {
    if (analysisSettingsFromControls()) rebuildProcessedRecording();
    else showToast("Fixation radius must be 0–1 normalized; minimum duration must be nonnegative ms. Using last valid settings.");
  });
}
for (const button of [els.pathViewButton, els.heatmapViewButton, els.fixationViewButton]) {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    state.overlaysVisible = true;
    render();
  });
}
els.overlayToggle.addEventListener("click", () => {
  state.overlaysVisible = !state.overlaysVisible;
  render();
});
els.aoiForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(els.aoiForm).entries());
  const x = Number(values.x); const y = Number(values.y);
  const width = Number(values.width); const height = Number(values.height);
  if (!values.label.trim() || [x, y, width, height].some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    || x + width > 1 || y + height > 1) {
    showToast("AOI coordinates must be within the normalized page (0–1).");
    return;
  }
  const rectangle = { label: values.label.trim(), x, y, width, height };
  if (state.editingAoiId) {
    Object.assign(state.aois.find((aoi) => aoi.id === state.editingAoiId), rectangle);
  } else {
    state.aois.push({ id: `aoi-${state.nextAoiId++}`, ...rectangle });
  }
  resetAOIForm();
  render();
  $("aoiLabel").focus();
});
function resetAOIForm() {
  state.editingAoiId = null;
  els.aoiForm.reset();
  els.aoiSubmit.textContent = "Add AOI";
  els.aoiCancel.hidden = true;
}
els.aoiCancel.addEventListener("click", resetAOIForm);
els.aoiRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-aoi-id]");
  if (!button) return;
  if (button.dataset.action === "edit") {
    const aoi = state.aois.find((aoi) => aoi.id === button.dataset.aoiId);
    state.editingAoiId = aoi.id;
    for (const key of ["label", "x", "y", "width", "height"]) els.aoiForm.elements.namedItem(key).value = aoi[key];
    els.aoiSubmit.textContent = "Save AOI";
    els.aoiCancel.hidden = false;
    $("aoiLabel").focus();
    return;
  }
  state.aois = state.aois.filter((aoi) => aoi.id !== button.dataset.aoiId);
  if (state.editingAoiId === button.dataset.aoiId) resetAOIForm();
  render();
  $("aoiLabel").focus();
});
els.smoothingToggle.addEventListener("change", rebuildProcessedRecording);
for (const button of [els.rawModeButton, els.smoothedModeButton]) {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    state.overlaysVisible = true;
    updateProcessingControls();
    render();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
    || event.target.isContentEditable
    || event.target.closest?.("input, select, textarea, button, a, summary, [role='button'], [contenteditable]")) return;
  if (event.code === "Space") { event.preventDefault(); if (!event.repeat) togglePlayback(); return; }
  if (!state.recording) return;
  const seek = (time) => {
    state.currentTime = clamp(time, 0, state.recording.duration);
    state.playing = false;
    state.lastFrame = 0;
    cancelPlaybackFrame();
    updatePlayButton();
    render();
  };
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const amount = event.shiftKey ? 100 : 500;
    seek(state.currentTime + (event.key === "ArrowLeft" ? -amount : amount));
    return;
  }
  if (event.key === "Home") { event.preventDefault(); seek(0); return; }
  if (event.key === "End") { event.preventDefault(); seek(state.recording.duration); return; }
  if (event.key === "1" || event.key === "2" || event.key === "3") {
    event.preventDefault();
    state.view = { 1: "path", 2: "heatmap", 3: "fixations" }[event.key];
    state.overlaysVisible = true;
    if (event.key === "1") {
      state.mode = "raw";
      updateProcessingControls();
    }
    render();
    return;
  }
  if (event.key === "0") { event.preventDefault(); state.overlaysVisible = false; render(); return; }
  if (event.key.toLowerCase() === "r") {
    event.preventDefault();
    state.currentTime = 0;
    state.playing = false;
    state.lastFrame = 0;
    cancelPlaybackFrame();
    updatePlayButton();
    render();
  }
});

const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
  updateViewportMetrics();
  render();
}) : null;
resizeObserver?.observe(els.samplePage);
window.addEventListener("resize", updateViewportMetrics);

loadDemo();
