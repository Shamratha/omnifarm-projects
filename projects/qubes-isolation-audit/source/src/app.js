(function () {
  'use strict';

  const { analyzeFixture } = window.IsolationAudit;
  const { buildView, buildExportPayload, depthLabel } = window.AuditView;
  const { list: listFixtures, get: getFixture } = window.AuditFixtures;
  const state = { fixtureId: 'baseline-01', analysis: null, selectedId: 'work', evaluationId: null, filters: { query: '', type: 'all', firewall: 'all', issue: 'all' } };
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const qube = (id) => state.analysis.fixture.qubes.find((item) => item.id === id);
  const report = (id) => state.analysis.reportById.get(id);
  const view = () => buildView(state.analysis, state);

  function init() {
    const fixtureSelect = $('#fixture-select');
    fixtureSelect.innerHTML = listFixtures().map((fixture) => `<option value="${fixture.id}">${fixture.name}</option>`).join('');
    fixtureSelect.value = state.fixtureId;
    fixtureSelect.addEventListener('change', () => loadFixture(fixtureSelect.value));
    $('#search-input').addEventListener('input', (event) => { state.filters.query = event.target.value; renderInventory(); });
    $('#type-filter').addEventListener('change', (event) => { state.filters.type = event.target.value; renderInventory(); });
    $('#firewall-filter').addEventListener('change', (event) => { state.filters.firewall = event.target.value; renderInventory(); });
    $('#issue-filter').addEventListener('change', (event) => { state.filters.issue = event.target.value; renderInventory(); });
    $('#clear-filters').addEventListener('click', clearFilters);
    $('#export-json').addEventListener('click', exportJson);
    $('#export-csv').addEventListener('click', exportCsv);
    loadFixture(state.fixtureId);
  }

  function loadFixture(id) {
    state.fixtureId = id;
    state.analysis = analyzeFixture(getFixture(id));
    state.selectedId = state.analysis.fixture.qubes.some((item) => item.id === state.selectedId) ? state.selectedId : state.analysis.fixture.qubes[0]?.id;
    state.evaluationId = report(state.selectedId)?.evaluations[0]?.id || null;
    $('#fixture-select').value = id;
    $('#footer-fixture').textContent = state.analysis.fixture.id;
    renderAll();
  }

  function renderAll() {
    const fixture = state.analysis.fixture;
    const affected = state.analysis.summary.affected;
    $('#fixture-meta').innerHTML = `<strong>${escapeHtml(fixture.name)}</strong><br>${escapeHtml(fixture.description)}<br>snapshot ${escapeHtml(fixture.version)} · ${fixture.qubes.length} qubes analyzed`;
    $('#summary-grid').innerHTML = [
      ['TOTAL QUBES', state.analysis.summary.qubes, `${state.analysis.summary.appvms} AppVM · ${state.analysis.summary.templates} TemplateVM`, ''],
      ['TRUST DOMAINS', new Set(fixture.qubes.map((item) => item.trustDomain)).size, 'isolated label groups', 'lime'],
      ['NETWORK PATHS', fixture.qubes.filter((item) => item.netvmId).length, `${fixture.qubes.filter((item) => item.providesNetwork).length} providers in fixture`, ''],
      ['POLICY FINDINGS', state.analysis.summary.violations, `${affected} qubes affected · high signal`, state.analysis.summary.violations ? 'red' : 'lime'],
    ].map(([label, value, note, tone]) => `<div class="summary-card"><div class="card-label">${label}</div><div class="card-value ${tone}">${value}</div><div class="card-note">${note}</div></div>`).join('');
    renderGraph();
    renderDetail();
    renderInventory();
  }

  function renderGraph() {
    const svg = $('#graph');
    const graph = view().graph;
    svg.setAttribute('viewBox', `0 0 ${graph.width} ${graph.height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    $('#graph-context').innerHTML = `<div><strong>TEMPLATE DEPTH</strong> ${escapeHtml(graph.chainLabel || 'none')} ${graph.resolved ? '' : '<span class="warning-text">· unresolved / provisional</span>'}</div><div>${escapeHtml(graph.requestLabel)}</div>`;
    const positions = new Map(graph.nodes.map((node) => [node.qubeId, node.position]));
    const nodeWidth = 142;
    const nodeHeight = 61;
    const edgeMarkup = graph.edges.map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const forward = to.x >= from.x;
      const startX = from.x + (forward ? nodeWidth : 0);
      const startY = from.y + nodeHeight / 2;
      const endX = to.x + (forward ? 0 : nodeWidth);
      const endY = to.y + nodeHeight / 2;
      const bend = (startX + endX) / 2;
      const invalid = edge.violationCodes.length > 0;
      const color = invalid || edge.routeStatus === 'blocked' ? '#f27e7e' : edge.routeStatus === 'allowed' ? '#c7ef70' : edge.type === 'template' ? '#bb9cf1' : '#69d6ca';
      const classes = `edge ${edge.type === 'netvm' ? 'net' : 'template'} ${edge.selectedTemplate ? 'selected-chain' : ''} route-${edge.routeStatus} ${invalid ? 'violation' : ''}`;
      const route = edge.from === edge.to ? `M ${from.x + 80} ${from.y} C ${from.x + 180} ${from.y - 45}, ${from.x + 180} ${from.y + 95}, ${from.x + 142} ${startY}` : `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`;
      const title = `${edge.from} → ${edge.to}: ${edge.label}${invalid ? ` (${edge.violationCodes.join(', ')})` : ''}`;
      return `<g data-edge-from="${escapeHtml(edge.from)}" data-edge-to="${escapeHtml(edge.to)}"><title>${escapeHtml(title)}</title><path class="${classes}" d="${route}" marker-end="url(#arrow-${color.slice(1)})"></path><text class="edge-label ${edge.selectedTemplate ? 'selected-chain' : ''} ${invalid || edge.routeStatus === 'blocked' ? 'blocked' : ''}" text-anchor="middle" x="${bend}" y="${(startY + endY) / 2 - 7}">${escapeHtml(edge.label)}</text></g>`;
    }).join('');
    const nodesMarkup = graph.nodes.map((item) => {
      const pos = item.position;
      const role = item.type === 'TemplateVM' ? 'template' : item.type === 'NetVM' ? 'net' : 'app';
      const status = item.missing ? 'missing reference' : item.templateDepth !== null ? `${item.templateDepth === 0 ? 'selected' : 'ancestor'} · depth ${item.templateDepth}` : item.routeStatus === 'structural' ? item.trustDomain : item.routeStatus;
      return `<g class="graph-node ${role} ${item.issueCount ? 'issue' : ''} ${item.selected ? 'selected' : ''} ${item.templateDepth > 0 ? 'ancestor' : ''} route-${item.routeStatus} ${item.missing ? 'missing' : ''}" data-id="${escapeHtml(item.qubeId)}" ${item.missing ? '' : 'tabindex="0" role="button"'} aria-label="${item.missing ? 'Missing' : 'Inspect'} ${escapeHtml(item.name)}; ${escapeHtml(status)}" transform="translate(${pos.x},${pos.y})"><rect width="${nodeWidth}" height="${nodeHeight}" rx="2"></rect><circle class="node-indicator" cx="16" cy="19" r="6"></circle><text class="node-name" x="29" y="18">${escapeHtml(item.name)}</text><text class="node-type" x="29" y="33">${escapeHtml(item.type)}</text><text class="node-status" x="12" y="49">${escapeHtml(status)}</text>${item.issueCount ? '<text x="128" y="13" fill="#f27e7e" font-size="10">!</text>' : ''}</g>`;
    }).join('');
    const markers = ['#bb9cf1', '#69d6ca', '#f27e7e', '#c7ef70'].map((color) => `<marker id="arrow-${color.slice(1)}" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="${color}" stroke-width="1"></path></marker>`).join('');
    svg.innerHTML = `<defs>${markers}</defs>${edgeMarkup}${nodesMarkup}`;
    svg.querySelectorAll('.graph-node:not(.missing)').forEach((node) => {
      node.addEventListener('click', () => selectQube(node.dataset.id));
      node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectQube(node.dataset.id); } });
    });
  }

  function selectQube(id) {
    if (!qube(id)) return;
    state.selectedId = id;
    state.evaluationId = report(id)?.evaluations[0]?.id || null;
    renderGraph();
    renderDetail();
    document.querySelectorAll('#inventory-body tr').forEach((row) => row.classList.toggle('selected', row.dataset.id === id));
  }

  function renderDetail() {
    const item = view().detail;
    if (!item) { $('#detail-panel').innerHTML = '<div class="empty-detail"><strong>No qube selected</strong>Select a node or row to inspect the effective policy.</div>'; return; }
    const typeClass = item.type === 'TemplateVM' ? 'template' : item.type === 'NetVM' ? 'net' : '';
    const marker = item.type === 'TemplateVM' ? 'T' : item.type === 'NetVM' ? 'N' : 'A';
    const chain = item.chain.map((entry, index) => `<span class="chain-item ${index === 0 ? 'current' : ''}">${escapeHtml(entry.name)} <small>depth ${entry.depth}</small></span>${index < item.chain.length - 1 ? '<span class="chain-arrow">→</span>' : ''}`).join('');
    const path = item.network.path.map((entry, index) => `<span class="path-pill">${escapeHtml(entry.name)}</span>${index < item.network.path.length - 1 ? '<span class="path-arrow">→</span>' : ''}`).join('');
    const fields = item.fields.map((field) => `<div class="provenance-row"><div class="detail-key">${escapeHtml(field.key)}</div><div><div class="detail-value">${escapeHtml(field.displayValue)}</div><div class="rule-meta">${escapeHtml(field.sourceLabel)}</div></div></div>`).join('');
    const diagnostics = item.diagnostics.map((entry) => `<div class="finding"><strong>${escapeHtml(entry.code)}</strong>${escapeHtml(entry.message)} Values below are provisional, not a trusted resolved policy.</div>`).join('');
    const findings = item.findings.length ? item.findings.map((finding) => `<div class="finding"><div class="finding-heading"><strong>${escapeHtml(finding.code)}</strong><span>${escapeHtml(finding.severity)}</span></div>${escapeHtml(finding.message)}${finding.evaluationId ? `<button type="button" class="finding-link" data-evaluation="${escapeHtml(finding.evaluationId)}">Trace this request in the graph →</button>` : ''}</div>`).join('') : '<div class="finding clean"><strong>PASS</strong>No fixture policy violations detected. Untested requests are not proven allowed.</div>';
    const policy = item.firewall;
    const rules = policy.available ? policy.rules.map((rule) => `<div class="firewall-row ${rule.enabled === false ? 'disabled-rule' : ''}"><div><div class="rule-name">${rule._index + 1}. ${escapeHtml(rule.label || rule.id)}</div><div class="rule-meta">${escapeHtml(rule.protocol || 'any')} · ${escapeHtml(rule.destination || 'any')} · port ${escapeHtml(rule.port ?? 'any')}</div><div class="rule-meta">${escapeHtml(rule._sourceName)} · ${escapeHtml(depthLabel(rule._depth))}</div></div><span class="decision ${rule.enabled === false ? 'none' : rule.action}">${rule.enabled === false ? 'disabled' : rule.action}</span></div>`).join('') || '<p class="rule-meta">Empty rule list; explicit default applies.</p>' : '<p class="rule-meta">No effective firewall policy.</p>';
    const defaultNote = policy.defaultSource ? `<p class="policy-note">Default ${escapeHtml(policy.default)} from ${escapeHtml(policy.defaultSource.qubeName)} · ${escapeHtml(depthLabel(policy.defaultSource.depth))}. Rules use first match.</p>` : '';
    const layering = policy.sources.map((source) => `${source.qubeName}: ${source.mode} (${source.ruleCount})`).join(' → ');
    const options = item.evaluations.map((evaluation) => `<option value="${escapeHtml(evaluation.id)}" ${evaluation.id === item.selectedEvaluation?.id ? 'selected' : ''}>${escapeHtml(evaluation.label)} · ${evaluation.result.decision}</option>`).join('');
    const sampleSelector = options ? `<label class="sample-selector">REQUEST TO TRACE<select id="sample-select">${options}</select></label>` : '<p class="policy-note">No sample requests configured. A default policy does not prove connectivity.</p>';
    $('#detail-panel').innerHTML = `
      <div class="detail-header"><div class="detail-type ${typeClass}">${marker}</div><div><div class="detail-name">${escapeHtml(item.name)}</div><div class="detail-sub">${escapeHtml(item.qubeId)} · ${escapeHtml(item.trustDomain)} domain</div></div><div class="detail-status ${item.issueCount ? '' : 'clean'}">${item.issueCount ? `${item.issueCount} finding${item.issueCount > 1 ? 's' : ''}` : 'clean'}</div></div>
      <div class="detail-body">
        <section class="detail-section"><div class="detail-section-title">TRANSITIVE TEMPLATE RESOLUTION <span class="section-note">${Math.max(0, item.depth)} inherited hops</span></div><div class="chain">${chain}</div><p class="policy-note">Selected → root. Resolve root → selected; nearer values override ancestors. Network routing is not inherited.</p>${diagnostics}</section>
        <section class="detail-section"><div class="detail-section-title">${item.resolved ? 'EFFECTIVE' : 'PROVISIONAL'} CONFIGURATION / SOURCE</div>${fields || '<p class="rule-meta">No explicit configuration fields.</p>'}</section>
        <section class="detail-section"><div class="detail-section-title">VIOLATION EXPLANATION</div>${findings}</section>
        <section class="detail-section"><div class="detail-section-title">EVALUATED REQUESTS / PATH EVIDENCE</div>${sampleSelector}${renderEvaluation(item.selectedEvaluation)}</section>
        <section class="detail-section"><div class="detail-section-title">NETWORK ROUTE / DEPENDENCY ONLY</div><div class="path-list">${path}</div><p class="policy-note">${item.network.path.length < 2 && !qube(item.qubeId).providesNetwork ? 'Offline / no NetVM.' : 'An edge is not permission. Only path-scoped samples evaluate every hop.'}</p>${item.network.diagnostics.map((entry) => `<p class="warning-text">${escapeHtml(entry.message)}</p>`).join('')}</section>
        <section class="detail-section"><div class="detail-section-title">${policy.resolved ? 'EFFECTIVE' : 'PROVISIONAL'} FIREWALL / ORDERED RULES</div>${defaultNote}<p class="policy-note">${escapeHtml(layering || 'No inheritance layers')}</p>${rules}</section>
      </div>`;
    $('#sample-select')?.addEventListener('change', (event) => selectEvaluation(event.target.value));
    $('#detail-panel').querySelectorAll('[data-evaluation]').forEach((button) => button.addEventListener('click', () => selectEvaluation(button.dataset.evaluation)));
  }

  function selectEvaluation(id) {
    state.evaluationId = id;
    renderGraph();
    renderDetail();
  }

  function renderEvaluation(evaluation) {
    if (!evaluation) return '';
    const { request, result, localResult } = evaluation;
    const ruleEvidence = (rule) => rule ? `${rule.id} from ${rule._sourceName} (${depthLabel(rule._depth)})` : 'no matching rule';
    const steps = (result.steps || []).map((step) => `<li class="hop-result ${step.status === 'unreachable' ? 'unreachable' : step.decision}"><div class="hop-heading"><strong>${escapeHtml(step.qubeName)}</strong><span>${step.status === 'unreachable' ? 'not reached' : step.status === 'pass-through' ? 'pass-through' : step.decision}</span></div><p>${escapeHtml(step.reason)}</p>${step.matchedRule ? `<p class="rule-meta">${escapeHtml(ruleEvidence(step.matchedRule))}</p>` : ''}${step.trace.length ? `<details><summary>Rule trace (${step.trace.length})</summary>${step.trace.map((entry) => `<div class="rule-meta">${escapeHtml(entry.ruleId)}: ${escapeHtml(entry.result)} · ${escapeHtml(entry.reason)}</div>`).join('')}</details>` : ''}</li>`).join('');
    const localTrace = evaluation.scope === 'firewall' ? `<p class="policy-note">Local policy only — no network reachability claim.</p><details><summary>Rule trace (${result.trace.length})</summary>${result.trace.map((entry) => `<div class="rule-meta">${escapeHtml(entry.ruleId)}: ${escapeHtml(entry.result)} · ${escapeHtml(entry.reason)}</div>`).join('')}</details>` : '';
    return `<div class="evaluation-card"><div class="evaluation-heading"><span class="decision ${result.decision}">${evaluation.scope === 'path' ? 'path' : 'local'} ${result.decision === 'none' ? 'inconclusive' : result.decision}</span><span class="rule-meta">expected ${escapeHtml(evaluation.expected ?? 'unspecified')}</span></div><p class="request-address">${escapeHtml(request.protocol || 'tcp')} → ${escapeHtml(request.destinationIp)}:${escapeHtml(request.port ?? 'any')}</p><p class="policy-note">Source-only decision: ${localResult.decision}. ${escapeHtml(localResult.reason)} ${escapeHtml(ruleEvidence(localResult.matchedRule))}.</p>${evaluation.scope === 'path' ? '<p class="policy-note">Fixture simulation only. Requests stay unchanged at each hop; pass-through is an explicit fixture assumption.</p>' : ''}<p class="${result.decision === 'allow' ? 'policy-note' : 'warning-text'}">${escapeHtml(result.reason)}</p>${steps ? `<ol class="hop-results">${steps}</ol>` : localTrace}</div>`;
  }

  function renderInventory() {
    const rows = view().inventory;
    $('#result-count').textContent = `${rows.length} of ${state.analysis.fixture.qubes.length} visible`;
    $('#inventory-body').innerHTML = rows.length ? rows.map((item) => {
      const role = item.type === 'TemplateVM' ? 'template' : item.type === 'NetVM' ? 'net' : 'app';
      const decisions = item.firewall.groups.map((group) => `<span class="fw-badge ${group.decision}">${escapeHtml(group.label)}</span>`).join('<br>');
      return `<tr data-id="${escapeHtml(item.qubeId)}" tabindex="0" aria-label="Inspect ${escapeHtml(item.name)}" class="${item.qubeId === state.selectedId ? 'selected' : ''}"><td><div class="qube-cell"><i class="qube-dot ${role}"></i><div><div class="qube-name">${escapeHtml(item.name)}</div><div class="qube-id">${escapeHtml(item.qubeId)}</div></div></div></td><td><span class="type-chip">${escapeHtml(item.type)}</span></td><td><span class="domain">${escapeHtml(item.trustDomain)}</span></td><td><span class="inheritance">${escapeHtml(item.templateText)}${item.templateDepth > 0 ? `<span class="depth">· ${item.templateDepth} deep</span>` : ''}</span>${item.templateResolved ? '' : '<div class="warning-text">unresolved</div>'}</td><td><span class="network">${escapeHtml(item.networkText)}</span>${item.networkResolved ? '' : '<div class="warning-text">unresolved route</div>'}</td><td>${decisions || '<span class="fw-badge none">not evaluated</span>'}<div class="rule-meta">${escapeHtml(item.firewall.defaultLabel)}</div></td><td><span class="posture-badge ${item.issueCount ? 'issue' : 'clean'}"><span></span>${item.issueCount ? `${item.issueCount} finding${item.issueCount > 1 ? 's' : ''}` : 'within policy'}</span></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="no-results">No qubes match the active filters. <button class="clear-filters" type="button" onclick="window.clearAuditFilters()">Clear filters</button></td></tr>';
    document.querySelectorAll('#inventory-body tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => selectQube(row.dataset.id));
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectQube(row.dataset.id); } });
    });
  }

  function clearFilters() {
    state.filters = { query: '', type: 'all', firewall: 'all', issue: 'all' };
    $('#search-input').value = '';
    $('#type-filter').value = 'all'; $('#firewall-filter').value = 'all'; $('#issue-filter').value = 'all';
    renderInventory();
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const toast = $('#toast'); toast.textContent = `Saved ${filename}`; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2300);
  }

  function exportJson() {
    const payload = buildExportPayload(state.analysis, state);
    download(JSON.stringify(payload, null, 2), `${state.fixtureId}-audit.json`, 'application/json');
  }

  function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
  function exportCsv() {
    const rows = view().inventory;
    const header = ['Qube', 'Type', 'Trust domain', 'Template inheritance', 'Template depth', 'Template resolved', 'Network route', 'Sample results', 'Default policy', 'Posture'];
    const lines = [header, ...rows.map((item) => [item.name, item.type, item.trustDomain, item.templateText, item.templateDepth, item.templateResolved, item.networkText, item.firewall.label, item.firewall.defaultLabel, item.issueCount ? `${item.issueCount} findings` : 'within policy'])].map((row) => row.map(csvCell).join(','));
    download(lines.join('\n'), `${state.fixtureId}-inventory.csv`, 'text/csv');
  }

  window.clearAuditFilters = clearFilters;
  document.addEventListener('DOMContentLoaded', init);
}());
