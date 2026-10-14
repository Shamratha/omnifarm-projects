import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareTraces, derivePacketMetrics, exportReport, filterPackets, normalizeTrace, summarize } from '../src/trace-model.mjs';
import { buildTraceView, exportViewReport } from '../src/trace-view.mjs';

const fixtures = JSON.parse(await readFile(new URL('../public/fixtures.json', import.meta.url)));
const traceA = normalizeTrace(fixtures.traceA);
const traceB = normalizeTrace(fixtures.traceB);
const packet = id => traceA.packets.find(item => item.id === id);

test('normalizes bundled local trace and derives queue delay', () => {
  assert.equal(traceA.packets.length, 4);
  assert.equal(packet('p-forward').events[0].state, 'start → parse_ipv4');
  assert.deepEqual(derivePacketMetrics(packet('p-forward')), {
    passCount: 1, queueDelayNs: 150, tableHits: 1, tableMisses: 0,
    rewriteCount: 2, actionNames: ['set_nhop'], dropReason: null, outputPorts: [2]
  });
});

test('explains recirculation as two pipeline passes', () => {
  const metrics = derivePacketMetrics(packet('p-recirculated'));
  assert.equal(metrics.passCount, 2);
  assert.deepEqual(metrics.actionNames, ['recirculate', 'set_nhop']);
  assert.deepEqual(metrics.outputPorts, [4]);
});

test('detects table miss drop and TTL expiry drop', () => {
  assert.equal(derivePacketMetrics(packet('p-miss')).dropReason, 'table_miss');
  assert.equal(derivePacketMetrics(packet('p-miss')).tableMisses, 1);
  assert.equal(derivePacketMetrics(packet('p-ttl')).dropReason, 'ttl_expired');
  assert.equal(derivePacketMetrics(packet('p-ttl')).rewriteCount, 1);
});

test('filters packets by outcome, table result, action, pass count, and queue delay', () => {
  assert.deepEqual(filterPackets(traceA, { outcome: 'dropped' }).map(item => item.id), ['p-miss', 'p-ttl']);
  assert.deepEqual(filterPackets(traceA, { tableResult: 'miss' }).map(item => item.id), ['p-miss']);
  assert.deepEqual(filterPackets(traceA, { action: 'recirculate' }).map(item => item.id), ['p-recirculated']);
  assert.deepEqual(filterPackets(traceA, { passCount: 2 }).map(item => item.id), ['p-recirculated']);
  assert.deepEqual(filterPackets(traceA, { minQueueDelayNs: 100 }).map(item => item.id), ['p-forward']);
  assert.deepEqual(filterPackets(traceA, { minQueueDelayNs: 151 }), []);
});

test('isolates the four diagnostic conditions and exports only the visible selection', () => {
  assert.deepEqual(filterPackets(traceA, { recirculated: true }).map(item => item.id), ['p-recirculated']);
  assert.deepEqual(filterPackets(traceA, { tableResult: 'miss' }).map(item => item.id), ['p-miss']);
  assert.deepEqual(filterPackets(traceA, { dropReason: 'ttl_expired' }).map(item => item.id), ['p-ttl']);
  const delayed = filterPackets(traceA, { minQueueDelayNs: 1 });
  assert.deepEqual(delayed.map(item => item.id), ['p-forward']);

  const report = JSON.parse(exportReport(traceA, delayed));
  assert.equal(report.summary.packets, 1);
  assert.equal(report.summary.queueDelayNsTotal, 150);
  assert.deepEqual(report.packets.map(item => item.id), ['p-forward']);
});

test('compares only packets visible in the scoped views', () => {
  const left = filterPackets(traceA, { tableResult: 'miss' });
  const right = traceB.packets.filter(item => new Set(left.map(packet => packet.id)).has(item.id));
  const comparison = compareTraces(traceA, traceB, { leftPackets: left, rightPackets: right });
  assert.deepEqual(comparison.changedPacketIds, ['p-miss']);
  assert.deepEqual(comparison.changes[0].fields, ['outcome', 'outputPorts', 'tables', 'rewrites', 'dropReason']);
  assert.deepEqual(comparison.removedPacketIds, []);
  assert.deepEqual(comparison.addedPacketIds, []);
});

test('regression: a diagnostic view exports exactly the visible packets and selected packet', () => {
  const view = buildTraceView(traceA, {
    diagnostic: 'table-miss',
    selectedId: 'p-forward',
    comparisonTrace: traceB
  });
  const report = JSON.parse(exportViewReport(view));
  assert.deepEqual(view.trace.packets.map(item => item.id), ['p-miss']);
  assert.equal(view.selectedPacketId, 'p-miss');
  assert.deepEqual(report.packets.map(item => item.id), ['p-miss']);
  assert.equal(report.summary.packets, 1);
  assert.equal(report.selection.diagnostic, 'table-miss');
  assert.equal(report.selection.filters.tableResult, 'miss');
  assert.equal(report.selection.selectedPacketId, 'p-miss');
  assert.ok(report.comparison);
  assert.deepEqual(report.comparison.changedPacketIds, ['p-miss']);
  assert.doesNotMatch(JSON.stringify(report), /p-forward|p-ttl|p-recirculated/);
});

test('summarizes pipeline outcomes deterministically', () => {
  assert.deepEqual(summarize(traceA), {
    packetCount: 4, outcomeCounts: { forwarded: 2, dropped: 2 }, recirculatedPackets: 1,
    tableHits: 4, tableMisses: 1, queueDelayNsTotal: 150, queueDelayNsMax: 150,
    dropsByReason: { table_miss: 1, ttl_expired: 1 },
    tables: { ipv4_lpm: { hits: 3, misses: 1 }, recirc_control: { hits: 1, misses: 0 } },
    actions: { set_nhop: 2, decrement_ttl: 1, recirculate: 1 }
  });
});

test('compares stable packet IDs across traces', () => {
  const comparison = compareTraces(traceA, traceB);
  assert.deepEqual(comparison.addedPacketIds, []);
  assert.deepEqual(comparison.removedPacketIds, []);
  assert.deepEqual(comparison.unchangedPacketIds, ['p-recirculated', 'p-ttl']);
  assert.deepEqual(comparison.changedPacketIds, ['p-forward', 'p-miss']);
  assert.equal(comparison.changes[0].packetId, 'p-forward');
  assert.equal(comparison.changes[0].before.queueDelayNs, 150);
  assert.equal(comparison.changes[0].after.queueDelayNs, 50);
});

test('exports input-order-independent deterministic report', () => {
  const report = exportReport(traceA);
  const reordered = normalizeTrace({ ...traceA, packets: [...traceA.packets].reverse() });
  assert.equal(exportReport(reordered), report);
  assert.match(report, /"traceId": "trace-a"/);
  assert.doesNotMatch(report, /generatedAt|random|uuid/i);
  assert.match(report, /"queueDelayNs": 150/);
});
