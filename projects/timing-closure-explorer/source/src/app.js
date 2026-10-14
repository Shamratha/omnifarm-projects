import { demoSnapshot } from './data.js';
import {
  applyWhatIf,
  assessEvidence,
  buildSlackHistogram,
  buildSignoffReport,
  classifyPathException,
  compareMetrics,
  getPathRelatedHotspots,
  pathsFor,
  rankedHotspots,
  stageRecord,
  summarize
} from './model.js';
import { signoffCsv, signoffHtml } from './report-export.js';

const snapshot = structuredClone(demoSnapshot);
const state = {
  view: 'overview',
  analysis: 'setup',
  stage: 'signoff',
  corner: 'slow',
  mode: 'functional',
  selectedPathId: 'p-001',
  selectedHotspotId: 'hot-1',
  appliedCandidateId: null,
  filter: '',
  pathFilter: 'all',
  layer: 'all'
};

const root = document.querySelector('#view-root');
const toast = document.querySelector('#toast');

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const fmt = (value, digits = 3) => Number(value).toFixed(digits);
const signed = (value, digits = 3) => `${value >= 0 ? '+' : ''}${Number(value).toFixed(digits)}`;

function activePaths() {
  let paths = pathsFor(snapshot, state.analysis, state.stage, state.corner, state.mode);
  if (state.pathFilter === 'violating') paths = paths.filter((path) => path.slack < 0 && !classifyPathException(path, currentEvidence()).excluded);
  if (state.pathFilter === 'exceptions') paths = paths.filter((path) => path.exception);
  if (state.pathFilter === 'clock') paths = paths.filter((path) => path.launchClock === 'clk_core' || path.captureClock === 'clk_core');
  if (state.filter) {
    const query = state.filter.toLowerCase();
    paths = paths.filter((path) => [path.id, path.startpoint, path.endpoint, path.clock, path.launchClock, path.captureClock, path.reason, JSON.stringify(path.exception)].join(' ').toLowerCase().includes(query));
  }
  return paths;
}

function currentEvidence() { return assessEvidence(snapshot.manifest); }
function evidenceBanner() {
  const evidence = currentEvidence();
  const timing = evidence.timing.status;
  const constrained = evidence.constraints.status;
  const issues = evidence.reports.filter((report) => report.freshness !== 'fresh');
  const contextOrigin = state.stage === 'signoff' && state.corner === 'slow' && state.mode === 'functional' ? 'reported' : 'derived';
  return `<section class="evidence-banner" aria-label="Evidence and exception status">
    <div><span class="status-tag ${timing === 'fresh' ? 'pass' : 'warn'}">TIMING ${timing.toUpperCase()}</span>
      <span class="status-tag ${constrained === 'fresh' ? 'pass' : 'warn'}">CONSTRAINTS ${constrained.toUpperCase()}</span>
      <span class="status-tag info">${contextOrigin.toUpperCase()}</span></div>
    <p>${timing === 'fresh' && constrained === 'fresh' ? 'Freshness and exceptions are independent: excluded paths are audited, not counted as timing violations.' : 'UNVERIFIED TIMING: stale or incomplete evidence is not a false-path waiver. Displayed slack is retained for investigation only.'}</p>
    ${issues.length ? `<p class="mono">${issues.map((report) => `${esc(report.name)}: ${esc(report.reasons.join(', '))}`).join(' · ')}</p>` : ''}
  </section>`;
}

function exceptionInventory() {
  const report = buildSignoffReport(snapshot, { stage: state.stage, corner: state.corner, mode: state.mode, analysis: state.analysis });
  return `<section class="panel" style="margin-top:17px"><div class="panel-heading"><div><div class="panel-title">Path exceptions · setup and hold</div>
    <div class="panel-subtitle">Applied false paths, asynchronous clock groups, and candidates stay distinct from stale report evidence.</div></div></div>
    <div class="table-scroll"><table class="source-table"><thead><tr><th>PATH</th><th>ANALYSIS</th><th>LAUNCH → CAPTURE</th><th>DISPOSITION</th><th>SOURCE / SCOPE</th></tr></thead>
    <tbody>${report.exceptions.map((item) => `<tr><td>${esc(item.id)}</td><td>${esc(item.analysis)}</td><td>${esc(item.launchClock)} → ${esc(item.captureClock)}<br />${esc(item.clockRelation)}</td><td><span class="status-tag ${item.review ? 'warn' : 'info'}">${esc(item.label)}</span></td><td>${esc(item.source)} · ${esc(item.exception.scope ?? 'path')}</td></tr>`).join('')}</tbody></table></div>
    <div class="panel-body">${report.baseline.setup.excludedPaths + report.baseline.hold.excludedPaths} excluded · ${report.exceptions.filter((item) => item.review).length} requiring exception review · no exception can refresh stale timing evidence.</div></section>`;
}

function selectedPath() {
  const paths = pathsFor(snapshot, state.analysis, state.stage, state.corner, state.mode);
  return paths.find((path) => path.id === state.selectedPathId) ?? paths[0];
}
function selectedHotspot() { return snapshot.congestion.find((tile) => tile.id === state.selectedHotspotId) ?? snapshot.congestion[0]; }

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove('show'), 3500);
}

function render() {
  root.innerHTML = evidenceBanner() + viewTemplate();
  if (state.view === 'signoff') root.insertAdjacentHTML('beforeend', exceptionInventory());
  document.querySelectorAll('[data-view]').forEach((element) => element.classList.toggle('active', element.dataset.view === state.view));
  document.querySelectorAll('[data-analysis]').forEach((element) => element.classList.toggle('active', element.dataset.analysis === state.analysis));
  syncContextControls();
  bindViewEvents();
}

function syncContextControls() {
  document.querySelector('#stage-select').value = state.stage;
  document.querySelector('#corner-select').value = state.corner;
  document.querySelector('#mode-select').value = state.mode;
  document.querySelector('#analysis-badge').textContent = `${state.analysis.toUpperCase()} ANALYSIS`;
  const evidence = currentEvidence();
  document.querySelector('#freshness-label').textContent = evidence.overall === 'fresh' ? 'REPORTS FRESH' : evidence.overall === 'stale' ? 'REPORTS STALE' : 'REPORTS UNVERIFIED';
  document.querySelector('.freshness-pill').style.color = evidence.overall === 'fresh' ? 'var(--teal)' : 'var(--orange)';
  document.querySelector('.pulse-dot').style.background = evidence.overall === 'fresh' ? 'var(--teal)' : 'var(--orange)';
  document.querySelector('.source-card-top span:last-child').textContent = `Bundle ${evidence.overall === 'fresh' ? 'verified' : evidence.overall}`;
  document.querySelector('#status-message').textContent = evidence.overall === 'fresh' ? 'All bundled reports indexed · exceptions audited separately' : 'Report evidence unresolved · displayed slack is not verified for sign-off';
  const record = stageRecord(snapshot, state.stage);
  document.querySelector('#run-name').textContent = record.run;
  document.querySelector('#snapshot-id').textContent = state.stage === 'signoff' ? snapshot.manifest.snapshotId : `${record.run.toUpperCase().replace('_', '-')}`;
}

function bindViewEvents() {
  root.querySelectorAll('[data-view]').forEach((element) => element.addEventListener('click', () => {
    state.view = element.dataset.view;
    render();
  }));
  document.querySelectorAll('[data-action="select-path"]').forEach((element) => element.addEventListener('click', () => {
    state.selectedPathId = element.dataset.path;
    state.view = element.dataset.goView ?? state.view;
    render();
  }));
  document.querySelectorAll('[data-action="select-hotspot"]').forEach((element) => element.addEventListener('click', () => {
    state.selectedHotspotId = element.dataset.hotspot;
    state.view = element.dataset.goView ?? state.view;
    render();
  }));
  document.querySelectorAll('[data-action="apply-candidate"]').forEach((element) => element.addEventListener('click', () => {
    state.appliedCandidateId = element.dataset.candidate;
    showToast(`${findCandidateLabel(element.dataset.candidate)} applied as a deterministic modeled candidate.`);
    render();
  }));
  document.querySelectorAll('[data-action="reset-candidate"]').forEach((element) => element.addEventListener('click', () => {
    state.appliedCandidateId = null;
    showToast('Returned to the reported baseline. No source report was changed.');
    render();
  }));
  document.querySelectorAll('[data-action="show-candidates"]').forEach((element) => element.addEventListener('click', () => { state.view = 'candidates'; render(); }));
  document.querySelectorAll('[data-action="show-timing"]').forEach((element) => element.addEventListener('click', () => { state.view = 'timing'; render(); }));
  document.querySelectorAll('[data-action="export"]').forEach((element) => element.addEventListener('click', () => exportReport(element.dataset.format ?? 'html')));
  document.querySelectorAll('[data-action="source-details"]').forEach((element) => element.addEventListener('click', () => { state.view = 'signoff'; render(); }));
  document.querySelectorAll('[data-action="refresh"]').forEach((element) => element.addEventListener('click', () => {
    const evidence = currentEvidence();
    showToast(evidence.overall === 'fresh' ? 'Reports re-indexed. Bundle timestamps are consistent with the snapshot.' : 'The same bundle is still unresolved; refresh does not hide stale or unverified evidence.');
    render();
  }));
  document.querySelectorAll('[data-action="layer"]').forEach((element) => element.addEventListener('click', () => { state.layer = element.dataset.layer; render(); }));
  document.querySelectorAll('[data-action="path-filter"]').forEach((element) => element.addEventListener('click', () => { state.pathFilter = element.dataset.filter; render(); }));
  const search = document.querySelector('#path-search');
  if (search) search.addEventListener('input', (event) => { state.filter = event.target.value; render(); requestAnimationFrame(() => { const next = document.querySelector('#path-search'); next?.focus(); next?.setSelectionRange(state.filter.length, state.filter.length); }); });
}

function findCandidateLabel(id) { return snapshot.candidates.find((candidate) => candidate.id === id)?.title ?? id; }

function viewTemplate() {
  if (state.view === 'timing') return timingView();
  if (state.view === 'physical') return physicalView();
  if (state.view === 'candidates') return candidatesView();
  if (state.view === 'signoff') return signoffView();
  return overviewView();
}

function heading(eyebrow, title, description, actions = true) {
  document.querySelector('#page-eyebrow').textContent = eyebrow;
  document.querySelector('#page-title').textContent = title;
  document.querySelector('#page-description').textContent = description;
  return actions ? '' : '';
}

function overviewView() {
  heading('RUN OVERVIEW', 'Closure at a glance', 'Find the next 10 ps hiding in your design.');
  const paths = pathsFor(snapshot, state.analysis, state.stage, state.corner, state.mode);
  const summary = summarize(paths, snapshot, state.analysis, state.stage);
  const setupSummary = summarize(pathsFor(snapshot, 'setup', state.stage, state.corner, state.mode), snapshot, 'setup', state.stage);
  const holdSummary = summarize(pathsFor(snapshot, 'hold', state.stage, state.corner, state.mode), snapshot, 'hold', state.stage);
  const hotspotList = rankedHotspots(snapshot).slice(0, 4);
  return `<section class="kpi-grid">
    ${kpi('SETUP WNS', `${fmt(setupSummary.wns)} <span class="kpi-unit">ns</span>`, 'WORST TIMED SLACK', setupSummary.wns, setupSummary.violations ? 'fail' : 'pass', `${setupSummary.excludedPaths} excluded paths not counted`)}
    ${kpi('SETUP TNS', `${fmt(setupSummary.tns)} <span class="kpi-unit">ns</span>`, `${setupSummary.violations} NEGATIVE TIMED PATHS`, setupSummary.tns, setupSummary.violations ? 'fail' : 'pass', 'Derived from bundled path sample')}
    ${kpi('HOLD WNS', `${fmt(holdSummary.wns)} <span class="kpi-unit">ns</span>`, 'WORST NEGATIVE SLACK', holdSummary.wns, holdSummary.wns < 0 ? 'fail' : 'pass', holdSummary.wns < 0 ? '2 endpoints need attention' : 'clean across 2,396 checks')}
    ${kpi('ROUTE OVERFLOW', `${fmt(summary.overflow, 1)}<span class="kpi-unit">%</span>`, 'GLOBAL ROUTING', summary.overflow, 'warn', 'M4 is the limiting layer')}
  </section>
  <section class="grid-2">
    <div class="panel"><div class="panel-heading"><div><div class="panel-title">Closure trajectory</div><div class="panel-subtitle">WNS / TNS across implementation stages</div></div><button class="panel-link" data-action="show-timing">View timing details →</button></div>${stageChart()}</div>
    <div class="panel"><div class="panel-heading"><div><div class="panel-title">Worst paths</div><div class="panel-subtitle">${state.analysis === 'setup' ? 'Setup' : 'Hold'} · sorted by slack</div></div><button class="panel-link" data-action="show-timing">All paths →</button></div>${pathTable(paths.slice(0, 5), true)}</div>
  </section>
  <section class="grid-2" style="margin-top:18px"><div class="panel"><div class="panel-heading"><div><div class="panel-title">Slack distribution</div><div class="panel-subtitle">${summary.endpoints} timed paths · ${summary.excludedPaths} excluded from distribution</div></div><span class="status-tag ${summary.status === 'UNVERIFIED' ? 'warn' : 'fail'}">${summary.status === 'UNVERIFIED' ? 'UNVERIFIED' : `${summary.violations} VIOLATING`}</span></div>${histogram(paths)}</div>
    <div class="panel"><div class="panel-heading"><div><div class="panel-title">Congestion hotspots</div><div class="panel-subtitle">Top overflow regions · route_042</div></div><button class="panel-link" data-view="physical">Map view →</button></div><div class="hotspot-list">${hotspotList.map(hotspotRow).join('')}</div></div></section>
  <section class="panel" style="margin-top:18px"><div class="panel-heading"><div><div class="panel-title">Clock health</div><div class="panel-subtitle">CTS insertion delay and local skew by domain</div></div><button class="panel-link" data-view="physical">Open clock tree →</button></div>${clockGrid()}</section>
  <div class="insight-strip"><span class="insight-icon">✦</span><div class="insight-copy"><strong>Suggested next move</strong> · 3 worst setup paths share <span class="mono">n_102</span> and overlap the M4 hotspot at <span class="mono">(47, 32)</span>.</div><button class="panel-link" data-action="show-candidates">Explore fixes →</button></div>`;
}

function kpi(label, value, detail, rawValue, className, footer) {
  const evidence = currentEvidence();
  const timingMetric = label !== 'ROUTE OVERFLOW';
  const unverified = timingMetric ? evidence.timing.status !== 'fresh' || evidence.constraints.status !== 'fresh' : evidence.physical.status !== 'fresh';
  if (unverified) className = 'warn';
  const delta = unverified ? 'EVIDENCE ISSUE' : timingMetric ? 'EXCEPTIONS FILTERED' : 'GLOBAL ROUTING';
  return `<article class="kpi-card"><div class="kpi-top"><span class="kpi-label">${label}</span><span class="info-icon">ⓘ</span></div><div class="kpi-value ${className}">${value}</div><div class="kpi-bottom"><span>${detail}</span><span class="delta ${className === 'pass' ? 'good' : className === 'warn' ? 'warn' : 'bad'}">${delta}</span></div><div class="kpi-bottom" style="margin-top:7px"><span>${unverified ? 'Observed value · not sign-off verified' : footer}</span><span class="status-tag ${className}">${unverified ? 'UNVERIFIED' : className === 'pass' ? 'PASS' : className === 'warn' ? 'WATCH' : 'FAIL'}</span></div></article>`;
}

function stageChart() {
  const stages = snapshot.stages;
  const svg = stages.map((stage, index) => {
    const x = 7 + index * 43;
    const y = 35 + Math.abs(stage.setupWns) * 34;
    const next = stages[index + 1];
    const nextX = next ? 7 + (index + 1) * 43 : x;
    const nextY = next ? 35 + Math.abs(next.setupWns) * 34 : y;
    return `<line x1="${x}" y1="${y}" x2="${nextX}" y2="${nextY}" stroke="#ff827e" stroke-width="1.1"/><circle cx="${x}" cy="${y}" r="2.3" fill="#ff827e"/><circle cx="${x}" cy="${y}" r="4.4" fill="none" stroke="rgba(255,130,126,.22)"/>`;
  }).join('');
  const bars = stages.map((stage) => `<div class="stage-row"><div class="stage-label">${stage.label}<small>${stage.run}</small></div><svg class="sparkline" viewBox="0 0 100 70" preserveAspectRatio="none"><line x1="0" y1="48" x2="100" y2="48" stroke="#274158" stroke-width=".7" stroke-dasharray="2 2"/>${svg}</svg><div class="stage-value">${fmt(stage.setupWns)}<small>${fmt(stage.setupTns)} TNS</small></div></div>`).join('');
  return `<div class="stage-chart"><div class="chart-legend"><span class="legend-item"><i class="legend-line"></i>WNS</span><span class="legend-item"><i class="legend-line tns"></i>TNS</span></div>${bars}<div class="chart-footer"><span>0.00 ns target</span><span class="current">● CURRENT · ${state.stage.toUpperCase()}</span></div></div>`;
}

function pathTable(paths, compact = false) {
  if (!paths.length) return `<div class="empty-comparison">No paths match this filter.</div>`;
  const evidence = currentEvidence();
  const negativeCounts = new Map();
  for (const path of paths) {
    if (path.slack < 0 && !classifyPathException(path, evidence).excluded) {
      negativeCounts.set(path.slack, (negativeCounts.get(path.slack) ?? 0) + 1);
    }
  }
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Timing paths table"><table class="path-table"><thead><tr>
    <th>PATH</th><th>SLACK</th><th>ENDPOINT</th><th>CLOCK PAIR</th><th>STATUS</th>${compact ? '' : '<th>LOGIC</th><th>NET</th><th>CELLS</th><th>CAUSE</th>'}
    </tr></thead><tbody>${paths.map((path) => {
      const classification = classifyPathException(path, evidence);
      const status = classification.label === 'TIMED' ? (path.slack < 0 ? 'VIOLATING' : 'CLEAN') : classification.label;
      const tied = !classification.excluded && (negativeCounts.get(path.slack) ?? 0) > 1;
      return `<tr class="clickable ${path.id === state.selectedPathId ? 'selected' : ''}" data-action="select-path" data-path="${esc(path.id)}" data-go-view="${compact ? 'timing' : state.view}">
        <td><span class="path-rank">${path.rank}</span> <button class="path-select" aria-label="Inspect ${esc(path.id)} to ${esc(path.endpoint)}">${esc(path.id)}</button></td>
        <td><span class="slack ${path.slack < 0 ? 'negative' : 'positive'}">${signed(path.slack)}</span>${tied ? '<span class="slack-tie">TIED</span>' : ''}</td>
        <td class="path-endpoint"><span class="path-name" title="${esc(path.endpoint)}"><b>${esc(path.endpoint)}</b></span></td>
        <td class="path-clocks"><span class="clock-chip ${path.clock === 'clk_bus' ? 'bus' : ''}">${esc(path.launchClock)} → ${esc(path.captureClock)}</span></td>
        <td class="path-status"><span class="status-tag ${classification.excluded ? 'info' : classification.review ? 'warn' : path.slack < 0 ? 'fail' : 'pass'}">${status}</span></td>
        ${compact ? '' : `<td class="mono">${fmt(path.logicDelay)}</td><td class="mono">${fmt(path.netDelay)}</td><td class="mono">${path.cells}</td><td>${esc(path.reason)}</td>`}
      </tr>`;
    }).join('')}</tbody></table></div>${compact ? '<div class="table-more" data-action="show-timing">View all timing paths →</div>' : ''}`;
}

function histogram(paths) {
  const bins = buildSlackHistogram(paths.filter((path) => !classifyPathException(path, currentEvidence()).excluded));
  const max = Math.max(...bins.map((bin) => bin.count), 1);
  return `<div class="histogram-wrap"><div class="negative-zone"><div class="histogram">${bins.map((bin, index) => `<div class="histogram-col"><span class="histogram-count">${bin.count}</span><span class="histogram-bar ${index < 3 ? 'negative' : index === 3 ? 'warn' : ''}" style="height:${Math.max((bin.count / max) * 92, 4)}px"></span><span class="histogram-label">${bin.label}</span></div>`).join('')}</div></div><div class="histogram-axis"><span>WORSE SLACK</span><span>BETTER SLACK</span></div></div>`;
}

function hotspotRow(tile) { return `<div class="hotspot-row ${tile.id === state.selectedHotspotId ? 'selected' : ''}" data-action="select-hotspot" data-hotspot="${tile.id}" data-go-view="physical"><div class="heat-tile">${tile.overflow}%</div><div><div class="hotspot-name">${tile.layer} · region (${tile.x}, ${tile.y})</div><div class="hotspot-meta">${tile.nets.join(', ')} · ${tile.paths.length} critical paths</div></div><div class="hotspot-value">+${tile.overflow}<small>overflow</small></div></div>`; }

function clockGrid() { return `<div class="clock-grid">${snapshot.clocks.map((clock) => `<div class="clock-card"><div class="clock-title"><span>${clock.name}</span><span class="status-tag ${clock.status === 'pass' ? 'pass' : 'warn'}">${clock.status.toUpperCase()}</span></div><div class="clock-period">${fmt(clock.period, 3)}<small>ns period</small></div><div class="clock-detail"><span>Insertion</span><span>${fmt(clock.latency)} ns</span></div><div class="clock-detail"><span>Local skew</span><span>${fmt(clock.skew, 3)} ns</span></div><div class="clock-bar"><span style="width:${Math.min(clock.skew * 1000, 100)}%"></span></div></div>`).join('')}</div>`; }

function timingView() {
  heading('TIMING EXPLORER', 'Trace the failing paths', 'Follow delay from launch flop to capture pin — then fix what moves the needle.');
  const paths = activePaths();
  const selected = selectedPath();
  const evidence = currentEvidence();
  const classification = classifyPathException(selected, evidence);
  return `<div class="filter-bar"><div class="filter-search"><input id="path-search" value="${esc(state.filter)}" placeholder="Search endpoint, clock pair, exception..." aria-label="Search timing paths" /></div>
    ${[['all', 'All paths'], ['violating', 'Violating only'], ['exceptions', 'Exceptions'], ['clock', 'clk_core']].map(([filter, label]) => `<button class="filter-chip ${state.pathFilter === filter ? 'active' : ''}" data-action="path-filter" data-filter="${filter}">${label}</button>`).join('')}
    <button class="filter-chip" data-action="show-candidates">✦ What-if lab</button></div>
    <div class="timing-layout"><div class="panel path-list-panel"><div class="table-toolbar"><strong>Ranked ${state.analysis} paths</strong><span>${paths.length} rows · slack / rank / ID</span></div>${pathTable(paths, false)}</div>
    <div class="detail-stack">${pathDetail(selected)}<div class="panel"><div class="panel-heading"><div><div class="panel-title">Path provenance</div><div class="panel-subtitle">Evidence and exception status are separate</div></div><span class="status-tag info">${selected.origin.toUpperCase()}</span></div>
    <div class="panel-body"><div class="inspector-list">
      <div class="inspector-line"><span>Timing report</span><strong>report_timing.rpt · ${evidence.timing.status}</strong></div>
      <div class="inspector-line"><span>Constraint source</span><strong>${esc(classification.source ?? 'constraints.sdc')} · ${evidence.constraints.status}</strong></div>
      <div class="inspector-line"><span>Physical overlap</span><strong>${getPathRelatedHotspots(snapshot, selected).length} congestion tiles</strong></div>
      <div class="inspector-line"><span>Path disposition</span><strong>${esc(classification.label)}</strong></div>
      <div class="inspector-line"><span>Clock relationship</span><strong>${esc(selected.launchClock)} → ${esc(selected.captureClock)}<br />${esc(selected.clockRelation)}</strong></div>
    </div></div></div></div></div>`;
}

function pathDetail(path) {
  if (!path) return '<div class="detail-panel">No path selected.</div>';
  const logicWidth = path.logicDelay / (path.logicDelay + path.netDelay) * 100;
  const hot = getPathRelatedHotspots(snapshot, path);
  const classification = classifyPathException(path, currentEvidence());
  const status = classification.excluded ? classification.label : classification.review ? classification.label : path.slack < 0 ? 'VIOLATING' : 'CLEAN';
  return `<div class="detail-panel"><div class="detail-overline"><span>PATH ${path.id.toUpperCase()} · ${path.launchClock} → ${path.captureClock}</span><span class="status-tag ${classification.excluded ? 'info' : classification.review ? 'warn' : path.slack < 0 ? 'fail' : 'pass'}">${status}</span></div><div class="detail-title">${esc(path.startpoint)} → ${esc(path.endpoint)}</div><div class="detail-subtitle">${esc(path.reason)} · ${path.cells} cells · ${hot.length} hotspot overlap${hot.length === 1 ? '' : 's'} · ${esc(path.clockRelation)} clock relation</div><div class="route-chain">${path.segments.map((segment, index) => `<span class="route-node ${index === 0 || index === path.segments.length - 1 ? 'highlight' : ''}">${esc(segment)}</span>${index < path.segments.length - 1 ? '<span class="route-arrow">›</span>' : ''}`).join('')}</div><div class="metric-row"><div class="mini-metric"><label>ARRIVAL</label><value>${fmt(path.arrival)} ns</value></div><div class="mini-metric"><label>REQUIRED</label><value>${fmt(path.required)} ns</value></div><div class="mini-metric"><label>SLACK</label><value class="${path.slack < 0 ? 'fail' : ''}">${signed(path.slack)} ns</value></div></div><div class="delay-bar"><span class="delay-logic" style="width:${logicWidth}%"></span><span class="delay-net" style="width:${100 - logicWidth}%"></span></div><div class="delay-labels"><span>LOGIC DELAY · ${fmt(path.logicDelay)} ns</span><span>NET DELAY · ${fmt(path.netDelay)} ns</span></div><div class="exception-box"><b>${classification.label}</b> · ${path.exception ? esc(typeof path.exception === 'object' ? `${path.exception.kind} · ${path.exception.status}` : path.exception) : 'No path exception'} · constraints evidence ${currentEvidence().constraints.status}</div><div class="detail-actions"><button class="button primary small" data-action="show-candidates">Explore fixes <span>→</span></button><button class="button secondary small" data-action="select-hotspot" data-hotspot="${path.hotspotIds[0] ?? 'hot-1'}" data-go-view="physical">Show in layout</button></div></div>`;
}

function physicalView() {
  heading('PHYSICAL EXPLORER', 'See timing in context', 'Correlate critical paths with placement, clock distribution, and route demand.');
  const tile = selectedHotspot();
  const relatedPaths = pathsFor(snapshot, state.analysis, state.stage, state.corner, state.mode).filter((path) => tile.paths.includes(path.id));
  const visibleHotspots = rankedHotspots(snapshot, state.layer);
  return `<div class="physical-toolbar"><div class="toolbar-group"><span class="toolbar-label">LAYER</span>${['all', 'M4', 'M5', 'M6'].map((layer) => `<button class="filter-chip ${state.layer === layer ? 'active' : ''}" data-action="layer" data-layer="${layer}">${layer === 'all' ? 'All layers' : layer}</button>`).join('')}</div><div class="toolbar-group"><span class="status-tag info">${state.analysis.toUpperCase()} PATH OVERLAY</span><button class="button secondary small" data-action="show-timing">Open timing table</button></div></div><div class="physical-layout"><div class="die-panel"><div class="die-header"><div class="die-title">orion_dsp_top · ${snapshot.manifest.technology}</div><div class="die-legend"><span><i class="legend-square macro"></i>macros</span><span><i class="legend-square"></i>instances</span><span><i class="legend-square hot"></i>overflow</span></div></div>${layoutSvg(visibleHotspots)}<div class="die-footer"><span>die 180 × 120 µm · 68% utilization</span><span>selected: ${tile.layer} / ${tile.id}</span></div></div><div class="map-side"><div class="selected-object"><div class="object-type">SELECTED HOTSPOT</div><h3>${tile.layer} · (${tile.x}, ${tile.y})</h3><div class="object-stats"><div class="object-stat"><span>Demand / capacity</span><b>${tile.demand} / ${tile.capacity}</b></div><div class="object-stat"><span>Overflow</span><b style="color:var(--red)">+${tile.overflow}%</b></div><div class="object-stat"><span>Affected nets</span><b>${tile.nets.length}</b></div><div class="object-stat"><span>Critical paths</span><b>${tile.paths.length}</b></div></div><div class="related-list"><div class="related-list-title">AFFECTED PATHS</div>${relatedPaths.slice(0, 4).map((path) => `<div class="related-item" data-action="select-path" data-path="${path.id}" data-go-view="timing"><span>${path.id} · ${path.endpoint.split('/')[0]}</span><span>${signed(path.slack)}</span></div>`).join('')}</div></div><div class="panel"><div class="panel-heading"><div><div class="panel-title">Clock tree snapshot</div><div class="panel-subtitle">Selected domain · clk_core</div></div></div><div class="panel-body">${clockTreeMini()}</div></div></div></div>`;
}

function layoutSvg(visibleHotspots) {
  const scaleX = (x) => x / 120 * 100;
  const scaleY = (y) => y / 100 * 100;
  const hotspotSvg = visibleHotspots.map((tile, index) => `<rect class="congestion-tile ${index === 0 ? '' : index < 3 ? 'warn' : 'cool'}" x="${scaleX(tile.x)}" y="${scaleY(tile.y)}" width="${scaleX(tile.w)}" height="${scaleY(tile.h)}" rx="1"/><text class="hot-label" x="${scaleX(tile.x + tile.w / 2)}" y="${scaleY(tile.y + tile.h / 2)}" dominant-baseline="middle">+${tile.overflow}</text>`).join('');
  const nets = snapshot.nets.map((net) => `<polyline class="net-line ${net.critical ? 'critical' : ''} ${net.clock ? 'clock' : ''}" points="${net.points.map(([x, y]) => `${scaleX(x)},${scaleY(y)}`).join(' ')}"/>`).join('');
  const instances = snapshot.instances.map((instance) => `<g class="instance-group"><rect class="instance ${instance.macro ? 'macro' : ''} ${instance.path && selectedPath()?.segments.includes(instance.id) ? 'selected' : ''}" x="${scaleX(instance.x)}" y="${scaleY(instance.y)}" width="${scaleX(instance.w ?? 3)}" height="${scaleY(instance.h ?? 3)}" rx=".8"/><text class="instance-label" x="${scaleX(instance.x + (instance.w ?? 3) / 2)}" y="${scaleY(instance.y + (instance.h ?? 3) / 2)}" dominant-baseline="middle">${esc(instance.label)}</text></g>`).join('');
  return `<div class="die-canvas"><div class="die-outline"></div><svg class="die-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Simplified die layout map">${hotspotSvg}${nets}${instances}<text class="axis-label" x="2" y="98">0</text><text class="axis-label" x="96" y="98">120</text><text class="axis-label" x="2" y="4">100</text></svg></div>`;
}

function clockTreeMini() { return `<svg viewBox="0 0 250 88" width="100%" height="88" aria-label="Clock tree snapshot"><path d="M12 44H53M53 44L88 19M53 44l35 25M88 19h45m-45 0 28-12m-28 12 28 12M88 69h45m-45 0 28-12m-28 12 28 12" fill="none" stroke="#4e7885" stroke-width="1.4"/><circle cx="12" cy="44" r="4" fill="#65d6b3"/><circle cx="53" cy="44" r="3" fill="#8ea9ff"/><circle cx="88" cy="19" r="3" fill="#8ea9ff"/><circle cx="88" cy="69" r="3" fill="#8ea9ff"/><circle cx="133" cy="19" r="3" fill="#f2b96b"/><circle cx="133" cy="69" r="3" fill="#65d6b3"/><text x="8" y="63" fill="#819caf" font-family="DM Mono" font-size="8">root</text><text x="143" y="22" fill="#819caf" font-family="DM Mono" font-size="8">u_reg_b</text><text x="143" y="72" fill="#819caf" font-family="DM Mono" font-size="8">u_reg_a</text><text x="91" y="9" fill="#657f95" font-family="DM Mono" font-size="7">+18 ps late</text></svg>`; }

function candidatesView() {
  heading('WHAT-IF LAB', 'Try the next move', 'Deterministic estimates — baseline stays immutable, every tradeoff stays visible.');
  const applied = state.appliedCandidateId ? applyWhatIf(snapshot, state.appliedCandidateId, state.analysis, state.stage, state.corner, state.mode) : null;
  return `<div class="candidate-intro"><div class="candidate-intro-inner"><div class="lab-icon">✦</div><div><h3>Modeled repair candidates</h3><p>These are local estimates, not a replacement for OpenSTA or sign-off extraction.</p></div><div class="model-note">RULESET v0.4<br />DETERMINISTIC · REPEATABLE</div></div></div><div class="candidate-grid">${snapshot.candidates.map((candidate) => candidateCard(candidate)).join('')}</div><div class="panel comparison-panel"><div class="panel-heading"><div><div class="panel-title">Before / after comparison</div><div class="panel-subtitle">${applied ? `${applied.candidate.title} · modeled against ${snapshot.manifest.snapshotId}` : 'Apply a candidate to inspect modeled deltas.'}</div></div>${applied ? '<span class="status-tag model">MODELED</span>' : '<span class="status-tag info">BASELINE</span>'}</div>${applied ? comparisonTable(applied) : '<div class="empty-comparison">Select <b>Apply what-if</b> on a candidate above. The source reports and baseline KPIs remain unchanged.</div>'}</div>`;
}

function candidateCard(candidate) {
  const applied = state.appliedCandidateId === candidate.id;
  const model = candidate.model;
  return `<article class="candidate-card ${applied ? 'applied' : ''}"><div class="candidate-top"><span class="candidate-kind" style="color:${candidate.accent}">${candidate.kind}</span>${applied ? '<span class="status-tag model">APPLIED</span>' : '<span class="status-tag info">MODELED</span>'}</div><div class="candidate-target">TARGET · ${candidate.target}</div><h3>${candidate.title}</h3><div class="candidate-desc">${candidate.description}</div><div class="candidate-rationale"><strong>Why this?</strong> ${candidate.rationale}</div><div class="candidate-metrics"><div class="candidate-metric"><label>SETUP WNS</label><value>${signed(model.setupWns)} ns</value></div><div class="candidate-metric"><label>HOLD WNS</label><value class="${model.holdWns < 0 ? 'watch' : ''}">${signed(model.holdWns)} ns</value></div><div class="candidate-metric"><label>OVERFLOW</label><value class="${model.overflow > 0 ? 'watch' : ''}">${signed(model.overflow, 1)}%</value></div></div><div class="candidate-bottom"><div class="candidate-risk">Risk · <b>${candidate.risk}</b> · ${candidate.affectedPaths} paths</div><div class="candidate-actions">${applied ? '<button class="button secondary small" data-action="reset-candidate">Reset</button>' : `<button class="button primary small" data-action="apply-candidate" data-candidate="${candidate.id}">Apply what-if</button>`}</div></div></article>`;
}

function comparisonTable(applied) {
  const metrics = compareMetrics({ ...applied.baseline, area: snapshot.totals.area, power: snapshot.totals.power }, applied.summary);
  return `<table class="comparison-table"><thead><tr><th>METRIC</th><th>BASELINE · REPORTED</th><th>MODELED RESULT</th><th>DELTA</th><th>READ</th></tr></thead><tbody>${metrics.map((metric) => `<tr><td>${metric.key}</td><td>${fmtMetric(metric.baseline, metric.unit)}</td><td>${fmtMetric(metric.candidate, metric.unit)}</td><td class="${metric.better ? 'delta-up' : 'delta-down'}">${signed(metric.delta, metric.unit === '%' ? 1 : 3)}${metric.unit === '%' ? '%' : metric.unit && metric.unit !== 'ns' ? ` ${metric.unit}` : metric.unit}</td><td><span class="status-tag ${metric.better ? 'pass' : 'warn'}">${metric.better ? 'IMPROVED' : 'WATCH'}</span></td></tr>`).join('')}</tbody></table>`;
}

function fmtMetric(value, unit) { return `${Number(value).toFixed(unit === '%' ? 1 : unit === 'ns' ? 3 : 0)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`; }

function signoffView() {
  heading('SIGN-OFF REPORT', 'Evidence, not assumptions', 'Review report freshness, closure status, and modeled changes before export.');
  const report = buildSignoffReport(snapshot, { stage: state.stage, corner: state.corner, mode: state.mode, analysis: state.analysis });
  const setup = report.baseline.setup;
  const hold = report.baseline.hold;
  const applied = state.appliedCandidateId ? applyWhatIf(snapshot, state.appliedCandidateId, state.analysis, state.stage, state.corner, state.mode) : null;
  const evidence = report.evidence;
  const warnings = setup.violations + hold.violations + report.exceptions.filter((item) => item.review).length + (evidence.overall === 'fresh' ? 0 : 1);
  const title = report.closureStatus === 'UNVERIFIED' ? 'Unverified timing · report evidence needs attention' : 'Conditional sign-off · review evidence and exceptions';
  const checklist = ['timing', 'constraints', 'clock', 'physical'].map((domain) => checkRow(
    evidence[domain].status === 'fresh' ? 'pass' : 'warn', `${domain} evidence`,
    `${evidence[domain].reports.length} report(s) · ${evidence[domain].reasons.join(', ') || 'snapshot-consistent'}`,
    evidence[domain].status.toUpperCase()
  )).join('') + [setup, hold].map((summary) => checkRow(
    summary.status === 'PASS' ? 'pass' : 'warn', `${summary.analysis} timing`,
    `${summary.violations} observed negative timed paths · ${summary.excludedPaths} excluded · WNS ${fmt(summary.wns)} ns`, summary.status
  )).join('') + checkRow('warn', 'DRC / LVS', 'Not bundled. Prototype evidence is not silicon sign-off.', 'N/A');
  return `<div class="signoff-banner"><div class="signoff-icon">!</div><div><h3>${title}</h3>
    <p>${warnings} observations / reviews remain. No extraction, STA, DRC, or LVS is run by this prototype.</p></div>
    <button class="button primary" data-action="export" data-format="html">Export HTML report ↗</button></div>
    <div class="report-grid"><section class="panel"><div class="panel-heading"><div><div class="panel-title">Closure checklist</div>
      <div class="panel-subtitle">${esc(snapshot.manifest.snapshotId)} · ${setup.origin.toUpperCase()}</div></div><span class="status-tag warn">${report.closureStatus}</span></div>
      <div class="check-list">${checklist}</div></section>
    <section class="panel"><div class="panel-heading"><div class="panel-title">Run manifest</div></div><div class="panel-body"><div class="report-meta">
      ${[['Design', snapshot.manifest.design], ['Top module', snapshot.manifest.top], ['Technology', snapshot.manifest.technology],
        ['Stage / corner / mode', `${state.stage} / ${state.corner} / ${state.mode}`], ['Generated', snapshot.manifest.generatedAt],
        ['Baseline origin', setup.origin], ['Candidate', applied ? `MODELED · ${applied.candidate.title}` : 'None'],
        ['Timing closure eligible', report.signoffEligible ? 'Yes (prototype only)' : 'No']]
        .map(([label, value]) => `<div class="meta-row"><span>${label}</span><strong>${esc(value)}</strong></div>`).join('')}
      </div><div class="side-divider" style="margin:20px 0 15px"></div><div class="report-actions">
        <button class="button secondary small" data-action="export" data-format="json">Download JSON</button>
        <button class="button secondary small" data-action="export" data-format="csv">Download CSV</button>
        <button class="button secondary small" data-action="export" data-format="print">Print / PDF</button>
      </div></div></section></div>
    <section class="panel" style="margin-top:17px"><div class="panel-heading"><div><div class="panel-title">Source report inventory</div>
      <div class="panel-subtitle">Computed status and reasons, not just declared freshness.</div></div><span class="status-tag ${evidence.overall === 'fresh' ? 'pass' : 'warn'}">${evidence.overall.toUpperCase()}</span></div>
      <div class="table-scroll"><table class="source-table"><thead><tr><th>FILE</th><th>KIND</th><th>GENERATED</th><th>STATUS</th><th>REASONS</th></tr></thead>
      <tbody>${evidence.reports.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.kind)}</td><td>${esc(item.generatedAt ?? 'missing')}</td>
        <td><span class="status-tag ${item.freshness === 'fresh' ? 'pass' : 'warn'}">${item.freshness.toUpperCase()}</span></td>
        <td>${esc(item.reasons.join(', ') || 'none')}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function checkRow(kind, name, source, value) { return `<div class="check-row"><span class="check-icon ${kind}">${kind === 'pass' ? '✓' : kind === 'warn' ? '!' : '·'}</span><div><div class="check-name">${name}</div><div class="check-source">${source}</div></div><span class="status-tag ${kind === 'pass' ? 'pass' : kind === 'warn' ? 'warn' : 'info'}">${value}</span></div>`; }

function exportReport(format = 'html') {
  const report = buildSignoffReport(snapshot, { stage: state.stage, corner: state.corner, mode: state.mode, analysis: state.analysis });
  const applied = state.appliedCandidateId ? applyWhatIf(snapshot, state.appliedCandidateId, state.analysis, state.stage, state.corner, state.mode) : null;
  if (applied) report.candidate = { id: applied.candidate.id, title: applied.candidate.title, modeledSummary: applied.summary, paths: applied.paths };
  if (format === 'json') download('signoff-report.json', JSON.stringify(report, null, 2), 'application/json');
  else if (format === 'csv') download('signoff-paths.csv', signoffCsv(report), 'text/csv');
  else if (format === 'print') window.print();
  else {
    download('signoff-report.html', signoffHtml(report), 'text/html');
  }
  showToast(`${format === 'print' ? 'Print dialog opened.' : `Exported sign-off ${format.toUpperCase()} report.`}`);
}

function download(filename, content, type) { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([content], { type })); link.download = filename; link.click(); URL.revokeObjectURL(link.href); }

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => { state.view = item.dataset.view; render(); }));
document.querySelectorAll('.segment').forEach((item) => item.addEventListener('click', () => { state.analysis = item.dataset.analysis; state.selectedPathId = pathsFor(snapshot, state.analysis, state.stage, state.corner, state.mode)[0]?.id ?? 'p-001'; render(); }));
document.querySelector('#stage-select').addEventListener('change', (event) => { state.stage = event.target.value; render(); });
document.querySelector('#corner-select').addEventListener('change', (event) => { state.corner = event.target.value; render(); });
document.querySelector('#mode-select').addEventListener('change', (event) => { state.mode = event.target.value; render(); });
document.querySelector('#refresh-button').addEventListener('click', () => {
  const evidence = currentEvidence();
  showToast(evidence.overall === 'fresh' ? 'Reports re-indexed. Bundle timestamps are consistent with the snapshot.' : 'Bundle still unresolved. Replace stale source evidence before sign-off; refresh cannot make old reports fresh.');
  render();
});
document.querySelector('#export-top').addEventListener('click', () => exportReport('html'));
document.querySelector('#source-details').addEventListener('click', () => { state.view = 'signoff'; render(); });

render();

export { state, snapshot, activePaths };
