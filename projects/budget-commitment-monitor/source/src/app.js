import { policies, requests, SNAPSHOT_DATE } from './data.js';
import { analyzeRequests, formatMoney } from './finance.js';
import { createView, toggleFilter } from './view.js';
import { createDrawerModel } from './drawer.js';

const analyzedRequests = analyzeRequests(requests, SNAPSHOT_DATE);
const state = { filters: [], query: '', sortAscending: true, selectedId: null };
const elements = {};
let returnFocus = null;
const mobileLayout = window.matchMedia('(max-width: 1000px)');

function setMobileNavigation(open) {
  document.body.classList.toggle('mobile-nav-open', open);
  $('.mobile-menu-button').setAttribute('aria-expanded', String(open));
  $('.sidebar').inert = mobileLayout.matches && !open;
}

const money = (cents, compact = false) => formatMoney(cents, { compact });

function $(selector) {
  return document.querySelector(selector);
}

function dateLabel(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Date unavailable';
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(date);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function statusLabel(status) {
  return { approved: 'Approved', pending: 'Pending', in_progress: 'In progress', cancelled: 'Cancelled' }[status] ?? status;
}

function statusClass(status) {
  return status.replace('_', '-');
}

function flagMarkup(request) {
  const labels = { untracked: 'Untracked', overdue: 'Overdue', policy: 'Policy' };
  return request.flags.length
    ? `<div class="row-flags">${request.flags.map((flag) => `<span class="flag flag-${flag.type}"><i></i>${labels[flag.type]}${flag.type === 'policy' ? ` · ${escapeHtml(flag.policyCode)}` : ''}</span>`).join('')}</div>`
    : '<span class="no-flag">No flags</span>';
}

function renderSummary(summary, counts) {
  const projectedPercent = Math.round((summary.projectedCents / summary.budgetCents) * 100);
  const spentPercent = (summary.spentCents / summary.budgetCents) * 100;
  const committedPercent = (summary.committedCents / summary.budgetCents) * 100;

  $('#projected-spend').textContent = money(summary.projectedCents, true);
  $('#projected-exact').textContent = money(summary.projectedCents);
  $('#untracked-spend').textContent = money(summary.untrackedCents, true);
  $('#untracked-exact').textContent = money(summary.untrackedCents);
  $('#untracked-count').textContent = `${summary.untrackedCount} ${summary.untrackedCount === 1 ? 'record' : 'records'}`;
  $('#overdue-count').textContent = summary.overdueCount;
  $('#policy-count').textContent = summary.policyCount;
  $('#remaining-spend').textContent = money(summary.remainingCents, true);
  $('#remaining-exact').textContent = money(summary.remainingCents);
  $('#spent-label').textContent = money(summary.spentCents);
  $('#committed-label').textContent = money(summary.committedCents);
  $('#available-label').textContent = money(summary.remainingCents);
  $('#active-count').textContent = summary.activeCount;
  $('#attention-count').textContent = counts.attention;
  $('#budget-label').textContent = `of ${money(summary.budgetCents, true)} budget`;
  $('#header-date').textContent = dateLabel(SNAPSHOT_DATE);
  $('#sidebar-date').textContent = dateLabel(SNAPSHOT_DATE);
  $('.kpi-featured .trend-up').textContent = `${projectedPercent}%`;
  $('.progress-track').setAttribute('aria-valuenow', projectedPercent);
  $('.progress-track').setAttribute('aria-valuetext', `${money(summary.projectedCents)} projected, ${projectedPercent}% of ${money(summary.budgetCents)} budget in current view`);
  $('#progress-spent').style.width = `${spentPercent}%`;
  $('#progress-committed').style.left = `${spentPercent}%`;
  $('#progress-committed').style.width = `${committedPercent}%`;
}

function renderFilters(counts) {
  document.querySelectorAll('.filter-tab').forEach((button) => {
    button.querySelector('span').textContent = counts[button.dataset.filter];
    const selected = button.dataset.filter === 'all' ? state.filters.length === 0 : state.filters.includes(button.dataset.filter);
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function renderRows(visible) {
  elements.recordsBody.innerHTML = visible.map((request) => `
    <tr data-row-id="${escapeHtml(request.id)}">
      <td class="record-cell"><button class="record-button" type="button" data-record-id="${escapeHtml(request.id)}" aria-label="Open details for ${escapeHtml(request.title)}">
        <span class="record-avatar avatar-${request.category.length % 5}">${escapeHtml(request.title.slice(0, 1))}</span>
        <span class="record-copy"><strong>${escapeHtml(request.title)}</strong><span>${escapeHtml(request.id)}${request.isDuplicate ? ' · linked duplicate' : ''}</span></span>
      </button></td>
      <td data-label="Department"><span class="department-cell">${escapeHtml(request.department)}</span></td>
      <td data-label="Vendor"><span class="vendor-cell">${escapeHtml(request.vendor?.name ?? 'Unknown vendor')}</span></td>
      <td data-label="Amount"><strong class="amount-cell">${money(request.amountCents, true)}</strong></td>
      <td data-label="Status"><div class="status-cell"><span class="status-badge status-${statusClass(request.status)}"><i></i>${statusLabel(request.status)}</span>${flagMarkup(request)}</div></td>
      <td class="action-cell"><button class="row-open" type="button" data-record-id="${escapeHtml(request.id)}" aria-label="View ${escapeHtml(request.title)} details"><span aria-hidden="true">→</span></button></td>
    </tr>`).join('');
  elements.emptyState.hidden = visible.length > 0;
  elements.recordCount.textContent = visible.length;
  elements.tableContext.textContent = `${visible.length} ${visible.length === 1 ? 'record' : 'records'} in current view`;
}

function renderView() {
  const view = createView(analyzedRequests, state);
  renderSummary(view.summary, view.counts);
  renderFilters(view.counts);
  renderRows(view.rows);
}

function renderPolicyRules() {
  $('#policy-rules').innerHTML = policies.map((policy) => `
    <article class="policy-rule-card">
      <span class="policy-rule-code">${escapeHtml(policy.code)}</span>
      <h3>${escapeHtml(policy.name)}</h3>
      <p class="policy-rule-threshold">${escapeHtml(policy.thresholdLabel)}</p>
      <p>${escapeHtml(policy.rule)}</p>
      <p class="policy-rule-provenance"><strong>Provenance:</strong> ${escapeHtml(policy.provenanceLabel)}</p>
    </article>`).join('');
}

function policyFlagDetails(exception) {
  return `
    <p><strong>Provenance:</strong> ${escapeHtml(exception.code ?? 'Code unavailable')} / ${escapeHtml(exception.name ?? 'Name unavailable')}</p>
    <p>${escapeHtml(exception.provenance ?? 'Provenance unavailable')}</p>
    <p><strong>Threshold / scope:</strong> ${escapeHtml(exception.threshold ?? 'Scope unavailable')}</p>
    <p><strong>Rule:</strong> ${escapeHtml(exception.rule ?? 'Rule unavailable')}</p>
    ${exception.evidence ? `<p><strong>Evidence:</strong> ${escapeHtml(exception.evidence)}</p>` : ''}`;
}

function detailFlagMarkup(request, model) {
  if (!model.flags.length) return `<div class="clear-state"><span>✓</span><div><strong>${request.status === 'cancelled' ? 'Cancelled request' : 'No attention flags'}</strong><p>${request.status === 'cancelled' ? 'Excluded from the projection and active review queue.' : 'No reconciliation or policy flags on this record.'}</p></div></div>`;
  const alerts = model.flags.filter((flag) => flag.type !== 'policy');
  return alerts.length ? `<div class="flags-panel"><p class="detail-label">Attention flags</p>${alerts.map((flag) => `<div class="detail-flag detail-flag-${escapeHtml(flag.type)}"><span class="detail-flag-icon">${flag.type === 'overdue' ? '◷' : '!'}</span><div><strong>${escapeHtml(flag.label)}</strong><p>${escapeHtml(flag.explanation)}</p></div></div>`).join('')}</div>` : '';
}

function drawerTimingLabel(row) {
  return { complete: 'Complete', upcoming: 'Upcoming', due_today: 'Due today', overdue: `Overdue · ${row.daysOverdue} ${row.daysOverdue === 1 ? 'day' : 'days'}`, cancelled: 'Cancelled' }[row.state];
}

function renderDrawer(request) {
  const model = createDrawerModel(request);
  $('#drawer-id').textContent = request.id;
  const approvals = model.approvals.stages.map((approval) => `<li data-state="${approval.state}"><span class="timeline-icon ${approval.state === 'complete' ? 'is-complete' : ''}">${approval.state === 'complete' ? '✓' : '·'}</span><span><strong>${escapeHtml(approval.role ? approval.role[0].toUpperCase() + approval.role.slice(1) : 'Approval stage')}</strong><small>${escapeHtml(approval.name ?? 'Reviewer unavailable')} · due ${dateLabel(approval.dueDate)}</small></span><em class="approval-${approval.state === 'complete' ? 'approved' : approval.state}">${approval.state === 'complete' ? 'Approved' : approval.state === 'upcoming' ? 'Pending' : drawerTimingLabel(approval)}</em></li>`).join('');
  const milestones = model.milestones.rows.map((milestone) => `<li data-state="${milestone.state}"><span class="milestone-dot ${milestone.state === 'complete' ? 'is-complete' : ''}"></span><span><strong>${escapeHtml(milestone.label ?? 'Milestone')}</strong><small>${dateLabel(milestone.date)}</small></span><em>${drawerTimingLabel(milestone)}</em></li>`).join('');
  const next = model.milestones.nextPending;
  const verificationLabel = { verified: 'Verified', pending: 'Not verified', unknown: 'Unknown' }[model.vendor.state];
  elements.drawerBody.innerHTML = `
    <div class="drawer-title-row"><div><h2 id="drawer-title">${escapeHtml(request.title)}</h2><p>${escapeHtml(request.department)} · ${escapeHtml(request.category)}</p></div><span class="status-badge status-${statusClass(request.status)}"><i></i>${statusLabel(request.status)}</span></div>
    ${detailFlagMarkup(request, model)}
    <div class="detail-amount"><span>Request amount</span><strong>${money(request.amountCents)}</strong><small>Due ${dateLabel(request.dueDate)} · owned by ${escapeHtml(request.owner)}</small></div>
    <section class="drawer-section vendor-verification" aria-labelledby="vendor-verification-heading"><div class="drawer-section-heading"><h3 id="vendor-verification-heading">Vendor verification</h3><span class="verification-state verification-${model.vendor.state}" data-state="${model.vendor.state}">${verificationLabel}</span></div><strong class="drawer-vendor-name">${escapeHtml(model.vendor.name)}</strong><p class="drawer-section-copy">${escapeHtml(model.vendor.category)}</p><p class="verification-explanation drawer-section-copy">${escapeHtml(model.vendor.explanation)}</p><p class="verification-source drawer-section-copy"><strong>Source:</strong> ${escapeHtml(model.vendor.source)}</p></section>
    <section class="drawer-section commitment-contribution" aria-labelledby="contribution-heading"><div class="drawer-section-heading"><h3 id="contribution-heading">Commitment contribution</h3><strong class="contribution-amount">${money(model.commitment.contributionCents)}</strong></div><p class="drawer-section-copy"><strong>Commitment ID:</strong> ${request.commitmentId ? escapeHtml(request.commitmentId) : 'Not assigned'}</p><p class="contribution-explanation drawer-section-copy">${escapeHtml(model.commitment.explanation)}</p></section>
    <section class="drawer-section approval-chain" aria-labelledby="approval-chain-heading"><div class="drawer-section-heading"><h3 id="approval-chain-heading">Approval-chain progress</h3><span class="approval-progress-count">${model.approvals.completed}/${model.approvals.total} complete</span></div><progress class="drawer-progress approval-progress" max="100" value="${model.approvals.percent}" aria-label="Approval-chain completion">${model.approvals.percent}%</progress><p class="drawer-section-copy">${model.approvals.allApproved ? 'All recorded stages approved.' : model.approvals.total ? request.status === 'cancelled' ? 'Completed history retained; unfinished stages cancelled.' : 'Approval chain is incomplete.' : 'No approval stages recorded.'} As of ${dateLabel(model.asOf)}.</p><ul class="detail-list">${approvals}</ul></section>
    <section class="drawer-section delivery-milestones" aria-labelledby="milestones-heading"><div class="drawer-section-heading"><h3 id="milestones-heading">Delivery milestones</h3><span class="milestone-progress-count">${model.milestones.completed}/${model.milestones.total} complete</span></div><progress class="drawer-progress milestone-progress" max="100" value="${model.milestones.percent}" aria-label="Delivery milestone completion">${model.milestones.percent}%</progress><p class="next-milestone drawer-section-copy"><strong>Next pending milestone:</strong> ${next ? `${escapeHtml(next.label ?? 'Milestone')} · ${dateLabel(next.date)} · ${drawerTimingLabel(next)}` : request.status === 'cancelled' ? 'None — request cancelled.' : 'No dated pending milestone recorded.'}</p>${model.milestones.total ? '' : '<p class="drawer-section-copy">No milestones recorded.</p>'}<ul class="detail-list milestones">${milestones}</ul></section>
    <section class="drawer-section policy-explanations" aria-labelledby="policy-explanations-heading"><div class="drawer-section-heading"><h3 id="policy-explanations-heading">Policy explanations</h3><span>${model.policyExceptions.length} exceptions</span></div>${model.policyExceptions.length ? model.policyExceptions.map((exception) => `<article class="detail-flag detail-flag-policy"><span class="detail-flag-icon">⌁</span><div><strong>${escapeHtml(exception.code ?? 'Code unavailable')} · ${escapeHtml(exception.name ?? 'Name unavailable')}</strong><p><strong>Reason:</strong> ${escapeHtml(exception.reason ?? 'Reason unavailable')}</p>${policyFlagDetails(exception)}</div></article>`).join('') : `<p class="drawer-section-copy">${request.status === 'cancelled' ? 'Cancelled request: no active policy exceptions.' : 'No policy exceptions flagged in the analyzed snapshot.'}</p>`}</section>
    <div class="source-description"><span class="detail-label">Source description</span><p>${escapeHtml(request.description)}</p><small>Requested ${dateLabel(request.requestedAt)} · ${escapeHtml(request.id)}</small></div>`;
}

function openDrawer(id) {
  const request = analyzedRequests.find((item) => item.id === id);
  if (!request) return;
  returnFocus = document.activeElement;
  state.selectedId = id;
  renderDrawer(request);
  elements.backdrop.hidden = false;
  elements.drawer.hidden = false;
  document.body.classList.add('drawer-open');
  $('.app-shell').inert = true;
  elements.closeDrawer.focus();
}

function closeDrawer() {
  elements.backdrop.hidden = true;
  elements.drawer.hidden = true;
  document.body.classList.remove('drawer-open');
  $('.app-shell').inert = false;
  state.selectedId = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

function setFilter(filter) {
  state.filters = toggleFilter(state.filters, filter);
  renderView();
}

function init() {
  Object.assign(elements, {
    recordsBody: $('#records-body'), emptyState: $('#empty-state'), recordCount: $('#record-count'), tableContext: $('#table-context'), drawer: $('#detail-drawer'), drawerBody: $('#drawer-body'), backdrop: $('#modal-backdrop'), closeDrawer: $('.close-drawer'), search: $('#record-search'),
  });
  renderView();
  renderPolicyRules();
  setMobileNavigation(false);
  mobileLayout.addEventListener('change', () => setMobileNavigation(false));

  document.querySelector('.filter-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (button) setFilter(button.dataset.filter);
  });
  elements.recordsBody.addEventListener('click', (event) => {
    const row = event.target.closest('[data-row-id]');
    if (row) {
      if (!event.target.closest('button')) row.querySelector('.record-button').focus();
      openDrawer(row.dataset.rowId);
    }
  });
  elements.search.addEventListener('input', (event) => { state.query = event.target.value; renderView(); });
  $('#sort-button').addEventListener('click', (event) => {
    state.sortAscending = !state.sortAscending;
    event.currentTarget.setAttribute('aria-label', `Sort records by title ${state.sortAscending ? 'descending' : 'ascending'}`);
    event.currentTarget.innerHTML = `Title <span aria-hidden="true">${state.sortAscending ? '↑' : '↓'}</span>`;
    renderView();
  });
  $('#clear-filters').addEventListener('click', () => { state.query = ''; elements.search.value = ''; setFilter('all'); });
  elements.closeDrawer.addEventListener('click', closeDrawer);
  elements.backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (!elements.drawer.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
      if (event.key === 'Tab') { event.preventDefault(); elements.closeDrawer.focus(); }
      return;
    }
    if (event.key === 'Escape' && document.body.classList.contains('mobile-nav-open')) {
      setMobileNavigation(false);
      $('.mobile-menu-button').focus();
    }
    if (event.key === '/' && !document.activeElement.matches('input, textarea, [contenteditable="true"]') && !event.metaKey && !event.ctrlKey) { event.preventDefault(); elements.search.focus(); }
  });
  $('.mobile-menu-button').addEventListener('click', () => {
    const open = !document.body.classList.contains('mobile-nav-open');
    setMobileNavigation(open);
    if (open) $('.sidebar-nav a').focus();
  });
  document.querySelectorAll('.sidebar-nav a').forEach((link) => link.addEventListener('click', (event) => {
    setMobileNavigation(false);
    if (mobileLayout.matches) $('.mobile-menu-button').focus();
    if (link.getAttribute('href') === '#attention') {
      event.preventDefault();
      if (!state.filters.includes('attention')) setFilter('attention');
      $('#commitments').scrollIntoView({ behavior: 'smooth' });
    }
  }));
}

init();
