import { DEMO_NOW, syntheticCases, teams } from './data.js';
import { evaluateAll, getWorkloads, sortCases } from './engine.js';

const state = {
  cases: [],
  workloads: [],
  selectedId: 'CF-0142',
  view: 'overview',
  query: '',
  filter: 'all',
  run: 0,
};

const CATEGORY_TINT = {
  housing: 'terracotta',
  benefits: 'lilac',
  'public-works': 'blue',
  health: 'green',
  permits: 'gold',
  general: 'slate',
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function icon(name, classes = '') {
  return `<svg class="icon ${classes}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function initials(value) {
  return String(value || 'Civic case')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function caseLabel(item) {
  return item?.classification?.label || 'General service';
}

function tintFor(item) {
  return CATEGORY_TINT[item?.classification?.category] || 'slate';
}

function categoryIcon(category) {
  return { housing: 'home', benefits: 'document', 'public-works': 'bars', health: 'shield', permits: 'document', general: 'inbox' }[category] || 'inbox';
}

// Display labels for the fixture set, not machine translations. Source text is preserved.
function displaySubject(item) {
  return {
    'CF-0142': 'Emergency housing referral',
    'CF-0143': 'Benefits renewal',
    'CF-0144': 'Pothole inspection',
    'CF-0145': 'Accessible health appointment',
    'CF-0146': 'Garden structure permit',
    'CF-0147': 'Large-print service information',
  }[item.id] || item.subject;
}

function priorityLabel(level) {
  return level ? `${level[0].toUpperCase()}${level.slice(1)}` : 'Normal';
}

function flagIcon(flag) {
  return icon({ deadline: 'clock', documents: 'document', language: 'language', access: 'access', review: 'alert' }[flag.type] || 'alert');
}

function displayDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(date);
}

function shortDeadlineLabel(item) {
  if (item.hoursRemaining == null) return 'Review deadline';
  if (item.hoursRemaining < 0) return `Overdue ${Math.ceil(Math.abs(item.hoursRemaining))}h`;
  if (item.hoursRemaining === 0) return 'Due now';
  if (item.hoursRemaining <= 24) return `Due in ${Math.ceil(item.hoursRemaining)}h`;
  return `Due in ${Math.ceil(item.hoursRemaining / 24)}d`;
}

function hoursLabel(value) {
  if (value == null) return '—';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}h`;
}

function renderDeadlineBreakdown(item, prefix = '') {
  const breakdown = item.deadlineBreakdown || {};
  const examples = Array.isArray(breakdown.boundaryExamples) ? breakdown.boundaryExamples : [];
  const titleId = `${prefix}deadline-breakdown-title`;
  return `<section class="decision-card deadline-card" aria-labelledby="${titleId}">
    <div class="decision-card-head"><div><span class="decision-icon">${icon('clock')}</span><div><span class="detail-label">DEADLINE CALCULATION</span><h3 id="${titleId}">${escapeHtml(breakdown.sourceLabel || 'Deadline review')}</h3></div></div><span class="decision-state ${breakdown.invalid || breakdown.hoursRemaining == null ? 'needs-review' : 'calculated'}">${breakdown.invalid || breakdown.hoursRemaining == null ? 'Review' : 'Calculated'}</span></div>
    <dl class="calculation-inputs">
      <div><dt>Evaluation clock (UTC)</dt><dd>${escapeHtml(breakdown.evaluatedAt)}</dd></div>
      <div><dt>${breakdown.source === 'sla' ? 'Received + SLA' : 'Effective deadline (UTC)'}</dt><dd>${escapeHtml(breakdown.source === 'sla' ? `${breakdown.receivedAt} + ${breakdown.policySlaHours}h` : breakdown.deadlineAt || 'Unavailable — confirm with reviewer')}</dd></div>
    </dl>
    <p class="decision-calculation">${escapeHtml(breakdown.calculation || 'No calculation available.')}</p>
    <div class="decision-result"><span>Time remaining</span><strong>${escapeHtml(hoursLabel(breakdown.hoursRemaining))}</strong><span>${escapeHtml(item.dueLabel)}</span></div>
    <p class="precision-note">Thresholds use the exact difference${breakdown.remainingMilliseconds == null ? '' : ` (${escapeHtml(breakdown.remainingMilliseconds)}ms)`}, not rounded display labels. Deadline-only priority: <strong>${escapeHtml(breakdown.deadlinePriority)}</strong>.${breakdown.priorityOverride ? ` ${escapeHtml(breakdown.priorityOverride)}` : ''}</p>
    <div class="boundary-heading"><span>Boundary examples</span><span>inclusive cutoffs</span></div><p class="example-note">Same clock; no safety-risk override. These examples do not change this case.</p>
    <div class="boundary-list">${examples.map((example) => `<div class="boundary-row"><span>${escapeHtml(example.label)}</span><strong>${escapeHtml(example.resultingPriority)}</strong><small>${escapeHtml(example.rule)}<br/>${escapeHtml(example.deadlineAt)} UTC</small></div>`).join('')}</div>
  </section>`;
}

function renderEscalationBreakdown(item, prefix = '') {
  const escalation = item.escalation || {};
  const titleId = `${prefix}escalation-breakdown-title`;
  return `<section class="decision-card escalation-card" aria-labelledby="${titleId}"><div class="decision-card-head"><div><span class="decision-icon">${icon('alert')}</span><div><span class="detail-label">ESCALATION RULE · ${escapeHtml(escalation.policyId || 'MANUAL')}</span><h3 id="${titleId}">${escapeHtml(escalation.policyName || 'Manual intake review')}</h3></div></div><span class="decision-state ${escalation.reviewRequired ? 'needs-review' : 'standard'}">${escalation.reviewRequired ? 'Review required' : 'Standard route'}</span></div><p class="rule-copy">${escapeHtml(escalation.rule || 'No escalation rule supplied.')}</p><p class="global-rule"><strong>Shared boundary:</strong> ${escapeHtml(escalation.globalRule || 'Urgent or safety-risk cases require duty-lead attention.')}</p><div class="trigger-list"><span class="boundary-heading">Why this status</span>${(escalation.triggers?.length ? escalation.triggers : ['No escalation trigger is active']).map((trigger) => `<span class="trigger-row">${icon(escalation.reviewRequired ? 'alert' : 'check')}${escapeHtml(trigger)}</span>`).join('')}</div><div class="escalation-action"><span>Next handling action (simulated)</span><strong>${escapeHtml(escalation.action || 'Continue the assigned route.')}</strong><small>No notification or referral is sent.</small></div></section>`;
}

function routeShort(item) {
  return teams.find((team) => team.id === item.route?.teamId)?.shortName || 'Manual review';
}

function caseFlags(item) {
  const seen = new Set();
  return (item.flags || []).filter((flag) => {
    if (seen.has(flag.type)) return false;
    seen.add(flag.type);
    return true;
  }).slice(0, 3);
}

function visibleCases() {
  const query = state.query.trim().toLowerCase();
  return sortCases(state.cases).filter((item) => {
    const queryMatch = !query || [item.id, item.subject, displaySubject(item), item.summary, item.classification?.label, item.route?.teamName, item.languageLabel]
      .join(' ').toLowerCase().includes(query);
    let filterMatch = true;
    if (state.filter === 'urgent') filterMatch = item.priority?.level === 'urgent';
    if (state.filter === 'documents') filterMatch = item.missingDocuments?.length > 0;
    if (state.filter === 'access') filterMatch = item.language !== 'en' || (item.accommodations || []).length > 0;
    return queryMatch && filterMatch;
  });
}

function remeasure() {
  const previousAudits = new Map(state.cases.map((item) => [item.id, item.audit]));
  state.run += 1;
  state.cases = evaluateAll(syntheticCases, { now: DEMO_NOW }).map((item) => {
    const events = item.audit.map((event) => ({ ...event, id: `${event.id}-run-${state.run}`, run: state.run }));
    const audit = [...(previousAudits.get(item.id) || []), ...events];
    return { ...item, audit, redacted: { ...item.redacted, audit } };
  });
  state.workloads = getWorkloads(state.cases, teams);
  if (!state.cases.some((item) => item.id === state.selectedId)) state.selectedId = state.cases[0]?.id;
}

function renderQueueRows(items, compact = true) {
  if (!items.length) return '';
  return items.map((item) => {
    const selected = item.id === state.selectedId;
    const flags = caseFlags(item);
    const priority = item.priority?.level || 'normal';
    return `<tr class="case-row ${selected ? 'selected' : ''}" data-case-id="${escapeHtml(item.id)}">
      <td><span class="case-id">${escapeHtml(item.id)}</span><span class="case-time">${escapeHtml(item.receivedAt.slice(11, 16))} UTC</span></td>
      <td><div class="request-cell"><span class="request-icon ${tintFor(item)}">${icon(categoryIcon(item.classification.category))}</span><div><button class="case-select" data-case-id="${escapeHtml(item.id)}" type="button" title="${escapeHtml(item.subject)}" dir="auto">${escapeHtml(displaySubject(item))}</button><span class="request-meta"><span>${escapeHtml(caseLabel(item))}</span><span class="language-badge ${item.language === 'en' ? 'default-language' : ''}" title="Preferred language: ${escapeHtml(item.languageLabel)}" aria-label="Preferred language: ${escapeHtml(item.languageLabel)}">${escapeHtml(item.language.toUpperCase())}</span></span></div></div></td>
      <td><span class="priority-pill ${priority}"><i></i>${escapeHtml(priorityLabel(priority))}</span><span class="score-label">${escapeHtml(item.priority?.score)} pts</span></td>
      <td><div class="route-cell"><span class="team-dot" style="--team-color:${escapeHtml(teamColor(item.route?.teamId))}"></span><span>${escapeHtml(routeShort(item))}</span>${item.route?.needsReview ? '<span class="review-mark" title="Review required">!</span>' : ''}</div><button class="route-explain" data-case-id="${escapeHtml(item.id)}" aria-label="Inspect deadline and escalation for ${escapeHtml(item.id)}" type="button">Inspect decision ↗</button></td>
      <td class="deadline-cell"><span class="due-value ${priority === 'urgent' ? 'due-urgent' : ''}">${escapeHtml(shortDeadlineLabel(item))}</span>${item.deadlineBreakdown?.deadlineAt ? `<time class="due-date" datetime="${escapeHtml(item.deadlineBreakdown.deadlineAt)}">${escapeHtml(displayDate(item.deadlineBreakdown.deadlineAt))} UTC</time>` : '<span class="due-date">Confirm with reviewer</span>'}</td>
      <td><div class="flag-list">${flags.map((flag) => `<span class="table-flag ${flag.type}" role="img" title="${escapeHtml(flag.label)}" aria-label="${escapeHtml(flag.label)}">${flagIcon(flag)}</span>`).join('')}</div>${item.missingDocuments.length ? `<span class="document-badge">${item.missingDocuments.length} missing · accepted</span>` : ''}</td>
    </tr>`;
  }).join('');
}

function teamColor(id) {
  return teams.find((team) => team.id === id)?.color || '#8290a0';
}

function renderQueue() {
  const items = visibleCases();
  $$('.filter-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === state.filter);
    chip.setAttribute('aria-pressed', String(chip.dataset.filter === state.filter));
  });
  $('#queue-body').innerHTML = renderQueueRows(items);
  $('#queue-count').textContent = String(state.cases.length).padStart(2, '0');
  $('#visible-count').textContent = String(items.length).padStart(2, '0');
  $('#empty-state').hidden = items.length > 0;
  $$('#queue-body .case-row').forEach((row) => {
    row.addEventListener('click', () => selectCase(row.dataset.caseId));
  });
  bindDecisionInspectors('#queue-body');
}

function bindDecisionInspectors(container) {
  $$(`${container} .route-explain`).forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const item = state.cases.find((candidate) => candidate.id === button.dataset.caseId);
    if (item) openCaseDialog(item, 'decision');
  }));
}

function renderMetrics() {
  const urgent = state.cases.filter((item) => item.priority.level === 'urgent').length;
  const attention = state.cases.filter((item) => item.route.needsReview || item.priority.level === 'urgent' || item.missingDocuments.length).length;
  const totalCapacity = state.workloads.reduce((sum, team) => sum + team.capacity, 0);
  const active = state.workloads.reduce((sum, team) => sum + team.active, 0);
  const high = state.cases.filter((item) => item.priority.level === 'high').length;
  const normal = state.cases.filter((item) => item.priority.level === 'normal').length;
  $('#metric-active').textContent = String(state.cases.length).padStart(2, '0');
  $('#metric-attention').textContent = String(attention).padStart(2, '0');
  $('#metric-capacity').innerHTML = `${totalCapacity ? Math.round(active / totalCapacity * 100) : 0}<span class="metric-unit">%</span>`;
  $('#urgent-count').textContent = String(urgent).padStart(2, '0');
  $('#high-count').textContent = String(high).padStart(2, '0');
  $('#normal-count').textContent = String(normal).padStart(2, '0');
  renderPriorityChart();
}

function renderPriorityChart() {
  const items = [...state.cases].sort((a, b) => a.id.localeCompare(b.id));
  const points = items.map((item, index) => ({ x: index * 360 / (items.length - 1), y: 146 - item.priority.score * 1.46, item }));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  $('#priority-chart .pulse-line').setAttribute('d', line);
  $('#priority-chart .pulse-area').setAttribute('d', `${line} L360,146 L0,146 Z`);
  $('#chart-points').innerHTML = points.map(({ x, y, item }) => `<circle cx="${x}" cy="${y}" r="3.5" class="pulse-point"><title>${escapeHtml(item.id)} · ${item.priority.score} pts · ${escapeHtml(item.priority.level)}</title></circle>`).join('');
  $('#chart-x-labels').innerHTML = items.map((item) => `<span>${escapeHtml(item.id.slice(-3))}</span>`).join('');
}

function renderCaseDetail() {
  const item = state.cases.find((candidate) => candidate.id === state.selectedId) || state.cases[0];
  if (!item) return;
  const safe = item.redacted || {};
  const flags = item.flags || [];
  $('#case-detail').innerHTML = `<div class="detail-topline"><div><div class="section-kicker">SELECTED CASE</div><h2>${escapeHtml(item.id)} <span class="detail-status ${escapeHtml(item.caseState?.status || '')}">${escapeHtml(item.caseState?.label || (item.route.needsReview ? 'Review required' : 'Routed'))}</span></h2><p class="state-reason">${escapeHtml(item.caseState?.reason || '')}</p></div><button class="small-outline" id="share-redacted" type="button">${icon('shield')} Share redacted</button></div>
    <div class="case-hero"><div class="case-avatar ${tintFor(item)}">${escapeHtml(initials(item.person?.name))}</div><div class="case-title"><h3>${escapeHtml(displaySubject(item))}</h3><p dir="auto" title="${escapeHtml(item.summary)}">${escapeHtml(item.summary)}</p></div><span class="priority-pill ${item.priority.level}"><i></i>${escapeHtml(priorityLabel(item.priority.level))}<small>${escapeHtml(item.priority.score)} pts</small></span></div>
     <div class="detail-columns"><div><div class="detail-label">CLASSIFICATION</div><div class="classification-value"><span class="category-dot ${tintFor(item)}"></span><strong>${escapeHtml(caseLabel(item))}</strong><span class="confidence">${Math.round(item.classification.confidence * 100)}% confidence</span></div><p class="detail-reason">${escapeHtml(item.classification.reason)}</p></div><div><div class="detail-label">ROUTED TO</div><div class="classification-value"><span class="team-dot" style="--team-color:${escapeHtml(teamColor(item.route.teamId))}"></span><strong>${escapeHtml(item.route.teamName)}</strong></div><p class="detail-reason">${escapeHtml(item.route.reason)}</p></div></div>
     <div class="decision-breakdown-grid">${renderDeadlineBreakdown(item)}${renderEscalationBreakdown(item)}</div>
     ${item.missingDocuments.length ? `<section class="document-followup ${item.priority.level === 'urgent' ? 'urgent-followup' : ''}" role="note" aria-label="${item.priority.level === 'urgent' ? 'Urgent document follow-up' : 'Document follow-up'}"><strong>${item.priority.level === 'urgent' ? 'Urgent + incomplete — do not delay intake' : 'Documents outstanding — intake accepted'}</strong><p>${escapeHtml(item.missingDocuments.map((document) => document.label).join('; '))}. ${item.priority.level === 'urgent' ? 'Duty-lead attention and document follow-up happen in parallel; urgency and workload assignment are preserved.' : 'Request the outstanding documents through the assigned team.'}</p></section>` : ''}
     <div class="detail-facts"><div class="fact"><span class="detail-label">CASE STATE</span><strong>${escapeHtml(item.caseState?.label || 'Routed')}</strong><span>${escapeHtml(item.caseState?.intake || 'accepted')} intake · ${escapeHtml(item.caseState?.documentStatus || 'complete')} docs</span></div><div class="fact"><span class="detail-label">DEADLINE</span><strong class="${item.priority.level === 'urgent' ? 'coral-text' : ''}">${escapeHtml(item.dueLabel)}</strong><span>${escapeHtml(displayDate(item.deadlineBreakdown?.deadlineAt))} UTC</span></div><div class="fact"><span class="detail-label">LANGUAGE</span><strong>${escapeHtml(item.languageLabel || item.language || 'Not specified')}</strong><span>${item.language === 'en' ? 'No interpreter requested' : 'Interpreter coordination retained'}</span></div><div class="fact"><span class="detail-label">DOCUMENTS</span><strong>${item.missingDocuments.length ? `${item.missingDocuments.length} missing` : 'Complete'}</strong><span>${item.documents.filter((doc) => doc.status === 'received').length} received · contents protected</span></div></div>
    <div class="flag-strip">${flags.length ? flags.map((flag) => `<span class="detail-flag ${flag.type}">${flagIcon(flag)}${escapeHtml(flag.label)}</span>`).join('') : `<span class="detail-flag clear">${icon('check')} No review flags</span>`}</div>
    <div class="dossier-actions"><button class="plain-button" id="open-intake" type="button">${icon('document')} Form & attachments <span>↗</span></button><button class="plain-button" id="open-policy" type="button">${icon('list')} Applied service policy <span>↗</span></button></div>
    <div class="privacy-block"><div class="privacy-head">${icon('shield', 'lock-icon')}<div><strong>Safe-to-share preview</strong><p>PII and document contents are redacted; routing context stays visible.</p></div><button class="plain-button" id="toggle-preview" type="button" aria-expanded="false" aria-controls="preview-fields">View fields <span>↓</span></button></div><div class="preview-fields" id="preview-fields" hidden><div><span>Name</span><strong>${escapeHtml(safe.person?.name || 'xxxxxxxx')}</strong></div><div><span>Preferred contact</span><strong>${escapeHtml(safe.person?.email || 'xxxxxxxx')}</strong></div><div><span>Region</span><strong>${escapeHtml(item.region)}</strong></div></div></div>
    <div class="audit-heading"><div><div class="section-kicker">DECISION LOG</div><h3>Why this happened</h3></div><button class="plain-button" id="open-case-audit" type="button">All ${item.audit.length} events →</button></div><ol class="audit-list">${item.audit.filter((event) => event.run === state.run).slice(0, 4).map((event) => `<li><span class="audit-marker">${auditIcon(event.action)}</span><div><strong>${escapeHtml(event.action)}</strong><p title="${escapeHtml(event.reason)}">${escapeHtml(event.reason)}</p><time>${escapeHtml(event.at.slice(11, 16))} UTC · run ${event.run}</time></div></li>`).join('')}</ol>`;
  $('#share-redacted').addEventListener('click', () => openCaseDialog(item, 'redacted'));
  $('#open-intake').addEventListener('click', () => openCaseDialog(item, 'intake'));
  $('#open-policy').addEventListener('click', () => openCaseDialog(item, 'policy'));
  $('#open-case-audit').addEventListener('click', () => openCaseDialog(item, 'audit'));
  $('#toggle-preview').addEventListener('click', () => {
    const preview = $('#preview-fields');
    preview.hidden = !preview.hidden;
    $('#toggle-preview').setAttribute('aria-expanded', String(!preview.hidden));
    $('#toggle-preview').innerHTML = preview.hidden ? 'View fields <span>↓</span>' : 'Hide fields <span>↑</span>';
  });
}

function auditIcon(action) {
  return icon({ Classification: 'grid', 'Deadline & priority': 'clock', Documents: 'document', Route: 'arrow', Redact: 'shield' }[action] || 'alert');
}

function openCaseDialog(item, mode) {
  const dialog = $('#case-dialog');
  const titles = { intake: 'Original form & attachments', policy: 'The rules behind this route', redacted: 'A safer version to share', audit: 'The complete decision log', decision: 'Why this route was chosen' };
  let body = '';
  if (mode === 'intake') {
    body = `<div class="dialog-notice">${icon('inbox')} Fictional intake only. All names, contacts, and documents below are synthetic.</div>
      <section class="source-section"><h3>Incoming request</h3><div class="source-text" lang="${escapeHtml(item.language)}" dir="auto"><strong>${escapeHtml(item.subject)}</strong><p>${escapeHtml(item.summary)}</p></div>
      <dl class="source-fields"><div><dt>Received</dt><dd>${escapeHtml(displayDate(item.receivedAt))} UTC</dd></div><div><dt>Preferred language</dt><dd>${escapeHtml(item.languageLabel)}</dd></div><div><dt>Requested accommodations</dt><dd>${escapeHtml(item.accommodations.join(' · ') || 'None requested')}</dd></div>${item.fields.map((field) => `<div><dt>${escapeHtml(field.label)} ${field.sensitive ? '<span class="sensitive-label">SENSITIVE</span>' : ''}</dt><dd dir="auto">${escapeHtml(field.value)}</dd></div>`).join('')}</dl></section>
      <section class="source-section"><h3>Bundled attachments <span>${item.documents.length}</span></h3><div class="attachment-list">${item.documents.map((doc) => `<details class="attachment ${doc.status === 'missing' ? 'missing-attachment' : ''}"><summary>${icon('document')}<span>${escapeHtml(doc.name)}</span><span class="attachment-status">${doc.status === 'received' ? 'Received' : 'Missing'}</span></summary><pre>${escapeHtml(doc.content || 'Not supplied. Intake remains accepted; the assigned team will request this document.')}</pre></details>`).join('')}</div></section>`;
  } else if (mode === 'policy') {
    const policy = item.policy;
    body = `<div class="dialog-notice">${icon('list')} ${escapeHtml(policy?.id || 'Manual review')} · rules v1.0.0 · evaluated at ${escapeHtml(DEMO_NOW.slice(11, 16))} UTC</div>
      <section class="source-section"><h3>${escapeHtml(policy?.name || 'Manual intake review')}</h3><dl class="source-fields"><div><dt>Default service deadline</dt><dd>${escapeHtml(policy?.slaHours || '—')} hours after receipt, unless a submitted deadline applies</dd></div><div><dt>Classification evidence</dt><dd>${escapeHtml(item.classification.source)} · matched ${escapeHtml(item.classification.matchedTerms.join(', ') || 'no keyword terms')}</dd></div><div><dt>Priority score</dt><dd>${item.priority.score}/100 · ${escapeHtml(priorityLabel(item.priority.level))}<small>Rules-based evidence score, not an AI probability.</small></dd></div></dl><ul class="policy-reasons">${item.priority.reasons.map((reason) => `<li>${icon('check')}${escapeHtml(reason)}</li>`).join('')}</ul></section>
      <section class="source-section"><h3>Required documents</h3><ul class="document-checklist">${(policy?.requiredDocuments || []).map((doc) => `<li><span>${escapeHtml(doc.label)}</span><strong class="${item.missingDocuments.some((missing) => missing.type === doc.type) ? 'missing' : ''}">${item.missingDocuments.some((missing) => missing.type === doc.type) ? 'Outstanding' : 'Received'}</strong></li>`).join('')}</ul></section>
      <section class="source-section"><h3>Escalation & handoff</h3><p class="policy-copy">${escapeHtml(policy?.escalationRule || 'A human reviewer must confirm the service team.')}</p><div class="escalation-box"><strong>${escapeHtml(item.route.teamName)}</strong><p>${escapeHtml(item.route.reason)}</p>${item.route.flags.map((flag) => `<p>• ${escapeHtml(flag)}</p>`).join('')}</div></section>`;
  } else if (mode === 'redacted') {
    const safe = item.redacted;
    body = `<div class="dialog-notice safe">${icon('shield')} Names, contact details, sensitive fields, and every attachment body are masked.</div>
      <section class="source-section"><h3>Share-safe case summary</h3><div class="source-text" dir="auto"><strong>${escapeHtml(safe.subject)}</strong><p>${escapeHtml(safe.summary)}</p></div><dl class="source-fields">${Object.entries(safe.person || {}).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd class="redacted-value">${escapeHtml(value)}</dd></div>`).join('')}${safe.fields.map((field) => `<div><dt>${escapeHtml(field.label)}</dt><dd class="${field.sensitive ? 'redacted-value' : ''}">${escapeHtml(field.value)}</dd></div>`).join('')}</dl></section>
      <section class="source-section"><h3>Protected attachments</h3><ul class="document-checklist">${safe.documents.map((doc) => `<li><span>${escapeHtml(doc.name)}</span><strong class="redacted-value">${escapeHtml(doc.content)}</strong></li>`).join('')}</ul><p class="redaction-note">Redaction follows marked fields and known fixture identities. It is not a general-purpose detector for arbitrary personal information.</p></section>
      <div class="dialog-footer"><span>Stays on your device. No upload or external API.</span><button class="primary-button" id="download-redacted" type="button">${icon('document')} Download redacted JSON</button></div>`;
  } else if (mode === 'decision') {
    body = `<div class="dialog-notice">${icon('clock')} This explanation is computed from the fixed demo clock and the synthetic policy record. It does not send a notification or make a live referral.</div><div class="dialog-decision-grid">${renderDeadlineBreakdown(item, 'dialog-')}${renderEscalationBreakdown(item, 'dialog-')}</div><div class="dialog-footer"><span>Decision metadata remains local to this browser session.</span><button class="primary-button dialog-close-secondary" type="button">Done</button></div>`;
  } else {
    body = `<div class="dialog-notice">${icon('list')} In-memory, append-only for this browser session. Re-running adds a new evaluation.</div><ol class="dialog-audit">${item.audit.map((event) => `<li><span class="audit-marker">${auditIcon(event.action)}</span><div><strong>${escapeHtml(event.action)}</strong><p>${escapeHtml(event.reason)}</p><time>${escapeHtml(displayDate(event.at))} UTC · run ${event.run} · ${escapeHtml(event.actor)}</time></div></li>`).join('')}</ol>`;
  }
  $('#dialog-content').innerHTML = `<div class="dialog-header"><div><div class="section-kicker">${escapeHtml(item.id)} · ${escapeHtml(mode.toUpperCase())}</div><h2 id="dialog-title">${escapeHtml(titles[mode])}</h2></div><button class="dialog-close" type="button" aria-label="Close dialog">×</button></div>${body}`;
  $('.dialog-close').addEventListener('click', () => dialog.close());
  $('.dialog-close-secondary')?.addEventListener('click', () => dialog.close());
  $('#download-redacted')?.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(item.redacted, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.id}-redacted.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`${item.id}: redacted copy downloaded. Nothing was uploaded.`);
  });
  dialog.showModal();
  dialog.scrollTop = 0;
}

function renderWorkloadList() {
  $('#workload-list').setAttribute('role', 'list');
  $('#workload-list').setAttribute('aria-label', 'Team workloads');
  $('#workload-list').innerHTML = state.workloads.map((team) => `<div class="workload-row" role="listitem" data-team-id="${escapeHtml(team.id)}"><div class="workload-name"><span class="team-dot" style="--team-color:${escapeHtml(team.color)}" aria-hidden="true"></span><strong title="${escapeHtml(team.name)}">${escapeHtml(team.shortName)}</strong></div>${renderWorkloadMeter(team, 'workload-bar')}<div class="workload-number">${escapeHtml(team.active)}<span>/${escapeHtml(team.capacity)}</span></div>${renderWorkloadAttention(team)}</div>`).join('');
}

function renderWorkloadMeter(team, className) {
  const value = Math.min(100, Math.max(0, team.utilization));
  const description = `${team.active} active of ${team.capacity} capacity; ${team.available} available; ${team.urgent} urgent; ${team.awaitingDocuments} awaiting documents; ${team.overCapacity} over capacity.`;
  return `<div class="${className}" role="meter" aria-label="${escapeHtml(team.name)} workload" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-valuetext="${escapeHtml(description)}"><i aria-hidden="true" style="width:${value}%;--team-color:${escapeHtml(team.color)}"></i></div>`;
}

function renderWorkloadAttention(team) {
  return `<div class="workload-attention"><span class="${team.urgent ? 'urgent-text' : ''}">${team.urgent} urgent</span><span>${team.awaitingDocuments} awaiting documents</span>${team.overCapacity ? `<strong>${team.overCapacity} over capacity · supervisor review</strong>` : ''}</div>`;
}

function renderQueueView() {
  $('#queue-view').innerHTML = `<div class="full-heading"><div><div class="section-kicker">INCOMING QUEUE</div><h2>All incoming cases</h2><p>Stable priority order with language, accessibility, and document flags preserved.</p></div><div class="full-stats"><strong id="full-queue-count">${visibleCases().length}</strong><span>visible cases</span></div></div>
    <div class="full-queue-tools"><label class="search-box">${icon('search')}<input id="full-search" type="search" placeholder="Search cases, service, language…" aria-label="Search incoming cases" value="${escapeHtml(state.query)}"/></label><label class="full-filter-label">Show <select id="full-filter" aria-label="Filter incoming cases"><option value="all">All cases</option><option value="urgent">Urgent</option><option value="documents">Missing documents</option><option value="access">Language / accessibility</option></select></label></div>
    <p class="table-scroll-hint" id="full-scroll-hint">Swipe the table, or focus it and use arrow keys, to see deadlines and flags.</p><div class="full-table-wrap" role="region" aria-label="All incoming cases table" aria-describedby="full-scroll-hint" tabindex="0"><table class="queue-table full-table" aria-label="All incoming cases"><thead><tr><th scope="col">CASE</th><th scope="col">REQUEST</th><th scope="col">PRIORITY</th><th scope="col">ROUTED TO</th><th scope="col">DEADLINE</th><th scope="col">FLAGS</th></tr></thead><tbody id="full-queue-body"></tbody></table><div id="full-empty" class="empty-state" hidden><strong>No cases match</strong><p>Try a different search or filter.</p></div></div>`;
  $('#full-filter').value = state.filter;
  $('#full-search').addEventListener('input', (event) => {
    state.query = event.target.value;
    $('#search-input').value = state.query;
    renderQueue();
    renderFullQueueRows();
  });
  $('#full-filter').addEventListener('change', (event) => {
    state.filter = event.target.value;
    $$('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === state.filter));
    renderQueue();
    renderFullQueueRows();
  });
  renderFullQueueRows();
}

function renderFullQueueRows() {
  const items = visibleCases();
  $('#full-queue-body').innerHTML = renderQueueRows(items, false);
  $('#full-queue-count').textContent = items.length;
  $('#full-empty').hidden = items.length > 0;
  $$('#full-queue-body .case-row').forEach((row) => row.addEventListener('click', () => { setView('overview'); selectCase(row.dataset.caseId); }));
  bindDecisionInspectors('#full-queue-body');
}

function renderWorkloadView() {
  $('#workload-view').innerHTML = `<div class="full-heading"><div><div class="section-kicker">CAPACITY BOARD</div><h2>Team workload</h2><p>Baseline active work plus this synthetic intake batch. Capacity never hides an urgent or incomplete case.</p></div><div class="full-stats"><strong>${Math.round(state.workloads.reduce((sum, team) => sum + team.active, 0) / state.workloads.reduce((sum, team) => sum + team.capacity, 0) * 100)}%</strong><span>total utilization</span></div></div>
    <div class="workload-cards" role="list" aria-label="Team workload detail">${state.workloads.map((team) => `<article class="workload-card" role="listitem" data-team-id="${escapeHtml(team.id)}">
      <div class="workload-card-head"><span class="team-avatar" style="--team-color:${escapeHtml(team.color)}" aria-hidden="true">${escapeHtml(initials(team.shortName))}</span><div><h3>${escapeHtml(team.name)}</h3><p>${team.languages.map((language) => language.toUpperCase()).join(' · ')} · ${team.accommodations.length} access supports</p></div><span class="workload-percentage">${team.utilization}%</span></div>
      ${renderWorkloadMeter(team, 'large-workload-bar')}
      <div class="workload-card-foot"><span>${team.active} active of ${team.capacity} capacity</span><strong>${team.available} available</strong></div>${renderWorkloadAttention(team)}
    </article>`).join('')}</div>`;
}

function renderAuditView() {
  const events = sortCases(state.cases).flatMap((item) => item.audit.map((event) => ({ ...event, caseId: item.id, priority: item.priority.level }))).sort((a, b) => b.run - a.run);
  $('#audit-view').innerHTML = `<div class="full-heading"><div><div class="section-kicker">AUDIT TRAIL</div><h2>Every decision, explainable</h2><p>Append-only for this session. Fixed demo clock; newest evaluation batches appear first.</p></div><div class="full-stats"><strong>${events.length}</strong><span>recorded events</span></div></div><div class="audit-stream">${events.map((event) => `<article class="audit-stream-row"><span class="audit-marker">${auditIcon(event.action)}</span><div><div class="audit-stream-meta"><strong>${escapeHtml(event.action)}</strong><span>${escapeHtml(event.caseId)}</span><span>RUN ${event.run}</span><span class="priority-mini ${escapeHtml(event.priority)}">${escapeHtml(priorityLabel(event.priority))}</span></div><p>${escapeHtml(event.reason)}</p><time>${escapeHtml(displayDate(event.at))} UTC · ${escapeHtml(event.actor)}</time></div></article>`).join('')}</div>`;
}

function renderAll() {
  renderMetrics();
  renderQueue();
  renderCaseDetail();
  renderWorkloadList();
  renderQueueView();
  renderWorkloadView();
  renderAuditView();
  updateViewVisibility();
}

function selectCase(id) {
  state.selectedId = id;
  renderQueue();
  renderCaseDetail();
  const selected = state.cases.find((item) => item.id === id);
  if (selected) $('#case-announcement').textContent = `${selected.id} selected. ${priorityLabel(selected.priority.level)}. ${selected.caseState.label}. ${selected.missingDocuments.length} missing document${selected.missingDocuments.length === 1 ? '' : 's'}; intake accepted. ${shortDeadlineLabel(selected)}.`;
  document.querySelector('#detail-area')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateViewVisibility() {
  const overview = $('#overview-view');
  const detail = $('#detail-area');
  const views = { queue: $('#queue-view'), workload: $('#workload-view'), audit: $('#audit-view') };
  overview.hidden = state.view !== 'overview';
  detail.hidden = state.view !== 'overview';
  Object.entries(views).forEach(([name, element]) => { element.hidden = state.view !== name; });
  $$('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const title = state.view === 'overview' ? 'Overview' : state.view[0].toUpperCase() + state.view.slice(1);
  $('#breadcrumb-current').textContent = title;
}

function setView(view) {
  state.view = view;
  updateViewVisibility();
  if (view !== 'overview') window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove('visible'), 3000);
}

function bindEvents() {
  $$('.nav-item, [data-view="workload"]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#search-input').addEventListener('input', (event) => { state.query = event.target.value; renderQueue(); renderQueueView(); });
  $('#filter-button').addEventListener('click', () => {
    $('#filter-bar').hidden = !$('#filter-bar').hidden;
    $('#filter-button').setAttribute('aria-expanded', String(!$('#filter-bar').hidden));
  });
  $$('.filter-chip').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip === button));
    renderQueue();
    renderQueueView();
  }));
  $('#view-all-button').addEventListener('click', () => setView('queue'));
  $('#rerun-button').addEventListener('click', () => { remeasure(); renderAll(); showToast('Routing re-evaluated with the same fixed policy clock.'); });
  $('#notifications-button').addEventListener('click', () => {
    state.query = '';
    state.filter = 'urgent';
    $('#search-input').value = '';
    $$('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'urgent'));
    renderQueue();
    renderQueueView();
    setView('queue');
  });
  $$('.nav-item').forEach((button) => button.setAttribute('aria-label', button.dataset.view === 'queue' ? 'Incoming queue' : button.dataset.view));
  $('#case-dialog').addEventListener('click', (event) => {
    if (event.target !== $('#case-dialog')) return;
    const bounds = $('#case-dialog').getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('#case-dialog').close();
  });
}

remeasure();
bindEvents();
renderAll();
