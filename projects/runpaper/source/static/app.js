const state = {
  runs: [],
  selectedRuns: new Set(),
  selectedMetrics: new Set(),
  alignment: "independent",
  alignmentInfo: null,
  comparison: null,
  comparisonSupported: null,
  plotUrl: null,
  plotRequest: 0,
  comparisonRequest: 0,
  runInfo: null,
  exportRequest: 0,
  exportPayload: null,
  exportPreview: null,
  exportController: null,
  exportReturnFocus: null,
  exportSaving: false,
};
const $ = (selector) => document.querySelector(selector);

const ALIGNMENT_LABELS = {
  independent: "Independent",
  intersection: "Intersection",
  union: "Union",
};
const ALIGNMENT_HELP = {
  independent: "each run's recorded steps",
  intersection: "exact common steps only",
  union: "all steps; gaps stay missing",
};

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function showNotice(message, kind = "error") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  window.clearTimeout(showNotice.timer);
  if (kind !== "error") showNotice.timer = window.setTimeout(() => notice.classList.add("hidden"), 5500);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"}[character]));
}

function isMissing(value) {
  return value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value));
}

function formatValue(value) {
  return typeof value !== "number" || !Number.isFinite(value) ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

function valueOrMissing(value) {
  return isMissing(value) ? "—" : escapeHtml(value);
}

function metricDefinitions() {
  const metrics = new Map();
  state.runs.forEach(run => (run.metrics || []).forEach(metric => {
    const key = JSON.stringify([metric.key, metric.unit || "", metric.direction]);
    if (!metrics.has(key)) metrics.set(key, metric);
  }));
  return [...metrics.values()];
}

function metricDefinition(key, run) {
  const listed = (run.metrics || []).find(metric => metric.key === key);
  if (listed) return listed;
  const metadataMetric = run.metadata?.metrics?.[key];
  return metadataMetric ? { key, ...metadataMetric } : null;
}

function metadataValue(run, key) {
  const parameters = run.metadata?.parameters || run.parameters || {};
  if (Object.prototype.hasOwnProperty.call(parameters, key)) return parameters[key];
  return parameters[key] ?? run.metadata?.[key] ?? run[key];
}

function parameterText(run) {
  return ["seed", "dataset", "model"].map(key => `${key}: ${valueOrMissing(metadataValue(run, key))}`).join(" · ");
}

function runTemplate(run) {
  const checked = state.selectedRuns.has(run.id) ? "checked" : "";
  const metadata = run.metadata || {};
  const tags = [metadata.dataset || metadata.parameters?.dataset, metadata.model || metadata.parameters?.model]
    .filter(value => !isMissing(value)).map(value => `<span>${escapeHtml(value)}</span>`).join("");
  return `<label class="run-card"><input class="run-check" data-id="${escapeHtml(run.id)}" type="checkbox" ${checked}><span class="checkmark"></span><span class="run-card-body"><strong>${escapeHtml(run.name || run.id)}</strong><small>${escapeHtml(metadata.description || "Imported experiment run")}</small><span class="tags">${tags}</span></span></label>`;
}

function renderRuns(focusRunId = null) {
  $("#run-list").innerHTML = state.runs.map(runTemplate).join("");
  $("#run-pills").innerHTML = state.runs.map(run => `<button class="run-pill ${state.selectedRuns.has(run.id) ? "active" : ""}" data-run-pill="${escapeHtml(run.id)}"><span class="pill-dot"></span>${escapeHtml(run.name || run.id)}</button>`).join("");
  $("#run-count").textContent = `${state.selectedRuns.size} of ${state.runs.length} selected`;
  document.querySelectorAll(".run-check").forEach(input => input.addEventListener("change", () => toggleRun(input.dataset.id, input.checked)));
  document.querySelectorAll("[data-run-pill]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.runPill;
    toggleRun(id, !state.selectedRuns.has(id));
  }));
  if (focusRunId) document.querySelector(`.run-check[data-id="${CSS.escape(focusRunId)}"]`)?.focus();
}

function toggleRun(id, selected) {
  if (selected) state.selectedRuns.add(id); else state.selectedRuns.delete(id);
  renderRuns(id);
  refreshView();
}

function renderMetrics(focusMetricKey = null) {
  const definitions = metricDefinitions();
  $("#metric-count").textContent = `${state.selectedMetrics.size} of ${definitions.length} selected`;
  $("#metric-list").innerHTML = definitions.map(metric => {
    const checked = state.selectedMetrics.has(metric.key) ? "checked" : "";
    return `<label class="metric-option"><input class="metric-check" data-key="${escapeHtml(metric.key)}" type="checkbox" ${checked}><span class="checkmark"></span><span><strong>${escapeHtml(metric.label || metric.key)}</strong><small>${escapeHtml(metric.key)} · ${escapeHtml(metric.unit || "unitless")} · ${metric.direction === "max" ? "higher is better" : "lower is better"}</small></span></label>`;
  }).join("");
  document.querySelectorAll(".metric-check").forEach(input => input.addEventListener("change", () => {
    if (input.checked) state.selectedMetrics.add(input.dataset.key); else state.selectedMetrics.delete(input.dataset.key);
    renderMetrics(input.dataset.key);
    refreshView();
  }));
  if (focusMetricKey) document.querySelector(`.metric-check[data-key="${CSS.escape(focusMetricKey)}"]`)?.focus();
}

function summaryFor(run, metricKey) {
  return run.summaries?.[metricKey] || {};
}

function comparisonSummary(metricKey, run) {
  const source = state.comparison?.summaries || state.comparison?.comparison || state.comparison?.metrics || state.comparison;
  if (!source || typeof source !== "object") return null;
  if (Array.isArray(source)) {
    return source.find(item => item && (item.metric === metricKey || item.metric_key === metricKey || item.key === metricKey) && (item.run_id === run.id || item.id === run.id || item.run === run.id)) || null;
  }
  const metric = source[metricKey];
  if (!metric) return null;
  if (Array.isArray(metric)) return metric.find(item => item.run_id === run.id || item.id === run.id || item.run === run.id) || null;
  if (metric.runs && typeof metric.runs === "object") return metric.runs[run.id] || null;
  if (metric[run.id] && typeof metric[run.id] === "object") return metric[run.id];
  if (metric.run_id || metric.id) return metric.run_id === run.id || metric.id === run.id ? metric : null;
  return null;
}

function resolvedSummary(run, metricKey) {
  const comparison = comparisonSummary(metricKey, run);
  return { ...summaryFor(run, metricKey), ...(comparison?.summary || comparison || {}) };
}

function summaryFinal(summary) {
  return Object.prototype.hasOwnProperty.call(summary, "final") ? summary.final : summary.last;
}

function summaryBest(summary, metric) {
  if (Object.prototype.hasOwnProperty.call(summary, "best")) return summary.best;
  return metric.direction === "max" ? summary.max : summary.min;
}

function renderSummaries() {
  const runs = state.runs.filter(run => state.selectedRuns.has(run.id));
  const metrics = metricDefinitions().filter(metric => state.selectedMetrics.has(metric.key));
  if (!runs.length || !metrics.length) {
    $("#summary-wrap").innerHTML = `<div class="empty-small">Select at least one run and metric to see per-metric summaries.</div>`;
    return;
  }
  const sections = metrics.map(metric => {
    const rows = runs.map(run => {
      const definition = metricDefinition(metric.key, run);
      const compatible = definition && (definition.unit || "") === (metric.unit || "") && definition.direction === metric.direction;
      const summary = compatible ? resolvedSummary(run, metric.key) : {};
      const final = summaryFinal(summary);
      const best = summaryBest(summary, metric);
      const count = Object.prototype.hasOwnProperty.call(summary, "count") ? summary.count : summary.samples;
      return `<tr><td><strong>${escapeHtml(run.name || run.id)}</strong><small>${escapeHtml(run.id)}</small></td><td>${valueOrMissing(count)}</td><td>${formatValue(final)}</td><td>${formatValue(best)}</td><td class="parameters">${parameterText(run)}</td></tr>`;
    }).join("");
    const direction = metric.direction === "max" ? "↑ higher is better" : "↓ lower is better";
    return `<section class="metric-summary"><div class="table-scroll" tabindex="0"><table><caption class="metric-summary-heading"><strong>${escapeHtml(metric.label || metric.key)}</strong><span>${escapeHtml(metric.key)} · ${escapeHtml(metric.unit || "unitless")} · ${direction}</span></caption><thead><tr><th scope="col">Run</th><th scope="col">Samples</th><th scope="col">Final</th><th scope="col">Best</th><th scope="col">Parameters (seed/dataset/model)</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join("");
  $("#summary-wrap").innerHTML = sections;
}

function duplicateHandling() {
  const policies = [];
  const sources = [state.alignmentInfo, state.comparison, state.runInfo, state.runInfo?.alignment, state.runInfo?.alignment_info, state.runInfo?.alignment_metadata];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const value = source.duplicate_policy ?? source.duplicatePolicy ?? source.duplicate_handling ?? source.duplicates;
    if (typeof value === "string" && value.trim()) policies.push(value);
  }
  state.runs.filter(run => state.selectedRuns.has(run.id)).forEach(run => {
    const sources = [run, run.metadata, run.alignment, run.metadata?.alignment];
    const policy = sources.map(source => source?.duplicate_policy ?? source?.duplicate_handling).find(value => typeof value === "string" && value.trim());
    if (policy) policies.push(`${run.name || run.id}: ${policy}`);
  });
  return policies.length ? [...new Set(policies)].join("; ") : "not reported by the backend";
}

function renderAlignmentAssumption() {
  const label = ALIGNMENT_LABELS[state.alignment] || ALIGNMENT_LABELS.independent;
  $("#alignment-assumption").textContent = `${label} (${ALIGNMENT_HELP[state.alignment]}). No interpolation/extrapolation; missing cells remain gaps. Duplicate-step policy/handling: ${duplicateHandling()}.`;
}

function requestPayload() {
  return { run_ids: [...state.selectedRuns], metrics: [...state.selectedMetrics], title: $("#figure-title").value, alignment: state.alignment };
}

async function renderPlot() {
  const wrap = $("#plot-wrap");
  const empty = $("#plot-empty");
  const count = $("#panel-count");
  const requestId = ++state.plotRequest;
  const payload = requestPayload();
  renderAlignmentAssumption();
  wrap.classList.add("hidden"); empty.classList.remove("hidden"); count.textContent = "";
  empty.querySelector("strong").textContent = "Choose a run and metric to begin";
  empty.querySelector("span").textContent = "The chart is rendered from imported rows on the server.";
  if (!state.selectedRuns.size || !state.selectedMetrics.size) {
    wrap.classList.add("hidden"); empty.classList.remove("hidden"); count.textContent = ""; return;
  }
  empty.querySelector("strong").textContent = "Rendering figure…";
  try {
    const response = await api("/api/plot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const svg = await response.blob();
    if (requestId !== state.plotRequest) return;
    if (state.plotUrl) URL.revokeObjectURL(state.plotUrl);
    state.plotUrl = URL.createObjectURL(svg);
    $("#plot-image").src = state.plotUrl;
    $("#plot-heading").textContent = payload.title || "Experiment comparison";
    wrap.classList.remove("hidden"); empty.classList.add("hidden"); count.textContent = `${state.selectedRuns.size} run${state.selectedRuns.size === 1 ? "" : "s"} · ${state.selectedMetrics.size} metric${state.selectedMetrics.size === 1 ? "" : "s"} · ${ALIGNMENT_LABELS[state.alignment]}`;
  } catch (error) {
    if (requestId === state.plotRequest) {
      wrap.classList.add("hidden"); empty.classList.remove("hidden"); count.textContent = "";
      empty.querySelector("strong").textContent = "Could not render figure";
      empty.querySelector("span").textContent = error.message;
      showNotice(`Could not render figure: ${error.message}`);
    }
  }
}

async function loadComparison() {
  const requestId = ++state.comparisonRequest;
  renderSummaries();
  if (!state.selectedRuns.size || !state.selectedMetrics.size || state.comparisonSupported === false) return;
  try {
    const response = await api("/api/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload()) });
    const data = await response.json();
    if (requestId !== state.comparisonRequest) return;
    state.comparison = data;
    state.comparisonSupported = true;
    state.alignmentInfo = data.alignment || data.alignment_info || data.alignment_metadata || state.alignmentInfo;
    renderAlignmentAssumption();
    renderSummaries();
  } catch (error) {
    if (requestId !== state.comparisonRequest) return;
    if (error.status === 404 || error.status === 405) {
      state.comparisonSupported = false;
      return;
    }
    if (requestId === state.comparisonRequest) showNotice(`Could not load comparison summaries: ${error.message}`);
  }
}

function refreshView() {
  state.comparison = null;
  state.alignmentInfo = null;
  renderSummaries();
  renderPlot();
  loadComparison();
}

async function loadRuns() {
  try {
    const data = await (await api("/api/runs")).json();
    if (!Array.isArray(data.runs)) throw new Error("Invalid run list returned by server");
    state.runs = data.runs;
    state.runInfo = data;
    state.alignmentInfo = data.alignment || data.alignment_info || data.alignment_metadata || null;
    state.runs.forEach(run => state.selectedRuns.add(run.id));
    ["val_loss", "accuracy"].forEach(key => { if (state.runs.some(run => (run.metrics || []).some(metric => metric.key === key))) state.selectedMetrics.add(key); });
    if (!state.selectedMetrics.size) metricDefinitions().slice(0, 2).forEach(metric => state.selectedMetrics.add(metric.key));
    renderRuns(); renderMetrics(); renderAlignmentAssumption(); refreshView();
  } catch (error) { showNotice(`Could not load runs: ${error.message}`); }
}

$("#alignment").addEventListener("change", event => {
  state.alignment = event.target.value;
  state.comparisonSupported = null;
  refreshView();
});
$("#refresh-button").addEventListener("click", refreshView);
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const unit = bytes < 1024 * 1024 ? "KiB" : "MiB";
  return `${(bytes / (unit === "KiB" ? 1024 : 1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

function renderExportPreview(data) {
  const plot = data.manifest.plot;
  const alignment = data.comparison.alignment || plot.alignment;
  $("#export-summary").textContent = `${data.filename} · ${data.manifest.runs.length} selected run(s) · ${plot.metrics.length} selected metric(s) · ${formatBytes(data.byte_size)} (${data.byte_size.toLocaleString()} bytes)`;
  $("#export-alignment").textContent = `Alignment: ${ALIGNMENT_LABELS[alignment] || alignment} (${ALIGNMENT_HELP[alignment] || "recorded steps"})`;
  const groups = [
    ["comparison", "Plotted data · comparison.json"],
    ["figure", "Figure · figure.svg"],
    ["latex", "LaTeX · figure.tex"],
    ["manifest", "Manifest · manifest.json"],
    ["source", "Source files"],
    ["documentation", "Reproduction instructions"],
  ];
  $("#export-entries").innerHTML = groups.map(([kind, label]) => {
    const entries = data.entries.filter(entry => entry.kind === kind);
    if (!entries.length) return "";
    return `<section class="entry-group"><h3>${escapeHtml(label)}</h3><ul>${entries.map(entry => `<li><span>${escapeHtml(entry.name)}</span><small>${escapeHtml(formatBytes(entry.size))}</small></li>`).join("")}</ul></section>`;
  }).join("");
  $("#export-assumptions").replaceChildren();
  const assumptions = [...new Set([...(data.comparison.assumptions || []), ...(plot.assumptions || [])])];
  assumptions.forEach(assumption => {
    const item = document.createElement("li");
    item.textContent = assumption;
    $("#export-assumptions").append(item);
  });
  $("#export-svg").alt = `Exported figure: ${plot.title}`;
  $("#export-data-text").textContent = JSON.stringify(data.comparison, null, 2);
  $("#export-latex-text").textContent = data.latex;
  $("#export-manifest-text").textContent = JSON.stringify(data.manifest, null, 2);
}

function exportFailure(error, requestId) {
  if (requestId !== state.exportRequest || error.name === "AbortError") return;
  state.exportPreview = null;
  $("#export-loading").classList.add("hidden");
  $("#export-content").classList.add("hidden");
  $("#export-error").classList.remove("hidden");
  $("#export-error-message").textContent = error.message;
  $("#save-export").disabled = true;
}

async function previewExport(payload) {
  $("#close-export").focus();
  state.exportController?.abort();
  state.exportController = new AbortController();
  const requestId = ++state.exportRequest;
  state.exportPayload = payload;
  state.exportPreview = null;
  state.exportSaving = false;
  $("#save-export").disabled = true;
  $("#save-export").textContent = "↓ Save ZIP";
  $("#export-loading").classList.remove("hidden");
  $("#export-error").classList.add("hidden");
  $("#export-content").classList.add("hidden");
  $("#export-save-message").textContent = "";
  const image = $("#export-svg");
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  try {
    const response = await api("/api/export/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: state.exportController.signal,
    });
    const data = await response.json();
    if (requestId !== state.exportRequest) return;
    if (!data.preview_svg?.startsWith("data:image/svg+xml;base64,") || !Array.isArray(data.entries)) throw new Error("Invalid export preview returned by server.");
    renderExportPreview(data);
    image.onload = () => {
      if (requestId !== state.exportRequest) return;
      state.exportPreview = data;
      $("#export-loading").classList.add("hidden");
      $("#export-content").classList.remove("hidden");
      $("#save-export").disabled = false;
    };
    image.onerror = () => exportFailure(new Error("Could not display the exported SVG. Please retry."), requestId);
    image.src = data.preview_svg;
  } catch (error) { exportFailure(error, requestId); }
}

function closeExport() {
  ++state.exportRequest;
  state.exportController?.abort();
  state.exportPreview = null;
  state.exportPayload = null;
  state.exportSaving = false;
  $("#export-svg").onload = null;
  $("#export-svg").onerror = null;
  $("#export-svg").removeAttribute("src");
  $("#export-modal").classList.add("hidden");
  document.body.classList.remove("modal-open");
  state.exportReturnFocus?.focus();
}

$("#export-button").addEventListener("click", () => {
  if (!state.selectedRuns.size || !state.selectedMetrics.size) {
    showNotice("Select at least one run and metric to preview an export.");
    return;
  }
  state.exportReturnFocus = document.activeElement;
  $("#export-modal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("#close-export").focus();
  previewExport(requestPayload());
});
$("#retry-export").addEventListener("click", () => previewExport(state.exportPayload));
$("#close-export").addEventListener("click", closeExport);
$("[data-close-export]").addEventListener("click", closeExport);
document.addEventListener("keydown", event => {
  if ($("#export-modal").classList.contains("hidden")) return;
  if (event.key === "Escape") { event.preventDefault(); closeExport(); }
  if (event.key === "Tab") {
    const buttons = [...$("#export-modal").querySelectorAll("button:not(:disabled)")].filter(button => button.getClientRects().length);
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
});

$("#save-export").addEventListener("click", async () => {
  if (!state.exportPreview || state.exportSaving) return;
  const requestId = state.exportRequest;
  const preview = state.exportPreview;
  state.exportSaving = true;
  $("#save-export").disabled = true;
  $("#save-export").textContent = "Preparing ZIP…";
  $("#export-save-message").textContent = "";
  try {
    const response = await api("/api/export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.exportPayload), signal: state.exportController.signal,
    });
    const blob = await response.blob();
    if (requestId !== state.exportRequest) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = preview.filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("#export-save-message").textContent = "ZIP download started with the previewed selection and alignment.";
  } catch (error) {
    if (requestId === state.exportRequest && error.name !== "AbortError") $("#export-save-message").textContent = `Could not save ZIP: ${error.message}`;
  } finally {
    if (requestId === state.exportRequest) {
      state.exportSaving = false;
      $("#save-export").disabled = false;
      $("#save-export").textContent = "↓ Save ZIP";
    }
  }
});

window.addEventListener("pagehide", () => {
  state.exportController?.abort();
  if (state.plotUrl) { URL.revokeObjectURL(state.plotUrl); state.plotUrl = null; }
});

$("#import-form").addEventListener("submit", async event => {
  event.preventDefault(); const message = $("#import-message"); message.textContent = "Importing and validating…"; message.className = "form-message";
  try {
    const response = await api("/api/import", { method: "POST", body: new FormData(event.target) }); const data = await response.json();
    state.runs.push(data.run); state.selectedRuns.add(data.run.id); state.comparisonSupported = null; renderRuns(); renderMetrics(); refreshView(); event.target.reset(); message.textContent = `Added ${data.run.name || data.run.id}.`; message.className = "form-message success-text";
  } catch (error) { message.textContent = `Import failed: ${error.message}`; message.className = "form-message error-text"; }
});

loadRuns();
