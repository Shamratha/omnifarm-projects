import { compareTraces, exportReport, filterPackets, normalizeTrace, summarize } from './trace-model.mjs';

// Shortcuts intersect with manual filters; clicking the active shortcut clears it.
export const diagnosticFilters = Object.freeze({
  recirculated: { recirculated: true },
  'table-miss': { tableResult: 'miss' },
  'ttl-expiry': { dropReason: 'ttl_expired' },
  'queue-delay': { minQueueDelayNs: 1 }
});

export function buildTraceView(traceInput, { filters = {}, diagnostic = '', selectedId = null, comparisonTrace = null } = {}) {
  const trace = normalizeTrace(traceInput);
  const shortcut = diagnosticFilters[diagnostic] ?? {};
  const effectiveFilters = { ...shortcut, ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '' && value != null)) };
  // A user-specified queue threshold may narrow the positive-delay shortcut.
  if (diagnostic === 'queue-delay') effectiveFilters.minQueueDelayNs = Math.max(1, Number(filters.minQueueDelayNs) || 0);
  // Apply both predicates, rather than overwriting a contradictory manual
  // table-result/drop-reason filter with the shortcut.
  const matchingManual = filterPackets(trace, filters);
  const matchingBoth = filterPackets({ ...trace, packets: matchingManual }, shortcut);
  const packets = filterPackets({ ...trace, packets: matchingBoth }, effectiveFilters);
  const visibleTrace = { ...trace, packets };
  const packetIds = new Set(packets.map(packet => packet.id));
  const selectedPacketId = packetIds.has(selectedId) ? selectedId : [...packetIds].sort()[0] ?? null;
  const other = comparisonTrace ? normalizeTrace(comparisonTrace) : null;
  // Filter the baseline only, then compare counterparts by ID even if their
  // outcome/condition changed. Filtered-out baseline IDs never enter the diff.
  const comparison = other && other.traceId !== trace.traceId ? {
    traceId: other.traceId,
    ...compareTraces(visibleTrace, { ...other, packets: other.packets.filter(packet => packetIds.has(packet.id)) })
  } : null;
  return {
    trace: visibleTrace,
    filters: effectiveFilters,
    diagnostic,
    selectedPacketId,
    summary: summarize(visibleTrace),
    comparison
  };
}

export function exportViewReport(view) {
  const report = JSON.parse(exportReport(view.trace));
  // Metadata describes the exact view being exported, not wall-clock state.
  report.selection = {
    diagnostic: view.diagnostic,
    filters: Object.fromEntries(Object.entries(view.filters)
      .filter(([, value]) => value !== '' && value != null)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    selectedPacketId: view.selectedPacketId
  };
  if (view.comparison) report.comparison = view.comparison;
  return `${JSON.stringify(report, null, 2)}\n`;
}
