import { dependencyModules, modules, productCatalog } from './data.js';
import { buildRemediationQueue, exportQueueCsv, exportQueueMarkdown, filterModules, enrichModules, PATCH_LABELS } from './triage.js';

const allModules = enrichModules(modules, { productCatalog, dependencyModules });
let currentModules = allModules;
const queue = buildRemediationQueue(allModules);

const $ = (selector) => document.querySelector(selector);
const severityLabel = (severity) => severity.charAt(0).toUpperCase() + severity.slice(1);
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
let previousFocus;
let drawerTimer;

function showDrawer(content) {
  clearTimeout(drawerTimer);
  if (!$('#detail-drawer').classList.contains('open')) previousFocus = document.activeElement;
  $('#drawer-content').innerHTML = content;
  $('#drawer-backdrop').hidden = false;
  $('#detail-drawer').classList.add('open');
  $('#detail-drawer').inert = false;
  $('#detail-drawer').setAttribute('aria-hidden', 'false');
  $('#close-drawer').focus({ preventScroll: true });
  $('#detail-drawer').scrollTop = 0;
}

function dependencyMarkup(link) {
  const targetId = link.targetId ?? link.moduleId;
  return `<div class="dependency-link"><span>${link.status === 'resolved' ? '↗' : '!'}</span><div>${link.status === 'resolved' ? `<button class="metadata-link" data-record-id="${escapeHtml(targetId)}">${escapeHtml(link.target.name)}</button>` : `<strong>${escapeHtml(targetId)} (missing metadata)</strong>`}<small>${escapeHtml(link.sourceModuleId)} → ${escapeHtml(targetId)}<br>${escapeHtml(link.relation)} · ${link.status}</small></div></div>`;
}

function advisoryMarkup(group) {
  return `<details class="drawer-info-card advisory-group" data-advisory-id="${escapeHtml(group.id)}"><summary><strong>${escapeHtml(group.id)}</strong><small> ${group.occurrences.length} occurrences · ${group.moduleIds.length} modules · ${group.evidence.length} evidence · ${group.cves.length} CVSS records</small></summary><p>Grouped by advisory ID only; products and vulnerabilities remain module-scoped. Untagged observations are module context, not advisory-specific proof.</p>${group.occurrences.map((item) => `<div class="source-record"><strong>Occurrence ${item.index + 1} · ${escapeHtml(item.moduleId)}</strong><pre>${escapeHtml(JSON.stringify(item.record, null, 2))}</pre></div>`).join('')}${group.evidence.map((item) => `<div class="source-record"><strong>Evidence · ${escapeHtml(item.moduleId)} · ${escapeHtml(item.scope ?? 'advisory')}</strong><pre>${escapeHtml(JSON.stringify(item.originalEvidence, null, 2))}</pre></div>`).join('')}${group.cves.map((item) => `<div class="source-record"><strong>CVSS observation · ${escapeHtml(item.moduleId)} · ${escapeHtml(item.scope ?? 'advisory')}</strong><pre>${escapeHtml(JSON.stringify(item.originalCve, null, 2))}</pre></div>`).join('')}</details>`;
}

function renderMetrics() {
  const critical = allModules.filter((module) => module.severity === 'critical').length;
  const blockers = allModules.filter((module) => ['unavailable', 'unknown'].includes(module.patchStatus.status)).length;
  const average = Math.round(allModules.reduce((sum, module) => sum + module.priority.confidence.score, 0) / allModules.length);
  $('#metric-queue').textContent = String(queue.length).padStart(2, '0');
  $('#nav-queue-count').textContent = queue.length;
  $('#metric-critical').textContent = String(critical).padStart(2, '0');
  $('#metric-blockers').textContent = String(blockers).padStart(2, '0');
  $('#metric-confidence').textContent = average;
  $('#confidence-ring').textContent = average;
  $('#dataset-summary').textContent = `${allModules.length} module records · ${allModules.reduce((sum, module) => sum + module.evidence.length, 0)} evidence items`;
  $('#verification-count').textContent = `${allModules.filter((module) => module.duplicateAdvisories.length || module.priority.cvssConflict).length} records need verification`;
  const averages = [
    allModules.flatMap((module) => module.evidence.filter((item) => item.kind === 'inventory')).map((item) => item.confidence),
    allModules.flatMap((module) => module.evidence.filter((item) => item.kind === 'advisory')).map((item) => item.confidence),
    allModules.map((module) => module.patchConfidence.score),
  ];
  document.querySelectorAll('.bar-line').forEach((bar, index) => {
    const values = averages[index];
    const value = values.length ? Math.round(values.reduce((sum, score) => sum + score, 0) / values.length) : 0;
    bar.querySelector('b').textContent = `${value}/100`;
    bar.querySelector('i').style.width = `${value}%`;
  });
}

function moduleProduct(module) {
  const product = module.resolvedProducts?.[0] ?? module.products?.[0];
  if (!product) return 'Product not specified';
  const status = product.resolution?.status;
  const resolution = status === 'alias' ? ' · alias resolved' : ['unresolved', 'ambiguous'].includes(status) ? ` · ${status}` : '';
  return `${product.vendor} · ${product.name}${resolution}`;
}

function productResolutionLabel(product) {
  const status = product.resolution?.status ?? 'unresolved';
  const candidates = product.resolution?.candidates ?? [];
  return `${status} · ${product.resolution?.reason ?? 'No resolution detail'}${product.canonicalId ? ` Catalog ID: ${product.canonicalId}` : candidates.length ? ` Candidates: ${candidates.join(', ')}` : ''}`;
}

function dependencyLabel(link) {
  const target = link.target?.name ?? link.targetId ?? link.moduleId;
  return `${link.sourceModuleId} → ${target} · ${link.relation}`;
}

function renderRows() {
  const tbody = $('#module-rows');
  $('#visible-count').textContent = currentModules.length;
  $('#empty-state').hidden = currentModules.length !== 0;
  tbody.innerHTML = currentModules.map((module) => {
    const { priority } = module;
    const chips = [`<span class="chip severity-${module.severity}">${severityLabel(module.severity)}</span>`];
    if (priority.cvssConflict) chips.push('<span class="chip conflict">CVSS conflict</span>');
    if (module.duplicateAdvisories?.length) chips.push('<span class="chip duplicate">Duplicate advisory</span>');
    return `<tr class="module-row" data-module-id="${escapeHtml(module.id)}">
      <td><div class="priority-cell"><span class="priority-number">${String(priority.score).padStart(2, '0')}</span><span class="priority-bar"><i style="width:${priority.score}%"></i></span></div></td>
      <td><div class="module-name">${escapeHtml(module.name)}</div><div class="module-id">${escapeHtml(module.id)}</div><div class="module-product">${escapeHtml(moduleProduct(module))}</div></td>
      <td><div class="risk-chips">${chips.join('')}</div><div class="module-product">CVSS ${priority.cvssMax.toFixed(1)} · ${priority.exploitability > 12 ? 'Network reachable' : 'Prerequisites apply'}</div></td>
      <td><div class="evidence-score"><span class="confidence-dot ${priority.confidence.level}"></span><span>${priority.confidence.score}</span><span class="confidence-label">${priority.confidence.label}</span></div><div class="module-product">${module.evidence.length} source${module.evidence.length === 1 ? '' : 's'} · patch ${module.patchConfidence.score}/100</div></td>
      <td><span class="patch-badge ${module.patchStatus.status}" title="${escapeHtml(module.patchConfidence.reasons.join(' '))}">${PATCH_LABELS[module.patchStatus.status]} · ${module.patchConfidence.label}</span></td>
      <td><span class="row-arrow">→</span></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.module-row').forEach((row) => {
    row.tabIndex = 0;
    row.setAttribute('aria-label', `Review ${allModules.find((module) => module.id === row.dataset.moduleId).name}`);
    row.addEventListener('click', () => openDrawer(row.dataset.moduleId));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(row.dataset.moduleId); } });
  });
}

function renderQueue(showAll = false) {
  $('#queue-list').innerHTML = queue.slice(0, showAll ? queue.length : 4).map((item) => `<button class="queue-item" data-module-id="${escapeHtml(item.moduleId)}"><span class="queue-rank">${String(item.order).padStart(2, '0')}</span><div><strong>${escapeHtml(item.name)}</strong><small class="queue-action">${escapeHtml(item.action)}</small><small>${PATCH_LABELS[item.patchStatus]} · patch confidence ${item.patchConfidence.score}/100 ${item.patchConfidence.label} · ${escapeHtml(item.owner)} · ${escapeHtml(item.due)}</small></div><span class="queue-priority">${item.priority}</span><span class="queue-arrow">→</span></button>`).join('');
  $('#queue-list').querySelectorAll('.queue-item').forEach((item) => item.addEventListener('click', () => openDrawer(item.dataset.moduleId)));
  $('#show-all-queue').textContent = showAll ? 'Collapse queue ↑' : 'View full queue →';
}

function renderDependencies() {
  const links = allModules.flatMap((module) => module.dependencyLinks);
  $('#dependency-count').textContent = `${links.length} direct links · ${links.filter((link) => link.status === 'resolved').length} resolved`;
  $('#dependency-map').innerHTML = links.map((link) => `<button class="dep-node ${link.status}" data-source-id="${escapeHtml(link.sourceModuleId)}"><span>${link.status.toUpperCase()} LINK</span><strong>${escapeHtml(dependencyLabel(link))}</strong><small>${escapeHtml(link.target?.type?.toUpperCase() ?? 'MISSING TARGET')} · ${escapeHtml(link.target?.platform?.toUpperCase() ?? 'VERIFY REFERENCE')}</small></button>`).join('');
  $('#dependency-map').querySelectorAll('.dep-node').forEach((node) => node.addEventListener('click', () => openDrawer(node.dataset.sourceId)));
}

function applyFilters() {
  currentModules = filterModules(allModules, {
    search: $('#search').value,
    severity: $('#severity-filter').value,
    patchStatus: $('#patch-filter').value,
    confidence: $('#confidence-filter').value,
    flagged: $('#flagged-filter').checked,
  });
  renderRows();
}

function openDrawer(moduleId) {
  const module = allModules.find((item) => item.id === moduleId);
  if (!module) {
    const metadata = dependencyModules.find((item) => item.id === moduleId);
    if (!metadata) return;
    const incoming = allModules.flatMap((item) => item.dependencyLinks).filter((link) => link.targetId === moduleId);
    showDrawer(`<h2 class="drawer-title">${escapeHtml(metadata.name)}</h2><div class="drawer-subtitle">${escapeHtml(metadata.id)}</div><section class="drawer-section"><h3>Local dependency metadata</h3><p>${escapeHtml(metadata.type)} · ${escapeHtml(metadata.platform)}. Metadata-only record, not ranked and never executed.</p></section><section class="drawer-section"><h3>Referenced by</h3>${incoming.map((link) => `<div class="dependency-link"><div><button class="metadata-link" data-record-id="${escapeHtml(link.sourceModuleId)}">${escapeHtml(allModules.find((item) => item.id === link.sourceModuleId).name)}</button><small>${escapeHtml(link.relation)}</small></div></div>`).join('')}</section>`);
    return;
  }
  const related = module.dependencyLinks ?? [];
  const confidence = module.priority.confidence;
  showDrawer(`<h2 class="drawer-title">${escapeHtml(module.name)}</h2><div class="drawer-subtitle">${escapeHtml(module.id)}<br />${escapeHtml(module.type.toUpperCase())} · ${escapeHtml(module.platform.toUpperCase())} · OWNER: ${escapeHtml(module.owner.toUpperCase())}</div>
    <div class="drawer-score"><div class="score-bubble">${module.priority.score}<small>PRIORITY</small></div><div class="score-copy"><strong>Review priority · ${module.severity.toUpperCase()}</strong><p>Conservative score combines maximum CVSS, prerequisites, patch status, and evidence confidence.</p></div></div>
    <section class="drawer-section"><h3>Score breakdown</h3><div class="score-breakdown"><div class="breakdown-item"><span>CVSS max</span><strong>${module.priority.cvssMax.toFixed(1)}</strong></div><div class="breakdown-item"><span>Exploitability</span><strong>+${module.priority.exploitability}</strong></div><div class="breakdown-item"><span>Confidence</span><strong>${confidence.score}</strong></div></div></section>
    <section class="drawer-section"><h3>Evidence trail</h3><div class="drawer-cards">${module.evidence.map((item) => `<div class="drawer-info-card"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.date)} · ${item.confidence}%</small></div><p>${escapeHtml(item.detail)}</p></div>`).join('')}</div></section>
    <section class="drawer-section"><h3>Resolved products</h3>${(module.resolvedProducts ?? []).map((product) => `<div class="product-resolution"><div class="product-row"><span>${escapeHtml(product.vendor)} · ${escapeHtml(product.name)}</span><b>${escapeHtml(product.versions)}</b></div><small>${escapeHtml(productResolutionLabel(product))}</small>${product.original?.name !== product.name || product.original?.vendor !== product.vendor ? `<small class="product-raw">Raw label: ${escapeHtml(product.original.vendor)} · ${escapeHtml(product.original.name)}</small>` : ''}</div>`).join('')}</section>
    <section class="drawer-section"><h3>Exploit prerequisites</h3><div class="prereq-list">${module.prerequisites.map((item) => `<span class="prereq">${escapeHtml(item)}</span>`).join('')}</div></section>
    <section class="drawer-section"><h3>Patch state confidence</h3><div class="action-card"><strong>${PATCH_LABELS[module.patchStatus.status]} · ${escapeHtml(module.patchStatus.eta)} · ${module.patchConfidence.score}/100 ${module.patchConfidence.label}</strong>${escapeHtml(module.patchStatus.note)}<ul class="reason-list">${module.patchConfidence.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div></section>
    <section class="drawer-section"><h3>Patch source observations</h3><div class="drawer-cards">${module.patchConfidence.evidence.map((item) => `<div class="drawer-info-card patch-observation"><strong>${escapeHtml(item.source)} · ${escapeHtml(item.status)} · ${item.confidence}/100</strong><small>${escapeHtml(item.date)}</small><p>${escapeHtml(item.detail)}</p></div>`).join('') || '<p>No explicit patch evidence supplied.</p>'}</div></section>
    <section class="drawer-section"><h3>CVSS source observations</h3><div class="drawer-cards">${module.cves.map((item) => `<div class="drawer-info-card"><strong>${escapeHtml(item.id)} · ${item.cvss} · ${escapeHtml(item.source)}</strong><p>${escapeHtml(item.vector)} · ${escapeHtml(item.published)}</p></div>`).join('')}</div></section>
    <section class="drawer-section"><h3>Advisory groups</h3><div class="drawer-cards">${module.advisoryGroups.map(advisoryMarkup).join('') || '<p>No advisory records attached.</p>'}</div></section>
    <section class="drawer-section"><h3>Direct dependency links</h3>${related.length ? related.map(dependencyMarkup).join('') : '<p>No declared dependencies.</p>'}</section>`);
}

function closeDrawer() {
  $('#detail-drawer').classList.remove('open');
  $('#detail-drawer').setAttribute('aria-hidden', 'true');
  $('#detail-drawer').inert = true;
  drawerTimer = setTimeout(() => { $('#drawer-backdrop').hidden = true; }, 250);
  previousFocus?.focus({ preventScroll: true });
}

function download(filename, content, type) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2600);
}

renderMetrics();
renderRows();
renderQueue();
renderDependencies();

['search', 'severity-filter', 'patch-filter', 'confidence-filter', 'flagged-filter'].forEach((id) => $(('#' + id)).addEventListener('input', applyFilters));
$('#clear-filters').addEventListener('click', () => { $('#search').value = ''; $('#severity-filter').value = 'all'; $('#patch-filter').value = 'all'; $('#confidence-filter').value = 'all'; $('#flagged-filter').checked = false; applyFilters(); });
$('#show-all-queue').addEventListener('click', (event) => { const showAll = event.currentTarget.textContent.includes('View'); renderQueue(showAll); });
$('#show-flagged').addEventListener('click', () => { $('#flagged-filter').checked = true; applyFilters(); document.querySelector('#modules').scrollIntoView({ behavior: 'smooth' }); });
$('#export-queue').addEventListener('click', () => { download('safe-remediation-queue.csv', exportQueueCsv(queue), 'text/csv'); showToast('CSV audit queue exported locally'); });
$('#export-report').addEventListener('click', () => { download('safe-remediation-queue.md', exportQueueMarkdown(queue), 'text/markdown'); showToast('Markdown audit report exported locally'); });
$('#close-drawer').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#drawer-content').addEventListener('click', (event) => {
  const link = event.target.closest('[data-record-id]');
  if (link) openDrawer(link.dataset.recordId);
});
document.addEventListener('keydown', (event) => {
  if (!$('#detail-drawer').classList.contains('open')) return;
  if (event.key === 'Escape') closeDrawer();
  if (event.key === 'Tab') {
    const controls = [...$('#detail-drawer').querySelectorAll('button, summary, [tabindex="0"]')].filter((control) => control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
