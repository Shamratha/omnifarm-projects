import { features, mapLabels, sourceMeta } from './data.js';
import { buildExportPackage, confidenceBand, geometryDistance, kindMeta, recordDecision, restoreCandidates, statusLabel, syntheticCandidates } from './conflation.js';

const STORAGE_KEY = 'conflation-workbench:SF-2025-01:v1';
const seedCandidates = syntheticCandidates(features);

function loadCandidates() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return restoreCandidates(seedCandidates, saved ? JSON.parse(saved) : null);
  } catch {
    return seedCandidates;
  }
}

function persistCandidates() {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state.candidates)); } catch { /* Offline mode can continue without browser storage. */ }
}

const state = {
  candidates: loadCandidates(),
  selectedId: 'cand-001',
  filter: 'all',
  tab: 'candidates',
  query: '',
  showPrimary: true,
  showSecondary: true,
  toast: ''
};

const app = document.querySelector('#app');
const getCandidate = () => state.candidates.find((candidate) => candidate.id === state.selectedId) ?? state.candidates[0];
const getFeature = (id) => features.find((feature) => feature.id === id);
const visibleCandidates = () => state.candidates.filter((candidate) => {
  const primary = getFeature(candidate.primaryId);
  const secondary = getFeature(candidate.secondaryId);
  const matchesQuery = !state.query || `${primary.name} ${secondary.name} ${candidate.id}`.toLowerCase().includes(state.query.toLowerCase());
  const matchesFilter = state.filter === 'all' || candidate.status === state.filter;
  return matchesQuery && matchesFilter;
});

function icon(name) {
  const icons = {
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    download: '<path d="M12 4v10m0 0 4-4m-4 4-4-4M5 20h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15m6-12v15"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.more}</svg>`;
}

function render() {
  const candidate = getCandidate();
  const selectedPrimary = getFeature(candidate.primaryId);
  const selectedSecondary = getFeature(candidate.secondaryId);
  const counts = state.candidates.reduce((result, item) => { result[item.status] += 1; return result; }, { pending: 0, accepted: 0, rejected: 0, deferred: 0 });
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><div class="brand-mark">${icon('layers')}</div><div><strong>Conflation <span>Workbench</span></strong><small>LOCAL REVIEW CONSOLE</small></div></div>
      <div class="session"><span class="offline"><i></i> Offline workspace</span><span class="separator"></span><span>Session <b>SF-2025-01</b></span><button class="icon-button" data-action="more" aria-label="More options">${icon('more')}</button></div>
    </header>
    <main class="shell">
      <section class="intro"><div><p class="eyebrow">Reconciliation workspace</p><h1>Resolve map differences with confidence.</h1><p class="intro-copy">Review candidate matches between two synthetic extracts. Every decision is local, explainable, and recorded for audit.</p></div><div class="intro-actions"><button class="button secondary" data-action="reset">Reset session</button><button class="button primary" data-action="export">${icon('download')} Export review package</button></div></section>
      <section class="source-strip">
        <div class="source-head"><div><p class="eyebrow">Source extracts</p><h2>Two views of the same streets</h2></div><span class="local-badge">${icon('map')} Synthetic fixture · no network</span></div>
        <div class="sources"><div class="source-card"><span class="source-dot primary-dot"></span><div><strong>${sourceMeta.primary.label}</strong><small>${sourceMeta.primary.description} · refreshed Jun 18, 2024</small></div><span class="source-count">8 ways</span></div><div class="source-card"><span class="source-dot secondary-dot"></span><div><strong>${sourceMeta.secondary.label}</strong><small>${sourceMeta.secondary.description} · refreshed Feb 03, 2025</small></div><span class="source-count">9 ways</span></div></div>
      </section>
      <nav class="tabs"><button class="tab ${state.tab === 'candidates' ? 'active' : ''}" data-tab="candidates">Candidate matches <b>${state.candidates.length}</b></button><button class="tab ${state.tab === 'audit' ? 'active' : ''}" data-tab="audit">Audit trail <b>${state.candidates.reduce((n, c) => n + c.audit.length, 0)}</b></button><span class="tab-spacer"></span><span class="progress-label">${counts.accepted + counts.rejected + counts.deferred} of ${state.candidates.length} reviewed</span><div class="progress"><i style="width:${((counts.accepted + counts.rejected + counts.deferred) / state.candidates.length) * 100}%"></i></div></nav>
      ${state.tab === 'audit' ? renderAudit() : `<section class="workspace"><aside class="candidate-panel">${renderCandidatePanel(counts)}</aside><section class="review-panel">${renderReview(selectedPrimary, selectedSecondary, candidate)}</section></section>`}
    </main>
    <div class="toast ${state.toast ? 'visible' : ''}">${state.toast}</div>
  `;
  bindEvents();
}

function renderCandidatePanel(counts) {
  const filters = [['all', 'All', state.candidates.length], ['pending', 'Needs review', counts.pending], ['accepted', 'Accepted', counts.accepted], ['rejected', 'Rejected', counts.rejected], ['deferred', 'Deferred', counts.deferred]];
  return `<div class="panel-title"><div><p class="eyebrow">Review queue</p><h2>Candidate matches</h2></div><span class="queue-count">${counts.pending} open</span></div><div class="filter-row">${filters.map(([value, label, count]) => `<button class="filter ${state.filter === value ? 'selected' : ''}" data-filter="${value}">${label} <b>${count}</b></button>`).join('')}</div><label class="search">${icon('search')}<input value="${state.query}" placeholder="Search ways or IDs" data-search /></label><div class="candidate-list">${visibleCandidates().map(renderCandidate).join('') || '<div class="empty">No candidates match this view.</div>'}</div>`;
}

function renderCandidate(candidate) {
  const primary = getFeature(candidate.primaryId);
  const secondary = getFeature(candidate.secondaryId);
  const meta = kindMeta[candidate.kind];
  return `<button class="candidate ${candidate.id === state.selectedId ? 'selected' : ''}" data-select="${candidate.id}" aria-label="${primary.name} and ${secondary.name}, ${candidate.distance} schematic units apart, ${candidate.confidence}% ${confidenceBand(candidate.confidence)} confidence, ${candidate.freshness.label}"><div class="candidate-top"><span class="type-pill ${meta.tone}">${meta.label}</span><span class="candidate-status ${candidate.status}">${statusLabel(candidate.status)}</span></div><div class="candidate-name"><strong>${primary.name}</strong><span>↔</span><strong>${secondary.name}</strong></div><div class="candidate-evidence"><div class="mini-geometry">${renderMiniGeometry(primary.geometry, secondary.geometry)}</div><div class="evidence-details"><div class="source-line"><span class="source-marker primary-marker"></span><span>${sourceMeta.primary.shortLabel}</span><code>${primary.id}</code></div><div class="source-line"><span class="source-marker secondary-marker"></span><span>${sourceMeta.secondary.shortLabel}</span><code>${secondary.id}</code></div><div class="evidence-meta"><span>${candidate.distance} units geometry</span><span>${candidate.conflicts.length ? `${candidate.conflicts.length} tag conflict${candidate.conflicts.length > 1 ? 's' : ''}` : 'Tags agree'}</span></div></div></div><div class="candidate-meta"><span>Freshness <b class="freshness-${freshnessTone(candidate.freshness)}">${candidate.freshness.label}</b></span><span>Confidence <b class="confidence-${confidenceTone(candidate.confidence)}">${candidate.confidence}% · ${confidenceBand(candidate.confidence)}</b></span></div></button>`;
}

function confidenceTone(confidence) { return confidence >= 80 ? 'high' : confidence >= 60 ? 'medium' : 'low'; }
function freshnessTone(value) { return value.label === 'Recent' ? 'recent' : value.label === 'Within a year' ? 'current' : 'stale'; }

function renderConfidenceEvidence(evidence) {
  return `<details class="computation-details"><summary>How confidence was computed</summary><div class="formula-line">${evidence.rules.formula}</div><dl><dt>Geometry</dt><dd>${formatScore(evidence.distanceScore)} × ${evidence.rules.geometryWeight} = ${formatScore(evidence.contributions.geometry)}</dd><dt>Name</dt><dd>${evidence.nameMatch ? 'Normalized names match' : 'Names differ'} · ${formatScore(evidence.nameScore)} × ${evidence.rules.nameWeight}</dd><dt>Road type</dt><dd>${evidence.typeMatch ? 'Highway tags match' : 'Highway tags differ'} · ${formatScore(evidence.typeScore)} × ${evidence.rules.typeWeight}</dd><dt>Tag penalty</dt><dd>−${formatScore(evidence.conflictPenalty)} (${evidence.conflictCount} conflict${evidence.conflictCount === 1 ? '' : 's'})</dd></dl><small>Raw ${formatScore(evidence.rawScore)} → rounded ${evidence.roundedPercent}% · ${evidence.band} band</small></details>`;
}

function renderFreshnessEvidence(evidence) {
  return `<details class="computation-details"><summary>How freshness was computed</summary><div class="formula-line">${evidence.formula}</div><small>${evidence.basis}</small><small>Thresholds: Recent &lt; ${evidence.thresholds.recentExclusive} days · Stale ≥ ${evidence.thresholds.staleInclusive} days</small></details>`;
}

function formatScore(value) { return Number(value).toFixed(3); }

function renderReview(primary, secondary, candidate) {
  const meta = kindMeta[candidate.kind];
  const conflicts = candidate.conflicts;
  return `<div class="review-header"><div><p class="eyebrow">Selected candidate <span class="id-code">${candidate.id}</span></p><h2>${primary.name} <span class="muted-arrow">↔</span> ${secondary.name}</h2><p class="review-subtitle">${meta.label} · ${candidate.status === 'pending' ? 'Awaiting your decision' : statusLabel(candidate.status)}</p></div><div class="decision-zone"><div class="decision-context" id="decision-evidence"><span><b class="confidence-${confidenceTone(candidate.confidence)}">${candidate.confidence}%</b> ${confidenceBand(candidate.confidence)} confidence</span><span><b class="freshness-${freshnessTone(candidate.freshness)}">${candidate.freshness.label}</b> freshness</span><small>${candidate.distance} units · ${candidate.conflicts.length} tag conflict${candidate.conflicts.length === 1 ? '' : 's'}</small></div><div class="decision-buttons"><button class="decision accept" aria-describedby="decision-evidence" data-decision="accepted">${icon('check')} Accept</button><button class="decision reject" aria-describedby="decision-evidence" data-decision="rejected">${icon('x')} Reject</button><button class="decision defer" aria-describedby="decision-evidence" data-decision="deferred">${icon('clock')} Defer</button></div></div></div>
     <div class="map-card"><div class="map-toolbar"><span><i class="legend-line city-line"></i>${sourceMeta.primary.shortLabel}<i class="legend-line open-line"></i>${sourceMeta.secondary.shortLabel}</span><span class="map-note">Schematic geometry · not to scale</span></div><div class="map-canvas">${renderMap(primary, secondary)}<div class="north">N</div><div class="distance-chip"><span class="distance-dot"></span><b>${candidate.distance} units</b><small>geometry distance</small></div></div></div>
     <div class="insight-grid"><div class="confidence-card"><div class="card-heading"><span>Match confidence</span><strong class="confidence-${confidenceTone(candidate.confidence)}">${candidate.confidence}%</strong></div><div class="confidence-bar"><i style="width:${candidate.confidence}%"></i></div><div class="confidence-foot"><span>${confidenceBand(candidate.confidence)} band · weighted-v1</span><span>${candidate.confidence >= 80 ? 'High confidence' : 'Needs attention'}</span></div>${renderConfidenceEvidence(candidate.confidenceEvidence)}</div><div class="freshness-card"><div class="card-heading"><span>Source freshness</span><span class="freshness-label">${candidate.freshness.label}</span></div><div class="freshness-row"><div><small>${sourceMeta.primary.shortLabel}</small><b>${formatDate(primary.updated)}</b></div><span class="freshness-arrow">→</span><div><small>${sourceMeta.secondary.shortLabel}</small><b>${formatDate(secondary.updated)}</b></div></div><p>${candidate.freshness.days ?? '—'} days between source updates</p>${renderFreshnessEvidence(candidate.freshness)}</div></div>
    <div class="details-grid"><div class="tags-card"><div class="card-heading"><span>Tag comparison</span><span class="conflict-count ${conflicts.length ? '' : 'none'}">${conflicts.length ? `${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}` : 'No conflicts'}</span></div>${renderTags(primary, secondary, conflicts)}</div><div class="audit-card"><div class="card-heading"><span>Decision history</span><span class="audit-count">${candidate.audit.length} event${candidate.audit.length === 1 ? '' : 's'}</span></div>${candidate.audit.length ? candidate.audit.map((event) => `<div class="audit-event"><span class="audit-dot ${event.action}"></span><div><b>${statusLabel(event.action)}</b><small>${event.at} · local session</small></div></div>`).join('') : '<div class="audit-empty">No decisions recorded yet.<br/>Your action will appear here.</div>'}</div></div>`;
}

function renderTags(primary, secondary, conflicts) {
  const keys = [...new Set([...Object.keys(primary.tags), ...Object.keys(secondary.tags)])];
  return `<div class="tag-table"><div class="tag-row tag-head"><span>Key</span><span>${sourceMeta.primary.shortLabel}</span><span>${sourceMeta.secondary.shortLabel}</span></div>${keys.map((key) => { const conflict = conflicts.some((item) => item.key === key); return `<div class="tag-row ${conflict ? 'is-conflict' : ''}"><code>${key}</code><span>${primary.tags[key] ?? '—'}</span><span>${secondary.tags[key] ?? '—'} ${conflict ? '<em>!</em>' : ''}</span></div>`; }).join('')}</div>`;
}

function renderMap(primary, secondary) {
  const all = [...primary.geometry, ...secondary.geometry];
  const minX = Math.min(...all.map((point) => point[0])) - 45; const maxX = Math.max(...all.map((point) => point[0])) + 45;
  const minY = Math.min(...all.map((point) => point[1])) - 45; const maxY = Math.max(...all.map((point) => point[1])) + 45;
  const view = `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
  const path = (line) => line.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const roads = features.filter((feature) => feature.id !== primary.id && feature.id !== secondary.id && feature.geometry.some(([x, y]) => x > minX && x < maxX && y > minY && y < maxY)).map((feature) => `<path class="context-road" d="${path(feature.geometry)}"/>`).join('');
  const labels = mapLabels.filter((label) => label.x > minX && label.x < maxX && label.y > minY && label.y < maxY).map((label) => `<text x="${label.x}" y="${label.y}" class="map-label">${label.text}</text>`).join('');
  const endpoints = [primary.geometry[0], primary.geometry.at(-1), secondary.geometry[0], secondary.geometry.at(-1)].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" class="endpoint"/>`).join('');
  return `<svg class="map-svg" viewBox="${view}" role="img" aria-label="Schematic geometry comparison"><defs><pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="#e9edf0" stroke-width="1"/></pattern></defs><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="url(#grid)"/>${roads}${labels}<path class="selected-road primary-road" d="${path(primary.geometry)}"/><path class="selected-road secondary-road" d="${path(secondary.geometry)}"/>${endpoints}</svg>`;
}

function renderMiniGeometry(primaryGeometry, secondaryGeometry) {
  const all = [...primaryGeometry, ...secondaryGeometry];
  const minX = Math.min(...all.map(([x]) => x)) - 12; const maxX = Math.max(...all.map(([x]) => x)) + 12;
  const minY = Math.min(...all.map(([, y]) => y)) - 12; const maxY = Math.max(...all.map(([, y]) => y)) + 12;
  const path = (line) => line.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
  return `<svg viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" role="img" aria-label="Geometry preview: solid city streets line and dashed open map line"><path class="mini-road mini-primary" d="${path(primaryGeometry)}"/><path class="mini-road mini-secondary" d="${path(secondaryGeometry)}"/></svg>`;
}

function renderAudit() {
  const events = state.candidates.flatMap((candidate) => candidate.audit.map((event) => ({ ...event, candidate }))).sort((a, b) => b.at.localeCompare(a.at));
  const auditRows = events.map(({ candidate, action, at, sourceEvidence, computation }) => {
    const actionIcon = action === 'accepted' ? icon('check') : action === 'rejected' ? icon('x') : icon('clock');
    const evidenceSummary = sourceEvidence && computation
      ? `${sourceEvidence.primaryId} ↔ ${sourceEvidence.secondaryId} · ${sourceEvidence.geometryDistance} units · ${sourceEvidence.tagConflicts.length} tag conflicts · ${computation.confidence}% confidence · ${computation.freshness.label}`
      : 'Legacy event · source evidence snapshot unavailable';
    return `<div class="audit-list-row"><div class="audit-icon ${action}">${actionIcon}</div><div class="audit-list-main"><strong>${statusLabel(action)} <span>· ${candidate.id}</span></strong><p>${getFeature(candidate.primaryId).name} ↔ ${getFeature(candidate.secondaryId).name}</p><small>${evidenceSummary}</small></div><time datetime="${at}">${formatAuditTime(at)}</time></div>`;
  }).join('');
  const auditContent = events.length ? `<div class="audit-list">${auditRows}</div>` : `<div class="empty-audit"><div class="empty-icon">${icon('clock')}</div><h3>No decisions yet</h3><p>Accept, reject, or defer a candidate to start the audit trail.</p></div>`;
  return `<section class="audit-view"><div class="audit-view-head"><div><p class="eyebrow">Review history</p><h2>Audit trail</h2><p>Every local decision is append-only and included in the exported package.</p></div><button class="button primary" data-action="export">${icon('download')} Export audit</button></div>${auditContent}</section>`;
}

function formatDate(date) { return new Intl.DateTimeFormat('en', { month: 'short', day: '2-digit', year: 'numeric' }).format(new Date(date)); }
function formatAuditTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
    : value;
}
function showToast(message) { state.toast = message; render(); window.setTimeout(() => { state.toast = ''; render(); }, 2400); }

function bindEvents() {
  document.querySelectorAll('[data-select]').forEach((element) => element.addEventListener('click', () => { state.selectedId = element.dataset.select; render(); }));
  document.querySelectorAll('[data-filter]').forEach((element) => element.addEventListener('click', () => { state.filter = element.dataset.filter; render(); }));
  document.querySelectorAll('[data-tab]').forEach((element) => element.addEventListener('click', () => { state.tab = element.dataset.tab; render(); }));
  document.querySelector('[data-search]')?.addEventListener('input', (event) => { state.query = event.target.value; render(); const input = document.querySelector('[data-search]'); input.focus(); input.setSelectionRange(state.query.length, state.query.length); });
  document.querySelectorAll('[data-decision]').forEach((element) => element.addEventListener('click', () => { const candidate = getCandidate(); const action = element.dataset.decision; recordDecision(candidate, action); persistCandidates(); showToast(`${statusLabel(action)} · ${candidate.id} recorded`); }));
  document.querySelectorAll('[data-action="export"]').forEach((element) => element.addEventListener('click', () => { const data = JSON.stringify(buildExportPackage(state.candidates, features), null, 2); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); link.download = 'conflation-review-package.json'; link.click(); URL.revokeObjectURL(link.href); showToast('Review package exported locally'); }));
  document.querySelector('[data-action="reset"]')?.addEventListener('click', () => { state.candidates = syntheticCandidates(features); state.selectedId = 'cand-001'; state.filter = 'all'; state.tab = 'candidates'; try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* no-op */ } showToast('Session reset to synthetic fixture'); });
}

render();

export { state, render, geometryDistance };
