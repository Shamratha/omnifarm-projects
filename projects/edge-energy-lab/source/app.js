(function () {
  "use strict";
  const Lab = window.EdgeLab;
  let dataset = Lab.createFixture("field-noise");
  const state = { modelId: Lab.MODELS[0].id, scenario: "field-noise", thresholds: {}, filter: "falsePositives", selectedId: null };
  const sweeps = new Map();
  Lab.MODELS.forEach(function (model) { state.thresholds[model.id] = model.defaultThreshold; });

  const $ = function (selector) { return document.querySelector(selector); };
  const $$ = function (selector) { return Array.from(document.querySelectorAll(selector)); };
  const currentModel = function () { return Lab.MODELS.find(function (model) { return model.id === state.modelId; }); };
  const currentEval = function () { return Lab.evaluate(dataset, currentModel(), state.thresholds[state.modelId]); };
  const pct = function (value) { return `${(value * 100).toFixed(1)}%`; };
  const fixed = function (value, digits) { return Number(value).toFixed(digits == null ? 2 : digits); };
  const statusLabel = function (status) { return status.replace(/-/g, " ").toUpperCase(); };
  const rawValue = function (value, digits, unit) { return Number.isFinite(value) ? fixed(value, digits) + unit : "Missing — null"; };
  function getSweep(model) {
    const key = state.scenario + model.id;
    if (!sweeps.has(key)) sweeps.set(key, Lab.thresholdSweep(dataset, model));
    return sweeps.get(key);
  }

  function renderFixture() {
    const metrics = currentEval().metrics;
    $("#quality-strip").textContent = `${metrics.evaluated} / 256 usable · ${metrics.missingSamples} missing · 12.5% anomalies`;
    const points = dataset.map(function (row, index) { return row.vibrationG === null ? null : `${(index / 255 * 320).toFixed(2)},${(54 - (row.vibrationG - 0.06) * 180).toFixed(2)}`; });
    const paths = []; let path = [];
    points.forEach(function (point) { if (point) path.push(point); else if (path.length) { paths.push(path); path = []; } });
    if (path.length) paths.push(path);
    const selected = dataset.find(function (row) { return row.id === state.selectedId; });
    const marker = selected ? `<path d="M${selected.index / 255 * 320} 0V60" stroke="#b84d28" stroke-dasharray="2 2"/>` : "";
    $("#signal-chart").innerHTML = `<svg viewBox="0 0 320 64" role="img" aria-label="256 deterministic vibration readings; gaps are missing readings"><path d="M0 54H320" stroke="#dae5de" fill="none"/>${paths.map(function (segment) { return `<polyline points="${segment.join(" ")}" fill="none" stroke="#126d68" stroke-width="1.5"/>`; }).join("")}${marker}</svg><span class="eyebrow">VIBRATION TRACE / 256 SECONDS${selected ? " · " + selected.id : ""}</span>`;
  }

  function renderCards() {
    const points = Lab.MODELS.map(function (model) { return { accuracy: Lab.evaluate(dataset, model, state.thresholds[model.id]).metrics.accuracy, latencyMs: Lab.estimateCost(model).latencyMsPerWindow }; });
    const frontier = Lab.isParetoFrontier(points);
    $("#model-cards").innerHTML = Lab.MODELS.map(function (model, index) {
      const result = Lab.evaluate(dataset, model, state.thresholds[model.id]);
      const cost = Lab.estimateCost(model);
      const metrics = result.metrics;
      return `<article class="model-card ${index ? "featured" : ""}">
        <div class="model-top"><div><h3>${model.name}</h3><div class="model-id">${model.id}</div></div><span class="model-kind">${model.kind === "rules" ? "INTERPRETABLE RULES" : "COMPACT LINEAR"}</span></div>
        <div class="model-threshold"><span class="value">${fixed(state.thresholds[model.id])}</span><span>current threshold</span><span class="frontier-badge">${frontier[index] ? "PARETO FRONTIER" : "DOMINATED"}</span></div>
        <div class="metrics-grid"><div><div class="metric-label">ACCURACY</div><div class="metric-value">${pct(metrics.accuracy)}</div></div><div><div class="metric-label">PRECISION</div><div class="metric-value">${pct(metrics.precision)}</div></div><div><div class="metric-label">RECALL</div><div class="metric-value">${pct(metrics.recall)}</div></div><div><div class="metric-label">F1 SCORE</div><div class="metric-value">${pct(metrics.f1)}</div></div></div>
        <div class="cost-row"><div class="cost-item"><span>False alarms</span><strong>${metrics.falsePositives}</strong></div><div class="cost-item"><span>Latency / window</span><strong>${fixed(cost.latencyMsPerWindow, 3)} ms</strong></div><div class="cost-item"><span>Modeled memory</span><strong>${cost.memoryKiB} KiB</strong></div><div class="cost-item"><span>Energy / window</span><strong>${fixed(cost.energyMicroJPerWindow, 3)} µJ</strong></div><div class="cost-item"><span>Battery / 1k</span><strong>${fixed(cost.batteryPercentPer1000Windows, 6)}%</strong></div></div>
        <div class="card-footer"><span class="sim-note">SIMULATED · ${model.operationsPerWindow} ops/window</span><button class="button secondary inspect-model" data-model="${model.id}">Inspect false alarms →</button></div>
      </article>`;
    }).join("");
    $$(".inspect-model").forEach(function (button) { button.addEventListener("click", function () { state.filter = "falsePositives"; selectModel(button.dataset.model); document.querySelector(".inspector").scrollIntoView({ behavior: "smooth", block: "start" }); }); });
  }

  function renderTradeoff() {
    const comparison = Lab.compareProfiles(dataset, Lab.MODELS, state.thresholds);
    const faster = comparison.faster;
    const baseline = comparison.baseline;
    const d = comparison.deltas;
    const signed = function (value, digits, suffix) { return `${value > 0 ? "+" : ""}${Number(value).toFixed(digits)}${suffix || ""}`; };
    const percentDelta = function (value) { return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`; };
    const costRow = function (label, field, digits, unit) {
      return `<tr><th scope="row">${label}</th><td>${fixed(faster.costEstimate[field], digits)}${unit}</td><td>${fixed(baseline.costEstimate[field], digits)}${unit}</td><td class="delta-good">${signed(d[field], digits, field === "batteryPercentPer1000Windows" ? " pp" : unit)}</td></tr>`;
    };
    $("#profile-tradeoff").innerHTML = `
      <div class="tradeoff-copy">
        <p class="eyebrow">FASTER PROFILE / SIMULATED TRADEOFF</p>
        <h3 id="tradeoff-title">${faster.model.name} is ${Math.abs(d.latencyMs / baseline.costEstimate.latencyMs * 100).toFixed(1)}% faster.</h3>
        <p>It uses ${(Math.abs(d.energyMicroJPerWindow) / baseline.costEstimate.energyMicroJPerWindow * 100).toFixed(1)}% less modeled energy per window. Compare its false alarms and missed events before choosing it: a faster profile is not necessarily a better detector.</p>
        <p>Threshold tuning changes decisions, not the fixed cost estimate. False alarms add no modeled battery cost because alert transmission and actuation energy are excluded—not because false alarms are free in real deployments.</p>
        <div class="tradeoff-assumption"><strong>${Lab.SCENARIOS.find(function (scenario) { return scenario.id === state.scenario; }).name} · current thresholds</strong><span>faster = lower simulated latency; deltas are faster − baseline; battery deltas use percentage points</span></div>
      </div>
      <div class="tradeoff-table-wrap"><table class="tradeoff-table">
        <caption>Current profile comparison</caption>
        <thead><tr><th scope="col">Metric</th><th scope="col">${faster.model.name}<small>FASTER</small></th><th scope="col">${baseline.model.name}<small>BASELINE</small></th><th scope="col">DELTA</th></tr></thead>
        <tbody>
          <tr><th scope="row">Threshold</th><td>${fixed(faster.threshold)}</td><td>${fixed(baseline.threshold)}</td><td>independent</td></tr>
          ${costRow("Latency / window", "latencyMs", 3, " ms")}
          ${costRow("Simulated p95", "p95LatencyMs", 4, " ms")}
          ${costRow("Memory footprint", "memoryBytes", 0, " B")}
          ${costRow("Energy / window", "energyMicroJPerWindow", 3, " µJ")}
          ${costRow("Battery / 1,000", "batteryPercentPer1000Windows", 6, "%")}
          <tr><th scope="row">False alarms</th><td>${faster.metrics.falsePositives} / ${faster.metrics.trueNegatives + faster.metrics.falsePositives} normal</td><td>${baseline.metrics.falsePositives} / ${baseline.metrics.trueNegatives + baseline.metrics.falsePositives} normal</td><td>${signed(d.falsePositives, 0)}</td></tr>
          <tr><th scope="row">Missed events</th><td>${faster.metrics.falseNegatives} / ${faster.metrics.falseNegatives + faster.metrics.truePositives} anomalies</td><td>${baseline.metrics.falseNegatives} / ${baseline.metrics.falseNegatives + baseline.metrics.truePositives} anomalies</td><td>${signed(d.falseNegatives, 0)}</td></tr>
          <tr><th scope="row">Recall</th><td>${pct(faster.metrics.recall)}</td><td>${pct(baseline.metrics.recall)}</td><td>${percentDelta(d.recall)}</td></tr>
        </tbody>
      </table></div>
      <div class="tradeoff-assumptions">
        <span><strong>Latency</strong> ${Lab.COST_ASSUMPTIONS.latencyFormula} ms; p95 = latency × 1.20. Neither is hardware measured.</span>
        <span><strong>Memory</strong> ${Lab.COST_ASSUMPTIONS.memoryBasis}; 1 KiB = 1,024 B.</span>
        <span><strong>Battery</strong> ${Lab.COST_ASSUMPTIONS.batteryCapacityWh} Wh; acquisition + inference only; no radio, idle, peripherals, losses. Energy = 18 + ops × 0.06 + bytes × 0.002 µJ. Per 1,000 windows: µWh = µJ × 1000 / 3600; battery % = µWh / (4.44 × 1,000,000) × 100.</span>
        <span><strong>False alarms</strong> Normal windows where score ≥ threshold; FPR = FP / (FP + TN); missing windows excluded. Cost excludes alert overhead.</span>
      </div>`;
  }

  function renderFrontier() {
    const points = Lab.MODELS.map(function (model) { return { model, accuracy: Lab.evaluate(dataset, model, state.thresholds[model.id]).metrics.accuracy, latencyMs: Lab.estimateCost(model).latencyMsPerWindow }; });
    const flags = Lab.isParetoFrontier(points);
    const x = function (value) { return 54 + (value - 0.075) / 0.085 * 340; };
    const y = function (value) { return 150 - value * 115; };
    const line = points.filter(function (_, i) { return flags[i]; }).sort(function (a, b) { return a.latencyMs - b.latencyMs; }).map(function (point) { return `${x(point.latencyMs)},${y(point.accuracy)}`; }).join(" ");
    $("#frontier-chart").innerHTML = `<svg viewBox="0 0 450 205" role="img" aria-label="Accuracy versus simulated latency. Frontier computed at the current thresholds.">${[0, 0.5, 1].map(function (value) { return `<path d="M54 ${y(value)}H406" stroke="#d8e1dc" stroke-dasharray="3 4"/><text x="43" y="${y(value) + 4}" text-anchor="end">${value * 100}%</text>`; }).join("")}<path d="M54 28V150H406" fill="none" stroke="#8ca19a"/><polyline points="${line}" stroke="#126d68" stroke-width="2" stroke-dasharray="4 4" fill="none"/>${points.map(function (point, index) { return `<circle cx="${x(point.latencyMs)}" cy="${y(point.accuracy)}" r="7" fill="${index ? "#c4522a" : "#126d68"}" stroke="#fff" stroke-width="2"/><text x="${x(point.latencyMs)}" y="${y(point.accuracy) - 14}" text-anchor="middle">${point.model.shortName} ${pct(point.accuracy)}</text>`; }).join("")}<text x="65" y="172">0.08 ms</text><text x="213" y="172">0.12 ms</text><text x="358" y="172">0.16 ms</text><text x="226" y="199" text-anchor="middle">SIMULATED LATENCY / WINDOW →</text></svg>`;
    $("#frontier-legend").innerHTML = points.map(function (point, index) { return `<span><i style="background:${index ? "var(--orange)" : "var(--teal)"}"></i>${point.model.name} <strong>${flags[index] ? "Efficient" : "Dominated"}</strong></span>`; }).join("");
  }

  function renderWorkbench() {
    const model = currentModel();
    const result = currentEval();
    const sweep = getSweep(model);
    const recommended = Lab.recommendedThreshold(sweep);
    const threshold = state.thresholds[state.modelId];
    $("#threshold-slider").value = threshold;
    $("#threshold-slider").style.background = `linear-gradient(90deg,var(--orange) ${threshold * 100}%,#e3e9e5 ${threshold * 100}%)`;
    $("#threshold-value").textContent = fixed(threshold);
    $("#recommendation").textContent = `Fixture-fit threshold ${fixed(recommended.threshold)} · best F1 ${pct(recommended.f1)} (not validation)`;
    $("#threshold-slider").setAttribute("aria-valuetext", fixed(threshold));
    $("#threshold-summary").innerHTML = `<div class="summary-item"><strong>${result.metrics.falsePositives}</strong><span>FALSE ALARMS</span></div><div class="summary-item"><strong>${result.metrics.falseNegatives}</strong><span>MISSED EVENTS</span></div><div class="summary-item"><strong>${pct(result.metrics.f1)}</strong><span>F1 SCORE</span></div><div class="summary-item"><strong>${result.metrics.missingSamples}</strong><span>MISSING SAMPLES</span></div>`;
    $("#sweep-chart").innerHTML = sweep.map(function (point) { return `<div class="sweep-bar ${point.threshold === recommended.threshold ? "recommended" : ""}" title="${fixed(point.threshold)} · F1 ${pct(point.f1)}"><i class="f1" style="height:${Math.max(2, point.f1 * 100)}%"></i><i class="recall" style="height:${Math.max(2, point.recall * 100)}%"></i></div>`; }).join("");
    const checkpoints = sweep.filter(function (point, index) { return index % 10 === 0 || point.threshold === threshold; });
    const sweepRow = function (title, format) { return `<tr><th scope="row">${title}</th>${checkpoints.map(function (point) { return `<td class="${point.threshold === threshold ? "current" : ""}">${format(point)}</td>`; }).join("")}</tr>`; };
    $("#sweep-table").innerHTML = `<table aria-label="Threshold sweep metrics"><tbody>${sweepRow("THRESHOLD", function (p) { return fixed(p.threshold); })}${sweepRow("PRECISION", function (p) { return pct(p.precision); })}${sweepRow("RECALL", function (p) { return pct(p.recall); })}${sweepRow("F1", function (p) { return pct(p.f1); })}${sweepRow("FP / FN", function (p) { return `${p.falsePositives} / ${p.falseNegatives}`; })}</tbody></table>`;
    $$(".tab").forEach(function (button) { const active = button.dataset.model === state.modelId; button.classList.toggle("active", active); button.setAttribute("role", "tab"); button.setAttribute("aria-selected", active); });
  }

  function driver(row) {
    const entries = Object.keys(row.contributions).filter(function (key) { return key !== "bias"; }).sort(function (a, b) { return Math.abs(row.contributions[b]) - Math.abs(row.contributions[a]); });
    return entries[0] ? entries[0].toUpperCase() : "BIAS";
  }

  function renderInspector() {
    const result = currentEval();
    const model = currentModel();
    const windows = Lab.inspectWindows(dataset, Lab.MODELS, state.thresholds);
    const decisionFor = function (row) { return row.decisions.find(function (decision) { return decision.modelId === model.id; }); };
    const filtered = windows.filter(function (row) {
      const decision = decisionFor(row);
      if (state.filter === "all") return true;
      if (state.filter === "missing") return row.missing;
      if (state.filter === "falsePositives") return decision.status === "false-alarm";
      if (state.filter === "falseNegatives") return decision.status === "missed-event";
      return decision.predicted === 1;
    });
    $("#fp-count").textContent = result.metrics.falsePositives;
    $("#fn-count").textContent = result.metrics.falseNegatives;
    $("#alert-count").textContent = result.metrics.truePositives + result.metrics.falsePositives;
    $("#window-count").textContent = windows.length;
    $("#missing-count").textContent = result.metrics.missingSamples;
    $("#inspector-model").textContent = model.name;
    const selected = windows.find(function (row) { return row.id === state.selectedId; }) || filtered[0];
    state.selectedId = selected ? selected.id : null;
    const scenario = Lab.SCENARIOS.find(function (entry) { return entry.id === state.scenario; });
    $("#inspector-context").textContent = `${scenario.name} · ${model.name} threshold ${fixed(state.thresholds[model.id])} · score ≥ threshold alerts · ${result.metrics.evaluated} / ${dataset.length} evaluated · ${result.metrics.missingSamples} gaps excluded from metrics · SIMULATED`;
    $("#window-timeline").innerHTML = windows.map(function (row) {
      const decision = decisionFor(row);
      const context = row.missing ? `missing ${row.missingFields.join(", ")}; both profiles skipped` : `score ${fixed(decision.score, 3)}, threshold ${fixed(decision.threshold)}; ${statusLabel(decision.status)}`;
      return `<button class="window-cell ${decision.status}" data-id="${row.id}" aria-pressed="${row.id === state.selectedId}" title="${row.id} · ${row.timestampSec}s · ${context}" aria-label="Inspect window ${row.id} at ${row.timestampSec}s: ${context}">${row.id}</button>`;
    }).join("");
    $$(".window-cell").forEach(function (button) {
      button.addEventListener("click", function () {
        state.selectedId = button.dataset.id;
        state.filter = windows.find(function (row) { return row.id === state.selectedId; }).missing ? "missing" : "all";
        renderInspector(); renderFixture();
        const updated = document.querySelector(`.window-cell[data-id="${state.selectedId}"]`);
        if (updated) updated.focus({ preventScroll: true });
      });
    });
    $("#error-table").innerHTML = filtered.map(function (row) {
      const decision = decisionFor(row);
      const other = row.decisions.find(function (entry) { return entry.modelId !== model.id; });
      return `<tr class="${row.id === state.selectedId ? "selected" : ""}" data-id="${row.id}" tabindex="0" aria-label="Inspect window ${row.id}"><td>${row.id}</td><td>${row.timestampSec}s</td><td class="score">${row.missing ? "—" : fixed(decision.score, 3)} / ${fixed(decision.threshold)}</td><td>${statusLabel(decision.status)}</td><td>${other.name}: ${statusLabel(other.status)}</td><td>${rawValue(row.vibrationG, 3, " g")}</td></tr>`;
    }).join("");
    $("#empty-errors").hidden = filtered.length > 0;
    $$("#error-table tr").forEach(function (tr) { const choose = function () { state.selectedId = tr.dataset.id; renderInspector(); renderFixture(); const updated = document.querySelector(`#error-table tr[data-id="${state.selectedId}"]`); if (updated) updated.focus({ preventScroll: true }); }; tr.addEventListener("click", choose); tr.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } }); });
    $("#detail-panel").innerHTML = selected ? detailHtml(selected, model, !filtered.some(function (row) { return row.id === selected.id; })) : `<div class="empty-state"><p class="eyebrow">NO MATCHING WINDOWS</p><h3>Nothing in this filter.</h3><p>Select any chronological tile, including a missing gap, or choose All windows.</p></div>`;
    $$(".filter").forEach(function (button) { const active = button.dataset.filter === state.filter; button.classList.toggle("active", active); button.setAttribute("aria-pressed", active); });
  }

  function detailHtml(row, model, outsideFilter) {
    const decision = row.decisions.find(function (entry) { return entry.modelId === model.id; });
    const table = `<div class="decision-table-wrap"><table class="decision-comparison" aria-label="Both simulated profile decisions for ${row.id}"><thead><tr><th scope="col">Profile</th><th scope="col">Score</th><th scope="col">Threshold</th><th scope="col">Margin</th><th scope="col">Decision</th></tr></thead><tbody>${row.decisions.map(function (entry) { return `<tr data-model="${entry.modelId}"><th scope="row">${entry.name}</th><td>${entry.score === null ? "—" : fixed(entry.score, 3)}</td><td>${fixed(entry.threshold)}</td><td>${entry.margin === null ? "—" : (entry.margin >= 0 ? "+" : "") + fixed(entry.margin, 3)}</td><td>${statusLabel(entry.status)}</td></tr>`; }).join("")}</tbody></table></div>`;
    const header = `<div class="detail-title"><div><p class="eyebrow">DETERMINISTIC WINDOW · SIMULATED</p><h3>${row.id} · ${row.timestampSec}s</h3></div><span class="detail-label">${row.missing ? "MISSING GAP" : statusLabel(decision.status)}</span></div>${outsideFilter ? "<p class=\"selection-note\">Selected window is outside the current list filter; its stable ID is retained while tuning.</p>" : ""}<div class="sensor-grid"><div><span>TEMPERATURE</span><strong>${rawValue(row.temperatureC, 2, " °C")}</strong></div><div><span>VIBRATION</span><strong>${rawValue(row.vibrationG, 3, " g")}</strong></div><div><span>CURRENT</span><strong>${rawValue(row.currentMa, 1, " mA")}</strong></div></div><h4>SAME WINDOW / TWO PROFILE DECISIONS</h4>${table}<p class="deploy-detail">Margin = score − threshold. Scores and margins are rounded for display; the full-precision score ≥ threshold rule determines the decision. Truth: ${row.label ? "anomaly" : "normal"}.</p>`;
    if (row.missing) return header + `<p class="explanation">Missing ${row.missingFields.join(", ")}. The chronological gap retains ${row.id} at ${row.timestampSec}s. Both profiles skip this window: no score, prediction, or margin is fabricated; it is excluded from metric denominators.</p>`;
    const contributionValues = Object.keys(decision.contributions).map(function (key) { return decision.contributions[key]; });
    const max = Math.max.apply(null, contributionValues.map(function (value) { return Math.abs(value); }).concat([0.01]));
    const explanation = decision.status === "false-alarm" ? `The combined score crossed the threshold although the fixture label is normal. ${driver(decision)} is the largest sensor contribution.` : decision.status === "missed-event" ? `The simulated score stayed below ${fixed(decision.threshold)} despite an anomaly label.` : `The ${model.name} decision agrees with the fixture label at this threshold.`;
    return header + `<h4 class="contribution-heading">${model.name.toUpperCase()} CONTRIBUTIONS · SCORE ${fixed(decision.score, 3)}</h4>${Object.keys(decision.contributions).map(function (key) { const value = decision.contributions[key]; return `<div class="contribution"><span>${key}</span><div class="contribution-bar"><i style="width:${Math.min(100, Math.abs(value) / max * 100)}%;background:${value < 0 ? "var(--teal)" : "var(--orange)"}"></i></div><small>${value >= 0 ? "+" : ""}${fixed(value, 3)}</small></div>`; }).join("")}<p class="explanation">${explanation}</p><p class="deploy-detail mono">Normalized T/V/I: ${fixed(decision.normalized.temperature, 3)} / ${fixed(decision.normalized.vibration, 3)} / ${fixed(decision.normalized.current, 3)}<br>Score = ${model.kind === "rules" ? "clamp(sum of contributions, 0, 1)" : "sigmoid(sum of contributions)"}</p>`;
  }

  function renderDeployment() {
    const model = currentModel(); const result = currentEval(); const cost = Lab.estimateCost(model);
    const comparison = Lab.compareProfiles(dataset, Lab.MODELS, state.thresholds);
    const card = Lab.deploymentCard(Object.assign({}, Lab.FIXTURE, { scenario: state.scenario }), model, state.thresholds[state.modelId], result.metrics, cost, comparison);
    const canonical = Lab.canonicalize(card); const checksum = Lab.fnv1a(canonical);
    $("#deployment-card").innerHTML = `<div class="deploy-block"><div class="deploy-kicker">SELECTED PROFILE</div><div class="deploy-value">${model.name}</div><div class="deploy-detail mono">${model.id}<br>threshold ${fixed(state.thresholds[state.modelId])}<br>${model.parameters ? Object.keys(model.parameters).length : 0} parameters</div></div><div class="deploy-block"><div class="deploy-kicker">FIXTURE & RESULT</div><div class="deploy-value mono">${Lab.FIXTURE.id}</div><div class="deploy-detail">${state.scenario} · seed 0xED6E2025 · ${result.metrics.evaluated}/${Lab.FIXTURE.windows} evaluated<br>accuracy ${pct(result.metrics.accuracy)} · F1 ${pct(result.metrics.f1)}<br>${result.metrics.falsePositives} false alarms · ${result.metrics.falseNegatives} misses</div></div><div class="deploy-block"><div class="deploy-kicker">ESTIMATED COST · SIMULATED</div><div class="deploy-value">${fixed(cost.latencyMsPerWindow)} ms / window</div><div class="deploy-detail">${cost.memoryKiB} KiB modeled memory · ${fixed(cost.energyMicroJPerWindow, 2)} µJ / window<br>battery ${cost.batteryPercentPer1000Windows.toFixed(6)}% / 1,000 · ${comparison.faster.model.name} is faster<br><span class="checksum">FNV-1a ${checksum}</span></div></div>`;
    $("#json-preview").textContent = JSON.stringify(Object.assign({}, card, { checksum: { algorithm: "FNV-1a-32", scope: "UTF-8 compact JSON body excluding checksum", value: checksum } }), null, 2);
    $("#copy-status").textContent = "";
    return { card, canonical, checksum };
  }

  function selectModel(modelId) { state.modelId = modelId; renderAll(); }
  function renderAll() { renderCards(); renderTradeoff(); renderFrontier(); renderWorkbench(); renderInspector(); renderFixture(); renderDeployment(); }
  $$(".tab").forEach(function (button) { button.addEventListener("click", function () { selectModel(button.dataset.model); }); });
  $$(".filter").forEach(function (button) { button.addEventListener("click", function () { state.filter = button.dataset.filter; state.selectedId = null; renderInspector(); renderFixture(); }); });
  $("#threshold-slider").addEventListener("input", function (event) { state.thresholds[state.modelId] = Number(event.target.value); renderAll(); });
  $("#reset-threshold").addEventListener("click", function () { state.thresholds[state.modelId] = currentModel().defaultThreshold; renderAll(); });
  $("#apply-recommended").addEventListener("click", function () { state.thresholds[state.modelId] = Lab.recommendedThreshold(getSweep(currentModel())).threshold; renderAll(); });
  $("#scenario-select").addEventListener("change", function (event) { state.scenario = event.target.value; dataset = Lab.createFixture(state.scenario); renderAll(); });
  $("#copy-json").addEventListener("click", async function () {
    const json = $("#json-preview").textContent;
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(json);
      else { const area = document.createElement("textarea"); area.value = json; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); const copied = document.execCommand("copy"); area.remove(); if (!copied) throw new Error("Clipboard unavailable"); }
      $("#copy-status").textContent = "Deployment JSON copied.";
    } catch (_) { $("#copy-status").textContent = "Clipboard unavailable. Download JSON or select the preview."; }
  });
  $("#download-json").addEventListener("click", function () { const blob = new Blob([$("#json-preview").textContent + "\n"], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `deployment-card-${state.scenario}-${state.modelId}-${fixed(state.thresholds[state.modelId]).replace(".", "-")}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000); $("#copy-status").textContent = "Deployment card download requested."; });
  renderAll();
})();
