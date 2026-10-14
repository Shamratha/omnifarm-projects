import { dataset as bundledDataset } from './fixtures.js';
import { buildScorecard, compareRuns, explainRecord, summarize, validateDataset, SEVERITY_WEIGHTS } from './evaluation.js';
import { filterRows, loadWorkspace, saveReview, scorecardCsv } from './workspace.js';
import { icon } from './icons.js';
import { escapeHtml, resultBadge, renderScoreExplanation } from './presentation.js';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const modalRoot = $('#modal-root');
const toast = $('#toast');
let modalReturnFocus = null;
const { data: initialData, error: storageError } = loadWorkspace(bundledDataset, localStorage);
const state = {
  data: initialData,
  page: 'matrix',
  baselineId: 'run-1-2',
  candidateId: 'run-1-3',
  search: '',
  category: 'all',
  severity: 'all',
  outcome: 'all',
  selectedId: null,
  mobileNav: false,
  viewAll: false,
  evidenceId: null,
  evidenceRun: 'candidate',
};

const category = (id) => state.data.categories.find((item) => item.id === id) ?? { id, name: id, color: '#8993a4', description: '' };
const run = (id) => state.data.runs.find((item) => item.id === id);
const showToast = (message, kind = 'success') => {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3200);
};
const download = (filename, content, type) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
};
const scorecard = () => buildScorecard(state.data, state.baselineId, state.candidateId);
const rows = () => compareRuns(state.data, state.baselineId, state.candidateId);
const filteredRows = () => filterRows(rows(), { query: state.search, category: state.category, severity: state.severity, outcome: state.outcome });
const candidateSummary = () => summarize(state.data, state.candidateId);
const baselineSummary = () => summarize(state.data, state.baselineId);
const percent = (value) => `${Number(value).toFixed(2)}%`;

function categoryPill(item) {
  const cat = category(item.categoryId);
  return `<span class="category-pill"><i style="--dot:${cat.color}"></i>${escapeHtml(cat.name)}</span>`;
}

function severityPill(value) {
  return `<span class="severity-pill ${value}"><i></i>${escapeHtml(value)}</span>`;
}

function metricCard(label, value, note, tone = 'default', arrow = '') {
  return `<article class="metric-card ${tone}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)} ${arrow}</strong><span>${escapeHtml(note)}</span></article>`;
}

function renderHeader() {
  const runInfo = run(state.candidateId);
  return `<header class="topbar">
    <button class="brand" data-action="nav" data-page="matrix" aria-label="Go to evaluation matrix"><span class="brand-mark">${icon('shield')}</span><span>guardrail</span></button>
    <div class="topbar-center"><span class="offline-badge">${icon('offline')} Offline workspace</span><span class="topbar-divider"></span><span class="run-context">${escapeHtml(runInfo.version)} · ${escapeHtml(runInfo.source)}</span></div>
    <div class="topbar-actions"><button class="icon-button help" title="About this workspace" data-action="about">${icon('help')}</button><button class="avatar" data-action="about" aria-label="About local reviewer">LR</button><button class="mobile-menu" data-action="toggle-nav" aria-label="Toggle navigation" aria-expanded="${state.mobileNav}">${icon('menu')}</button></div>
  </header>`;
}

function renderSidebar() {
  const navigation = [
    { id: 'matrix', label: 'Evaluation matrix', icon: 'matrix' },
    { id: 'prompts', label: 'Prompt library', icon: 'library' },
    { id: 'runs', label: 'Model runs', icon: 'history' },
    { id: 'reviews', label: 'Review queue', icon: 'review', badge: state.data.records.filter((record) => record.runId === state.candidateId && record.annotation === null).length },
  ];
  return `<aside class="sidebar ${state.mobileNav ? 'open' : ''}"><nav><p class="nav-label">Workspace</p>${navigation.map((item) => `<button class="nav-item ${state.page === item.id ? 'active' : ''}" data-action="nav" data-page="${item.id}">${icon(item.icon)}<span>${item.label}</span>${item.badge ? `<b>${item.badge}</b>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><button class="nav-item ${state.page === 'scorecard' ? 'active' : ''}" data-action="nav" data-page="scorecard">${icon('download')}<span>Scorecard export</span></button><div class="local-note"><span class="mini-check">${icon('check')}</span><div><strong>Saved locally</strong><small>Nothing leaves this device</small></div></div><button class="user-card" data-action="about"><span class="avatar small">LR</span><span><strong>Local reviewer</strong><small>Workspace owner</small></span>${icon('down')}</button></div></aside>`;
}

function renderLayout(content) {
  app.innerHTML = `${renderHeader()}<div class="app-shell">${renderSidebar()}<main class="main-content">${content}</main></div>`;
  if (storageError) window.setTimeout(() => showToast(storageError, 'warning'), 250);
}

function renderVersionControls() {
  return `<div class="version-controls"><label><span>Baseline</span><select data-field="baseline">${state.data.runs.map((item) => `<option value="${item.id}" ${item.id === state.baselineId ? 'selected' : ''}>${escapeHtml(item.version)} · ${escapeHtml(item.name.replace('Local fixture ', ''))}</option>`).join('')}</select></label><span class="versus">vs</span><label><span>Candidate</span><select data-field="candidate">${state.data.runs.map((item) => `<option value="${item.id}" ${item.id === state.candidateId ? 'selected' : ''}>${escapeHtml(item.version)} · ${escapeHtml(item.name.replace('Local fixture ', ''))}</option>`).join('')}</select></label></div>`;
}

function renderMatrix() {
  const summary = candidateSummary();
  const baseline = baselineSummary();
  const allRows = rows();
  const visible = state.viewAll ? filteredRows() : filteredRows().slice(0, 8);
  const regressionCount = allRows.filter((item) => item.change === 'regression').length;
  const improvementCount = allRows.filter((item) => item.change === 'improvement').length;
  const scoreDelta = summary.score - baseline.score;
  return `<div class="page-head matrix-head"><div><div class="eyebrow">Safety evaluation / overview</div><h1>Evaluation matrix</h1><p>Review how a response set performs across policy categories and expected behaviors.</p></div><div class="head-actions"><button class="button secondary" data-action="export-json">${icon('download')} Export scorecard</button><button class="button primary" data-action="nav" data-page="reviews">${icon('review')} Open review queue <span class="button-count">${state.data.records.filter((item) => item.runId === state.candidateId && item.annotation === null).length}</span></button></div></div>
    <section class="matrix-hero"><div><div class="hero-kicker">Candidate score · full run</div><div class="hero-score">${summary.score.toFixed(2)}<span>/ 100</span></div><div class="hero-delta ${scoreDelta >= 0 ? 'up' : 'down'}">${icon(scoreDelta >= 0 ? 'arrowUp' : 'arrowDown')} ${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(2)} pts <small>vs ${escapeHtml(run(state.baselineId).version)}</small></div></div><div class="hero-meta"><div><span>Evaluated run</span><strong>${escapeHtml(run(state.candidateId).version)}</strong><small>${escapeHtml(run(state.candidateId).createdAt.slice(0, 10))} · ${escapeHtml(run(state.candidateId).source)}</small></div><div><span>Weighted credit</span><strong>${summary.weightedEarned} / ${summary.weightedTotal} weight earned</strong><small>${summary.weightedPassed} pass + ${summary.weightedAbstentions} abstention</small></div><div><span>Review coverage</span><strong>${percent(summary.coverage)}</strong><small>${summary.reviewed} of ${summary.total} responses reviewed</small></div></div></section>
    <div class="section-bar"><div><h2>Run comparison</h2><span class="subtle">${escapeHtml(run(state.baselineId).version)} baseline against ${escapeHtml(run(state.candidateId).version)} candidate</span></div>${renderVersionControls()}</div>
    <section class="metric-grid">${metricCard('Weighted score', summary.score.toFixed(2), `${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(2)} pts from baseline`, 'orange', scoreDelta >= 0 ? `<em class="delta-up">${icon('arrowUp')}</em>` : `<em class="delta-down">${icon('arrowDown')}</em>`)}${metricCard('Ordinary outcomes', `${summary.passed} pass · ${summary.failed} fail`, `${summary.total - summary.abstentions - summary.missing} non-abstaining responses`, 'green')}${metricCard('Abstention outcomes', `${summary.acceptedAbstentions} accepted · ${summary.rejectedAbstentions} rejected`, `${summary.abstentions} explicit abstentions`, 'blue')}${metricCard('Regressions', regressionCount, `${improvementCount} improvements · ${allRows.filter((item) => item.accountingChanged).length} accounting changes`, 'red')}</section>
    ${renderOutcomeSummary(summary)}
    ${renderContributionSummary(summary, baseline)}
    <section class="category-section"><div class="section-title-row"><div><h2>Performance by category</h2><span class="subtle">Severity-weighted candidate credit, including accepted abstentions</span></div><button class="text-button" data-action="nav" data-page="prompts">Browse prompt library ${icon('arrow')}</button></div><div class="category-grid">${state.data.categories.map((cat) => { const categoryRows = allRows.filter((item) => item.prompt.categoryId === cat.id); const credited = categoryRows.filter((item) => item.candidate.credited).length; const categoryScore = categoryRows.reduce((sum, item) => sum + item.candidate.earnedWeight, 0) / categoryRows.reduce((sum, item) => sum + item.candidate.weight, 0) * 100; return `<div class="category-row"><div class="category-name"><i style="--dot:${cat.color}"></i><strong>${escapeHtml(cat.name)}</strong><span>${credited}/${categoryRows.length} credit</span></div><div class="bar-track"><i style="width:${categoryScore}% ;--bar:${cat.color}"></i></div><strong class="category-score">${categoryScore.toFixed(0)}%</strong></div>`; }).join('')}</div></section>
    <section class="cases-section" id="evaluation-cases"><div class="section-title-row"><div><h2>Evaluation cases</h2><span class="subtle" role="status">${filteredRows().length} of ${allRows.length} cases match · ${visible.length} displayed</span></div><button class="text-button" data-action="clear-filters">Clear filters ${icon('x')}</button></div>${renderFilters()}<p class="filter-scope">Filters apply to the case list only. Scores, category results, and exports always cover the full selected runs. Open any case to inspect its score and evidence.</p><div class="table-card"><div class="table-wrap"><table><thead><tr><th>Case</th><th>Category</th><th>Severity</th><th>Candidate result</th><th>Baseline</th><th>Change</th><th>Evidence</th></tr></thead><tbody>${visible.length ? visible.map(renderCaseRow).join('') : `<tr><td colspan="7"><div class="empty-state">${icon('search')}<strong>No cases match these filters</strong><span>Try clearing a filter or searching for another prompt.</span><button class="text-button" data-action="clear-filters">Clear all filters</button></div></td></tr>`}</tbody></table></div>${filteredRows().length > 8 ? `<button class="table-footer" data-action="toggle-all">${state.viewAll ? 'Show fewer cases' : `View all ${filteredRows().length} cases`} ${icon(state.viewAll ? 'arrowUp' : 'arrowDown')}</button>` : ''}</div></section>`;
}

function renderCaseRow(row) {
  const changeLabel = row.change === 'regression' ? `<span class="change regression">${icon('arrowDown')} Regression</span>` : row.change === 'improvement' ? `<span class="change improvement">${icon('arrowUp')} Improved</span>` : row.change === 'incomparable' ? '<span class="change incomparable">Incomparable</span>' : '<span class="change neutral">—</span>';
  return `<tr data-action="inspect" data-id="${row.prompt.id}"><td><div class="case-cell"><strong>${escapeHtml(row.prompt.title)}</strong><span>${escapeHtml(row.prompt.id)} · ${escapeHtml(row.prompt.expected.mode)} expected</span></div></td><td>${categoryPill(row.prompt)}</td><td>${severityPill(row.prompt.severity)}</td><td>${resultBadge(row.candidate)}</td><td>${resultBadge(row.baseline)}</td><td><div class="change-cell">${changeLabel}<small class="transition ${row.accountingChanged ? 'changed' : ''}">${escapeHtml(row.transition)}${row.accountingChanged ? ` · ${icon('compare')} accounting` : ''}</small></div></td><td><button class="text-button" data-action="inspect" data-id="${row.prompt.id}" aria-label="Explain score for ${escapeHtml(row.prompt.title)}">Inspect ${icon('chevron')}</button></td></tr>`;
}

function renderOutcomeSummary(summary) {
  const buckets = [
    ['passes', 'Ordinary passes', summary.ordinaryPasses, 'green'],
    ['failures', 'Ordinary failures', summary.ordinaryFailures, 'red'],
    ['accepted-abstentions', 'Accepted abstentions', summary.acceptedAbstentions, 'blue'],
    ['rejected-abstentions', 'Rejected abstentions', summary.rejectedAbstentions, 'amber'],
    ['missing', 'Missing outputs', summary.missing, 'gray'],
  ];
  return `<section class="outcome-summary" aria-label="Candidate outcome breakdown"><div class="section-title-row"><div><h2>Response outcomes</h2><span class="subtle">Full candidate run · disjoint accounting partitions every response</span></div></div><div class="outcome-buckets">${buckets.map(([value, label, count, tone]) => `<button class="outcome-bucket ${tone}" data-action="filter-outcome" data-value="${value}" aria-pressed="${state.outcome === value}"><strong>${count}</strong><span>${label}</span></button>`).join('')}</div><div class="accounting-equation"><span>ordinary pass + ordinary failure + abstention + missing</span><strong>${summary.passed} + ${summary.failed} + ${summary.abstentions} + ${summary.missing} = ${summary.total}</strong></div><p class="filter-scope">Accepted abstentions earn credit but remain outside ordinary pass totals. Rejected abstentions earn zero but remain outside ordinary failure totals. A response that should abstain but answers instead is an ordinary failure. Refusals are not abstentions.</p></section>`;
}

function renderContributionSummary(summary, baseline) {
  const contribution = (label, item, tone) => `<div class="contribution-card ${tone}"><div><span>${label}</span><strong>${item.earnedWeight} / ${item.totalWeight}</strong></div><small>earned / available source weight</small><small>${item.points.toFixed(4)} pts · 100 × ${item.earnedWeight} / ${summary.weightedTotal} full-run weight</small><i style="width:${summary.weightedTotal ? (item.earnedWeight / summary.weightedTotal) * 100 : 0}%"></i></div>`;
  const metrics = [
    ['Ordinary passes', 'passed'], ['Ordinary failures', 'failed'],
    ['Accepted abstentions', 'acceptedAbstentions'], ['Rejected abstentions', 'rejectedAbstentions'],
    ['Ordinary pass earned weight', 'weightedPassed'], ['Abstention earned weight', 'weightedAbstentions'],
  ];
  return `<section class="contribution-summary"><div class="section-title-row"><div><h2>Weighted credit sources</h2><span class="subtle">Score contributions are explicit; the denominator stays the full selected run</span></div><span class="contribution-total">${summary.weightedEarned} / ${summary.weightedTotal} earned · ${summary.score.toFixed(2)} / 100</span></div><div class="contribution-grid">${contribution('Ordinary pass credit', summary.contributions.pass, 'pass-source')}${contribution('Accepted abstention credit', summary.contributions.abstention, 'abstention-source')}<div class="contribution-total-card"><span>Combined earned credit</span><strong>${summary.weightedEarned}</strong><small>${summary.contributions.pass.earnedWeight} pass + ${summary.contributions.abstention.earnedWeight} abstention</small></div></div><div class="accounting-comparison" role="region" aria-label="Disjoint version comparison"><div class="table-wrap"><table class="accounting-table"><thead><tr><th>Accounting measure</th><th>Baseline ${escapeHtml(run(state.baselineId).version)}</th><th>Candidate ${escapeHtml(run(state.candidateId).version)}</th><th>Delta</th></tr></thead><tbody>${metrics.map(([label, key]) => `<tr data-measure="${key}"><td>${label}</td><td>${baseline[key]}</td><td>${summary[key]}</td><td>${formatDelta(summary[key] - baseline[key])}</td></tr>`).join('')}</tbody></table></div></div><p class="filter-scope">Both sources use the full-run denominator. Counts are disjoint; only combined credit and the overall score add the two sources. Displayed contribution points are rounded after independent full-precision aggregation.</p></section>`;
}

function renderFilters() {
  const active = state.search || state.category !== 'all' || state.severity !== 'all' || state.outcome !== 'all';
  const options = [
    ['all', 'All outcomes'], ['failures', 'Ordinary failures'], ['passes', 'Ordinary passes'],
    ['abstentions', 'All abstentions'], ['accepted-abstentions', 'Accepted abstentions'],
    ['rejected-abstentions', 'Rejected abstentions'], ['nonpassing', 'All no-credit responses'],
    ['credited', 'All credited responses'], ['regressions', 'Regressions'],
    ['improvements', 'Improvements'], ['review', 'Needs review'], ['missing', 'Missing outputs'],
  ];
  const scopedRows = filterRows(rows(), { query: state.search, category: state.category, outcome: state.outcome });
  return `<fieldset class="severity-filters"><legend>Severity <span>per-case weights · counts reflect other active filters</span></legend><div class="severity-options">${['all', ...Object.keys(SEVERITY_WEIGHTS)].map((value) => {
    const count = value === 'all' ? scopedRows.length : scopedRows.filter((row) => row.prompt.severity === value).length;
    return `<button class="severity-option ${value}" data-action="filter-severity" data-value="${value}" aria-pressed="${state.severity === value}">${value === 'all' ? 'All severities' : value[0].toUpperCase() + value.slice(1)}${value !== 'all' ? `<small>weight ${SEVERITY_WEIGHTS[value]}</small>` : ''}<b>${count}</b></button>`;
  }).join('')}</div></fieldset><div class="filters"><div class="search-field">${icon('search')}<input data-field="search" value="${escapeHtml(state.search)}" placeholder="Search cases..." aria-label="Search cases" />${state.search ? `<button data-action="clear-search" aria-label="Clear search">${icon('x')}</button>` : ''}</div><label class="select-filter"><span>Category</span><select data-field="category"><option value="all">All categories</option>${state.data.categories.map((item) => `<option value="${item.id}" ${state.category === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select>${icon('down')}</label><label class="select-filter outcome-select"><span>Outcome</span><select data-field="outcome">${options.map(([value, label]) => `<option value="${value}" ${state.outcome === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${icon('down')}</label>${active ? `<span class="filter-active">${state.severity !== 'all' ? `${escapeHtml(state.severity)} severity · ` : ''}Filters active</span>` : ''}</div>`;
}

function renderPrompts() {
  const query = state.search.toLowerCase();
  const prompts = state.data.prompts.filter((prompt) => !query || `${prompt.id} ${prompt.title} ${prompt.text} ${prompt.tags.join(' ')}`.toLowerCase().includes(query));
  return `<div class="page-head"><div><div class="eyebrow">Source set / authored fixtures</div><h1>Prompt library</h1><p>Every case is synthetic, versioned, and stored with its expected response properties.</p></div><div class="head-actions"><button class="button secondary" data-action="validate">${icon('check')} Validate dataset</button><button class="button primary" data-action="export-json">${icon('download')} Export dataset</button></div></div><div class="library-banner"><span class="banner-icon">${icon('spark')}</span><div><strong>Reproducible by design</strong><p>Prompts include a template and seed so this local matrix can be rebuilt without a live model.</p></div><span class="banner-tag">${state.data.prompts.length} synthetic cases</span></div><div class="library-toolbar"><div class="search-field">${icon('search')}<input data-field="search" value="${escapeHtml(state.search)}" placeholder="Search prompt title, text, or tag..." aria-label="Search prompt library" /></div><span class="subtle">${prompts.length} prompts</span></div><div class="prompt-library">${prompts.map((prompt) => `<article class="prompt-card" data-action="inspect" data-id="${prompt.id}" tabindex="0"><div class="prompt-card-head"><span class="case-id">${escapeHtml(prompt.id)}</span>${severityPill(prompt.severity)}</div><h3>${escapeHtml(prompt.title)}</h3><p>${escapeHtml(prompt.text)}</p><div class="prompt-card-foot">${categoryPill(prompt)}<span class="expected-chip">Expected: ${escapeHtml(prompt.expected.mode)}</span><span class="provenance">seed ${escapeHtml(prompt.provenance.seed)}</span></div></article>`).join('')}</div>`;
}

function renderRuns() {
  const summaries = state.data.runs.map((item) => ({ run: item, summary: summarize(state.data, item.id) }));
  return `<div class="page-head"><div><div class="eyebrow">Snapshots / fixed local responses</div><h1>Model runs</h1><p>Compare immutable response sets. These records are authored local fixtures, not live provider results.</p></div><div class="head-actions"><button class="button secondary" data-action="about">${icon('info')} How this works</button><button class="button primary" data-action="export-json">${icon('download')} Export scorecard</button></div></div>
    <div class="run-notice">${icon('lock')} <span><strong>Local-only source</strong> Each run is bundled in this workspace. No API keys, network requests, or external model calls are used.</span></div>
    <div class="run-list">${summaries.map(({ run: item, summary }) => `<article class="run-card ${item.id === state.candidateId ? 'selected' : ''}">
      <div class="run-card-main"><div class="run-icon">${icon('history')}</div><div><div class="run-name"><h2>${escapeHtml(item.name.replace('Local fixture ', 'Fixture '))}</h2>${item.id === state.candidateId ? '<span class="current-tag">Current candidate</span>' : ''}</div><p>${escapeHtml(item.description)}</p><div class="run-meta"><span>${escapeHtml(item.version)}</span><span>${escapeHtml(item.createdAt.slice(0, 10))}</span><span>${summary.total} cases</span><span>${escapeHtml(item.source)}</span></div></div></div>
      <div class="run-stats"><div><small>Score</small><strong>${summary.score.toFixed(2)}</strong></div><div><small>Ordinary</small><strong>${summary.passed} pass / ${summary.failed} fail</strong></div><div><small>Abstentions</small><strong>${summary.acceptedAbstentions} accepted / ${summary.rejectedAbstentions} rejected</strong></div><div><small>Weighted sources</small><strong>${summary.weightedPassed} + ${summary.weightedAbstentions}</strong></div><button class="button small secondary" data-action="select-run" data-id="${item.id}">${item.id === state.candidateId ? 'Selected' : 'Use as candidate'}</button></div>
    </article>`).join('')}</div>`;
}

function renderReviews() {
  const queue = rows().filter((row) => !row.candidate.record?.annotation).sort((a, b) => b.candidate.weight - a.candidate.weight);
  const selected = queue.find((row) => row.prompt.id === state.selectedId) ?? queue[0];
  return `<div class="page-head"><div><div class="eyebrow">Human check / candidate ${escapeHtml(run(state.candidateId).version)}</div><h1>Review queue <span class="title-count">${queue.length}</span></h1><p>Reviewers can add local notes and evidence context without changing automated results.</p></div><div class="head-actions"><button class="button secondary" data-action="nav" data-page="matrix">${icon('matrix')} Back to matrix</button></div></div>${queue.length ? `<div class="review-layout"><div class="review-list">${queue.map((row) => `<button class="review-list-item ${selected?.prompt.id === row.prompt.id ? 'active' : ''}" data-action="select-review" data-id="${row.prompt.id}"><span class="review-severity ${row.prompt.severity}"></span><span><strong>${escapeHtml(row.prompt.title)}</strong><small>${escapeHtml(row.prompt.id)} · ${escapeHtml(category(row.prompt.categoryId).name)}</small></span><span class="review-list-result">${resultBadge(row.candidate)}</span>${icon('chevron')}</button>`).join('')}</div>${selected ? renderReviewPanel(selected) : ''}</div>` : `<div class="empty-panel">${icon('checkCircle')}<h2>Review queue is clear</h2><p>All candidate responses have a reviewer annotation.</p><button class="button primary" data-action="nav" data-page="matrix">Back to matrix</button></div>`}`;
}

function renderReviewPanel(row) {
  const record = row.candidate.record;
  const prompt = row.prompt;
  return `<section class="review-panel">
    <div class="review-panel-head"><div><span class="case-id">${escapeHtml(prompt.id)}</span><h2>${escapeHtml(prompt.title)}</h2></div>${resultBadge(row.candidate)}</div>
    <div class="review-block"><span class="review-label">Prompt</span><blockquote>${escapeHtml(prompt.text)}</blockquote><div class="prompt-meta">${categoryPill(prompt)} ${severityPill(prompt.severity)} <span class="expected-chip">Expected ${escapeHtml(prompt.expected.mode)}</span></div></div>
    <div class="review-block response-block"><div class="review-label-row"><span class="review-label">Candidate response</span><span class="mode-value">Observed mode: <strong>${escapeHtml(record?.mode ?? 'missing')}</strong></span></div><div class="response-quote">${record?.response ? escapeHtml(record.response) : '<em>No response recorded</em>'}</div></div>
    <button class="text-button" data-action="inspect" data-id="${prompt.id}">Explain score &amp; inspect evidence ${icon('chevron')}</button>
    ${renderScoreExplanation(explainRecord(state.data, prompt, record, state.candidateId))}
    ${record ? `<form class="review-form" data-review-id="${record.id}"><label><span>Your name</span><input name="reviewer" placeholder="Local reviewer" required /></label><label><span>Reviewer note</span><textarea name="note" placeholder="What did you verify in the response evidence?"></textarea></label><button class="button primary" type="submit">${icon('check')} Save review annotation</button><span class="form-hint">Saved only in this browser.</span></form>` : '<p class="subtle">Missing records cannot be annotated.</p>'}
  </section>`;
}

function renderScorecard() {
  const report = scorecard();
  const baseline = report.summaries.baseline;
  const candidate = report.summaries.candidate;
  const changes = report.comparisons.reduce((acc, row) => { acc[row.change] = (acc[row.change] || 0) + 1; return acc; }, {});
  return `<div class="page-head"><div><div class="eyebrow">Reproducible report / schema v${report.schemaVersion}</div><h1>Scorecard export</h1><p>Download complete selected runs, including all case explanations. Case-list filters never trim an export.</p></div><div class="head-actions"><button class="button secondary" data-action="export-csv">${icon('download')} CSV cases</button><button class="button primary" data-action="export-json">${icon('download')} Download JSON</button></div></div>
    <div class="scorecard-summary"><div class="scorecard-big"><span>Candidate score</span><strong>${candidate.score.toFixed(2)}<small>/100</small></strong><em class="${candidate.score >= baseline.score ? 'up' : 'down'}">${candidate.score >= baseline.score ? '+' : ''}${(candidate.score - baseline.score).toFixed(2)} pts vs baseline</em></div><div class="scorecard-facts"><div><span>Baseline</span><strong>${escapeHtml(run(report.baselineId).version)}</strong><small>${baseline.passed} pass · ${baseline.failed} fail · ${baseline.abstentions} abstentions</small></div><div><span>Candidate</span><strong>${escapeHtml(run(report.candidateId).version)}</strong><small>${candidate.passed} pass · ${candidate.failed} fail · ${candidate.abstentions} abstentions</small></div><div><span>Comparison</span><strong>${report.comparisonSummary.accountingChanges} accounting changes</strong><small>${changes.regression || 0} regressions · ${changes.improvement || 0} improvements</small></div></div></div>
    ${renderOutcomeSummary(candidate)}
    ${renderContributionSummary(candidate, baseline)}
    <section class="comparison-summary"><div class="section-title-row"><div><h2>Version comparison accounting</h2><span class="subtle">Disjoint totals and weight deltas · ${escapeHtml(run(report.baselineId).version)} → ${escapeHtml(run(report.candidateId).version)}</span></div></div><div class="comparison-summary-grid"><div><span>Ordinary pass</span><strong>${baseline.passed} → ${candidate.passed}</strong><small>${formatDelta(report.comparisonSummary.deltas.passed)} cases · ${formatDelta(report.comparisonSummary.deltas.weightedPassed)} weight</small></div><div><span>Ordinary failure</span><strong>${baseline.failed} → ${candidate.failed}</strong><small>${formatDelta(report.comparisonSummary.deltas.failed)} cases</small></div><div><span>Accepted abstention</span><strong>${baseline.acceptedAbstentions} → ${candidate.acceptedAbstentions}</strong><small>${formatDelta(report.comparisonSummary.deltas.acceptedAbstentions)} cases · ${formatDelta(report.comparisonSummary.deltas.weightedAbstentions)} abstention weight</small></div><div><span>Rejected abstention</span><strong>${baseline.rejectedAbstentions} → ${candidate.rejectedAbstentions}</strong><small>${formatDelta(report.comparisonSummary.deltas.rejectedAbstentions)} cases</small></div><div><span>Combined score credit</span><strong>${baseline.weightedEarned} → ${candidate.weightedEarned}</strong><small>${formatDelta(report.comparisonSummary.deltas.weightedEarned)} weight · ${formatDelta(report.comparisonSummary.deltas.score)} points</small></div><div><span>Response transitions</span><strong>${report.comparisonSummary.accountingChanges}</strong><small>cases changed accounting source/status</small></div></div></section>
    <div class="export-checklist"><div>${icon('checkCircle')} <span><strong>Complete snapshot</strong><small>All ${state.data.prompts.length} prompts, ${state.data.runs.length} runs, ${state.data.records.length} records, and baseline/candidate explanations included.</small></span></div><div>${icon('checkCircle')} <span><strong>Deterministic scoring</strong><small>Severity weights, abstention partitions, and exact evidence are embedded in the export.</small></span></div><div>${icon('lock')} <span><strong>Offline safe</strong><small>Only authored fixtures and your local reviewer annotations are exported.</small></span></div></div>
    <div class="formula-card"><div><span class="review-label">Scoring formula</span><code>${escapeHtml(report.scoring.formula)}</code></div><div><span class="review-label">Case contribution formula</span><code>${escapeHtml(report.scoring.contributionFormula)}</code></div><div><span class="review-label">Coverage formula</span><code>${escapeHtml(report.scoring.coverageFormula)}</code></div><div><span class="review-label">Accounting version</span><code>${escapeHtml(report.scoring.accountingVersion)} · abstentions are disjoint from pass/fail</code></div><div><span class="review-label">Severity weights</span><code>${Object.entries(report.scoring.severityWeights).map(([key, value]) => `${key}=${value}`).join(' · ')}</code></div></div>`;
}

function formatDelta(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

function renderAbout() {
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="about-title" data-stop-row><button class="modal-close" data-action="close-modal" aria-label="Close">${icon('x')}</button><span class="modal-icon">${icon('shield')}</span><h2 id="about-title">About this workspace</h2><p>Guardrail is a local AI safety evaluation matrix inspired by model-evaluation hackathons. It bundles synthetic prompts, response properties, fixed local runs, evidence, and reviewer annotations into one reproducible report.</p><div class="about-list"><div>${icon('offline')}<span><strong>No live model calls</strong><small>All responses are authored fixtures for safely exploring evaluation workflows.</small></span></div><div>${icon('lock')}<span><strong>Private by default</strong><small>Reviewer notes stay in local browser storage until you export them.</small></span></div><div>${icon('code')}<span><strong>Open data shape</strong><small>JSON exports include schema version, run snapshots, scoring, and case-level comparisons.</small></span></div></div><button class="button primary full" data-action="close-modal">Got it</button></section></div>`;
}

function render() {
  const content = state.page === 'matrix' ? renderMatrix() : state.page === 'prompts' ? renderPrompts() : state.page === 'runs' ? renderRuns() : state.page === 'reviews' ? renderReviews() : renderScorecard();
  renderLayout(content);
}

function inspect(id) {
  const row = rows().find((item) => item.prompt.id === id);
  if (!row) return;
  if (state.evidenceId !== id) { state.evidenceRun = 'candidate'; }
  state.evidenceId = id;
  const selected = state.evidenceRun;
  const evaluation = row[selected];
  const record = evaluation.record;
  const runId = selected === 'candidate' ? state.candidateId : state.baselineId;
  const explanation = explainRecord(state.data, row.prompt, record, runId);
  const summary = summarize(state.data, runId);
  if (!modalRoot.firstElementChild) modalReturnFocus = document.activeElement;
  app.inert = true;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="case-title" data-stop-row>
    <button class="modal-close" data-action="close-modal" aria-label="Close evidence detail">${icon('x')}</button>
    <div class="modal-kicker">Score &amp; evidence detail · ${escapeHtml(row.prompt.id)}</div>
    <div class="modal-title-row"><div><h2 id="case-title">${escapeHtml(row.prompt.title)}</h2><div>${severityPill(row.prompt.severity)} ${categoryPill(row.prompt)} <span class="change ${row.change}">${escapeHtml(row.change)}</span></div></div></div>
    <span class="review-label">Synthetic prompt</span><blockquote>${escapeHtml(row.prompt.text)}</blockquote>
    <div class="evidence-tabs" role="group" aria-label="Evidence run">${['baseline', 'candidate'].map((key) => `<button data-action="evidence-run" data-value="${key}" aria-pressed="${selected === key}">${key === 'candidate' ? 'Candidate' : 'Baseline'} ${escapeHtml(run(key === 'candidate' ? state.candidateId : state.baselineId).version)} ${resultBadge(row[key])}</button>`).join('')}</div>
    <div class="detail-run-score">Full ${selected} score: <strong>${summary.score.toFixed(2)} / 100</strong> (${summary.weightedEarned} / ${summary.weightedTotal} weight earned = ${summary.contributions.pass.earnedWeight} pass + ${summary.contributions.abstention.earnedWeight} abstention)</div>
    <div class="inspect-response"><span class="review-label">${selected} response · ${escapeHtml(explanation.observedMode)}</span><p>${escapeHtml(record?.response || 'No response recorded.')}</p></div>
    ${renderScoreExplanation(explanation)}
    <section class="reviewer-detail" aria-label="Reviewer annotation"><h3>Reviewer annotation</h3>${record?.annotation ? `<p><strong>${escapeHtml(record.annotation.reviewer)}</strong> · ${escapeHtml(record.annotation.reviewedAt)}</p><blockquote>${escapeHtml(record.annotation.note || 'No note supplied.')}</blockquote>` : '<p>Awaiting human review. Stored judgments still determine the fixture score.</p>'}</section>
    <p class="provenance-detail">Fixed local record: ${escapeHtml(record?.id || 'missing')}<br>Prompt template: ${escapeHtml(row.prompt.provenance.template)} · seed ${escapeHtml(row.prompt.provenance.seed)}</p>
    <div class="inspect-footer"><span>No live model calls · scoring v1.0.0</span><button class="text-button" data-action="close-modal">Close ${icon('x')}</button></div>
  </section></div>`;
  (selected === 'candidate' ? $('.modal-close') : $('.evidence-tabs [aria-pressed="true"]')).focus();
}

function closeModal() {
  modalRoot.innerHTML = '';
  app.inert = false;
  state.evidenceId = null;
  modalReturnFocus?.focus();
}

function handleAction(element) {
  const action = element.dataset.action;
  if (action === 'nav') { state.page = element.dataset.page; state.mobileNav = false; state.selectedId = null; render(); }
  if (action === 'toggle-nav') { state.mobileNav = !state.mobileNav; render(); }
  if (action === 'about') { modalReturnFocus = document.activeElement; renderAbout(); app.inert = true; $('.modal-close').focus(); }
  if (action === 'close-modal') closeModal();
  if (action === 'filter-severity') { state.severity = element.dataset.value; render(); $(`.severity-option[data-value="${state.severity}"]`).focus(); }
  if (action === 'filter-outcome') { state.outcome = element.dataset.value; state.page = 'matrix'; render(); $('#evaluation-cases').scrollIntoView({ block: 'start' }); $('[data-field="outcome"]').focus({ preventScroll: true }); }
  if (action === 'clear-filters') { state.search = ''; state.category = 'all'; state.severity = 'all'; state.outcome = 'all'; render(); }
  if (action === 'clear-search') { state.search = ''; render(); }
  if (action === 'toggle-all') { state.viewAll = !state.viewAll; render(); }
  if (action === 'inspect') inspect(element.dataset.id);
  if (action === 'evidence-run') { state.evidenceRun = element.dataset.value; inspect(state.evidenceId); $('.evidence-tabs [aria-pressed="true"]').focus(); }
  if (action === 'select-review') { state.selectedId = element.dataset.id; render(); }
  if (action === 'select-run') { state.candidateId = element.dataset.id; render(); showToast(`${run(state.candidateId).version} is now the candidate run.`); }
  if (action === 'validate') { const errors = validateDataset(state.data); showToast(errors.length ? `${errors.length} validation issue${errors.length === 1 ? '' : 's'} found.` : 'Dataset is valid — no duplicate prompts or broken references.', errors.length ? 'warning' : 'success'); }
  if (action === 'export-json') { download(`guardrail-scorecard-${run(state.candidateId).version}.json`, JSON.stringify(scorecard(), null, 2), 'application/json'); showToast('Reproducible JSON scorecard downloaded.'); }
  if (action === 'export-csv') { download(`guardrail-cases-${run(state.candidateId).version}.csv`, scorecardCsv(scorecard()), 'text/csv'); showToast('Case CSV downloaded.'); }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  const boundary = event.target.closest('[data-stop-row]');
  if (boundary && (!target || !boundary.contains(target))) return;
  if (!target) return;
  handleAction(target, event);
});
document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-action], article[data-action]')) { event.preventDefault(); event.target.click(); }
  if (event.key === 'Escape' && modalRoot.firstElementChild) closeModal();
  if (event.key === 'Tab' && modalRoot.firstElementChild) {
    const focusable = [...modalRoot.querySelectorAll('button, input, select, textarea, [tabindex="0"]')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
document.addEventListener('change', (event) => {
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'baseline') state.baselineId = event.target.value;
  if (field === 'candidate') state.candidateId = event.target.value;
  if (field === 'category') state.category = event.target.value;
  if (field === 'outcome') state.outcome = event.target.value;
  render();
});
document.addEventListener('input', (event) => {
  if (event.target.dataset.field !== 'search') return;
  state.search = event.target.value;
  render();
  const input = $('[data-field="search"]');
  if (input) { input.focus(); input.setSelectionRange(state.search.length, state.search.length); }
});
document.addEventListener('submit', (event) => {
  if (!event.target.matches('.review-form')) return;
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const result = saveReview(state.data, event.target.dataset.reviewId, { reviewer: form.get('reviewer'), note: form.get('note') }, localStorage, new Date().toISOString());
    render();
    showToast(result.persisted ? 'Review annotation saved locally.' : 'Review saved for this session; browser storage was unavailable.', result.persisted ? 'success' : 'warning');
  } catch (error) { showToast(error.message, 'warning'); }
});

render();
