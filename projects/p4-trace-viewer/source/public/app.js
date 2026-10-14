import { derivePacketMetrics, normalizeTrace, packetEvents } from '../src/trace-model.mjs';
import { buildTraceView, exportViewReport } from '../src/trace-view.mjs';
import { buildPipelinePath, renderPipelinePath } from '../src/pipeline-path.mjs';

const $ = selector => document.querySelector(selector);
const state = { fixtures: null, traces: {}, selectedId: null, quickFilter: '', view: null };

const human = value => String(value ?? '').replaceAll('_', ' ');
const jsonValue = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function boot() {
  state.fixtures = await fetch('/fixtures.json').then(response => response.json());
  state.traces.traceA = normalizeTrace(state.fixtures.traceA);
  state.traces.traceB = normalizeTrace(state.fixtures.traceB);
  bindEvents();
  render();
}

function bindEvents() {
  ['trace-select', 'compare-select'].forEach(id => $(`#${id}`).addEventListener('input', render));
  ['query', 'outcome-filter', 'result-filter', 'table-filter', 'action-filter', 'delay-filter', 'reason-filter'].forEach(id => $(`#${id}`).addEventListener('input', render));
  document.querySelectorAll('[data-quick-filter]').forEach(button => button.addEventListener('click', () => applyQuickFilter(button.dataset.quickFilter)));
  $('#clear-filters').addEventListener('click', () => {
    state.quickFilter = '';
    ['query', 'outcome-filter', 'result-filter', 'table-filter', 'action-filter', 'delay-filter', 'reason-filter'].forEach(id => { $(`#${id}`).value = ''; });
    render();
  });
  $('#import-button').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const trace = normalizeTrace(JSON.parse(await file.text()));
      state.traces.imported = trace;
      if (!$('#trace-select option[value="imported"]')) $('#trace-select').add(new Option('imported · local file', 'imported'));
      $('#trace-select').value = 'imported';
      render();
    } catch (error) { window.alert(`Could not import trace: ${error.message}`); }
  });
  $('#export-button').addEventListener('click', () => {
    const trace = activeTrace();
    const blob = new Blob([exportViewReport(state.view)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${trace.traceId}-diagnostic-report.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function activeTrace() { return state.traces[$('#trace-select').value]; }
function comparisonTrace() { const value = $('#compare-select').value; return value === 'none' ? null : state.traces[value]; }

function currentFilters() {
  const filters = {
    query: $('#query').value,
    outcome: $('#outcome-filter').value,
    tableResult: $('#result-filter').value,
    table: $('#table-filter').value,
    action: $('#action-filter').value,
    minQueueDelayNs: $('#delay-filter').value === '' ? null : $('#delay-filter').value,
    dropReason: $('#reason-filter').value
  };
  return filters;
}

function applyQuickFilter(kind) {
  state.quickFilter = state.quickFilter === kind ? '' : kind;
  render();
}

function render() {
  const trace = activeTrace();
  refreshFilterOptions(trace);
  state.view = buildTraceView(trace, { filters: currentFilters(), diagnostic: state.quickFilter, selectedId: state.selectedId, comparisonTrace: comparisonTrace() });
  const packets = state.view.trace.packets;
  state.selectedId = state.view.selectedPacketId;
  document.querySelectorAll('[data-quick-filter]').forEach(button => {
    const active = button.dataset.quickFilter === state.quickFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderSummary(state.view.summary);
  renderList(packets);
  renderDetail(trace, packets.find(packet => packet.id === state.selectedId));
  renderComparison(trace, state.view.comparison);
  $('#export-scope').textContent = `Report: ${packets.length} visible packets${state.view.comparison ? ' + comparison' : ''}`;
  $('#trace-meta').textContent = `${trace.device} · ${trace.clockUnit} · ${trace.traceId}`;
}

function refreshFilterOptions(trace) {
  const setOptions = (id, values, placeholder) => {
    const select = $(`#${id}`);
    const current = select.value;
    select.replaceChildren(new Option(placeholder, ''), ...[...new Set(values)].sort().map(value => new Option(human(value), value)));
    if ([...select.options].some(option => option.value === current)) select.value = current;
  };
  setOptions('table-filter', trace.packets.flatMap(packet => packetEvents(packet, 'table').map(event => event.table)).filter(Boolean), 'All tables');
  setOptions('action-filter', trace.packets.flatMap(packet => packetEvents(packet, 'table').map(event => event.action)).filter(Boolean), 'All actions');
  setOptions('reason-filter', trace.packets.flatMap(packet => packetEvents(packet, 'drop').map(event => event.reason)).filter(Boolean), 'Any drop reason');
}

function renderSummary(summary) {
  const cards = [
    ['Packets', summary.packetCount, `${summary.outcomeCounts.forwarded} forwarded`],
    ['Dropped', summary.outcomeCounts.dropped, Object.entries(summary.dropsByReason).map(([reason, count]) => `${count} ${human(reason)}`).join(' · ') || 'no drops'],
    ['Table decisions', summary.tableHits + summary.tableMisses, `${summary.tableHits} hits · ${summary.tableMisses} misses`],
    ['Recirculated', summary.recirculatedPackets, 'second-pass paths'],
    ['Queue delay', `${summary.queueDelayNsTotal} ns`, `max ${summary.queueDelayNsMax} ns`]
  ];
  $('#summary').innerHTML = cards.map(([label, value, detail]) => `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><small>${escapeHtml(detail)}</small></div>`).join('');
}

function renderList(packets) {
  $('#packet-count').textContent = `${packets.length} packet${packets.length === 1 ? '' : 's'}`;
  $('#filter-count').textContent = packets.length ? 'FILTERED VIEW' : 'NO MATCHES';
  $('#packet-list').innerHTML = packets.length ? packets.map(packet => {
    const metrics = derivePacketMetrics(packet);
    const reason = metrics.dropReason ? ` · ${human(metrics.dropReason)}` : '';
    return `<button type="button" class="packet-item ${packet.id === state.selectedId ? 'selected' : ''}" data-packet-id="${escapeHtml(packet.id)}"><div class="packet-line"><span class="packet-id">${escapeHtml(packet.id)}</span><span class="status ${packet.outcome}">${packet.outcome}</span></div><div class="packet-meta"><span>in ${escapeHtml(packet.ingressPort ?? '—')} → ${metrics.outputPorts.length ? metrics.outputPorts.join(', ') : 'drop'}${escapeHtml(reason)}</span><span>${metrics.passCount} pass${metrics.passCount === 1 ? '' : 'es'}</span></div></button>`;
  }).join('') : '<div class="no-results">No packets match these filters.<br>Try widening the search or clearing a filter.</div>';
  document.querySelectorAll('.packet-item').forEach(item => item.addEventListener('click', () => { state.selectedId = item.dataset.packetId; render(); }));
}

function renderDetail(trace, packet) {
  if (!packet) { $('#empty-detail').hidden = false; $('#packet-detail').hidden = true; return; }
  $('#empty-detail').hidden = true; $('#packet-detail').hidden = false;
  const path = buildPipelinePath(packet);
  const metrics = path.metrics;
  $('#packet-detail').innerHTML = `<article class="detail-card"><div class="detail-head"><div><div class="detail-title">${escapeHtml(packet.id)} <span class="outcome-badge marker-${packet.outcome === 'dropped' ? 'drop' : 'tx'}">${packet.outcome}</span></div><div class="detail-subtitle">ingress port ${escapeHtml(packet.ingressPort ?? '—')} · ${escapeHtml(packet.length ?? '—')} bytes · ${escapeHtml(trace.traceId)}</div></div><div class="detail-summary"><div><strong>${metrics.passCount}</strong><span>passes</span></div><div><strong>${escapeHtml(path.queueLabel)}</strong><span>queue delay</span></div><div><strong>${packet.outputPorts.length ? packet.outputPorts.join(', ') : '—'}</strong><span>output port</span></div></div></div><div class="explanations" aria-label="Selected packet explanations">${path.explanations.map(text => `<p class="explanation">${escapeHtml(text)}</p>`).join('')}</div>${renderPipelinePath(path)}</article>`;
}

function renderComparison(left, comparison) {
  const target = $('#comparison-detail');
  if (!comparison) { target.hidden = true; return; }
  target.hidden = false;
  const rows = comparison.changes.map(change => `<h3 class="diff-packet">${escapeHtml(change.packetId)}</h3>${change.fields.map(field => `<div class="diff-row"><span class="diff-field">${escapeHtml(field)}</span><span class="before">${escapeHtml(jsonValue(change.before[field]))}</span><span class="diff-arrow">→</span><span class="after">${escapeHtml(jsonValue(change.after[field]))}</span></div>`).join('')}`);
  const missing = comparison.removedPacketIds.map(id => `<p class="comparison-missing">${escapeHtml(id)} · absent from comparison trace</p>`);
  target.innerHTML = `<article class="detail-card compare-panel"><div class="detail-head"><div><div class="detail-title">Comparison · ${escapeHtml(left.traceId)} vs ${escapeHtml(comparison.traceId)}</div><div class="detail-subtitle">Visible baseline IDs → counterparts · ${comparison.changedPacketIds.length} changed · ${comparison.unchangedPacketIds.length} unchanged · ${comparison.removedPacketIds.length} absent</div></div></div>${rows.length || missing.length ? `<div class="diff-list">${rows.join('')}${missing.join('')}</div>` : `<div class="no-change">${state.view.trace.packets.length ? 'No observable packet differences.' : 'No visible packets to compare.'}</div>`}</article>`;
}

boot().catch(error => { document.body.innerHTML = `<main><h1>Could not load local fixtures</h1><p>${escapeHtml(error.message)}</p></main>`; });
