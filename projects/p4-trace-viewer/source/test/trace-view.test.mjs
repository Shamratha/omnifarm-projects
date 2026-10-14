import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTraceView, exportViewReport } from '../src/trace-view.mjs';
import { compareTraces, explainPacket, filterPackets, normalizeTrace, queueDelayDetails, queueDelayNs } from '../src/trace-model.mjs';
import { buildPipelinePath } from '../src/pipeline-path.mjs';

const { traceA, traceB } = JSON.parse(await readFile(new URL('../public/fixtures.json', import.meta.url)));
const cases = [
  ['recirculated', 'p-recirculated'],
  ['table-miss', 'p-miss'],
  ['ttl-expiry', 'p-ttl'],
  ['queue-delay', 'p-forward']
];

for (const [diagnostic, id] of cases) {
  test(`${diagnostic}: list, summary, comparison, and diagnostic report share the same scope`, () => {
    const view = buildTraceView(traceA, { diagnostic, comparisonTrace: traceB });
    const text = exportViewReport(view);
    const report = JSON.parse(text);
    assert.deepEqual(view.trace.packets.map(packet => packet.id), [id]);
    assert.deepEqual(report.packets.map(packet => packet.id), [id]);
    assert.equal(view.summary.packetCount, 1);
    assert.equal(report.summary.packets, 1);
    assert.equal(report.selection.selectedPacketId, id);
    assert.deepEqual(report.comparison, view.comparison);
    assert.ok(report.packets[0].explanations.length);
    assert.ok(report.packets[0].pipeline.parsers.length);
    assert.equal(text, exportViewReport(view));
    assert.ok(text.endsWith('\n'));
  });
}

test('shortcuts intersect rather than override manual filters', () => {
  assert.equal(buildTraceView(traceA, { diagnostic: 'table-miss', filters: { tableResult: 'hit' } }).summary.packetCount, 0);
  assert.equal(buildTraceView(traceA, { diagnostic: 'ttl-expiry', filters: { dropReason: 'table_miss' } }).summary.packetCount, 0);
  assert.equal(buildTraceView(traceA, { diagnostic: 'recirculated', filters: { outcome: 'dropped' } }).summary.packetCount, 0);
  assert.equal(buildTraceView(traceA, { diagnostic: 'queue-delay', filters: { minQueueDelayNs: 150 } }).summary.packetCount, 1);
  assert.equal(buildTraceView(traceA, { diagnostic: 'queue-delay', filters: { minQueueDelayNs: 151 } }).summary.packetCount, 0);
});

test('table name and hit/miss result must refer to the same decision', () => {
  const trace = structuredClone(traceA);
  trace.packets[3].events[4].result = 'miss';
  assert.deepEqual(filterPackets(trace, { table: 'recirc_control', tableResult: 'miss' }), []);
  assert.equal(buildTraceView(trace, { diagnostic: 'table-miss', filters: { table: 'recirc_control' } }).summary.packetCount, 0);
});

test('empty views export zero totals, no hidden packets, and null selection', () => {
  const view = buildTraceView(traceA, { filters: { query: 'nothing-matches' }, selectedId: 'p-forward', comparisonTrace: traceB });
  const report = JSON.parse(exportViewReport(view));
  assert.deepEqual(report.packets, []);
  assert.deepEqual(report.tables, []);
  assert.equal(report.selection.selectedPacketId, null);
  assert.ok(Object.values(report.summary).every(value => value === 0));
  assert.deepEqual(report.comparison.changedPacketIds, []);
  assert.deepEqual(report.comparison.unchangedPacketIds, []);
});

test('reordered packets and filter keys produce byte-identical view reports', () => {
  const options = { filters: { query: 'p-', outcome: 'dropped' }, selectedId: 'p-ttl', comparisonTrace: traceB };
  const original = exportViewReport(buildTraceView(traceA, options));
  const reordered = { ...traceA, packets: [...traceA.packets].reverse() };
  const otherOrder = { ...options, filters: { outcome: 'dropped', query: 'p-' }, comparisonTrace: { ...traceB, packets: [...traceB.packets].reverse() } };
  assert.equal(exportViewReport(buildTraceView(reordered, otherOrder)), original);
  // Fallback selection is also stable without an explicit selected ID.
  assert.equal(exportViewReport(buildTraceView(reordered)), exportViewReport(buildTraceView(traceA)));
});

test('comparison detects second-pass table actions, parser states, and rewrites', () => {
  const alternate = structuredClone(traceA);
  alternate.traceId = 'second-pass-change';
  const events = alternate.packets[3].events;
  events[3].state = 'recirculate → parse_alt';
  events[4].action = 'set_alt_nhop';
  events[5].after = 6;
  const view = buildTraceView(traceA, { diagnostic: 'recirculated', comparisonTrace: alternate });
  assert.deepEqual(view.comparison.changedPacketIds, ['p-recirculated']);
  assert.deepEqual(view.comparison.changes[0].fields, ['parsers', 'tables', 'rewrites']);
});

test('recirculation is based on an event, including three-pass packets without a named action', () => {
  const recirculated = structuredClone(traceA.packets[3]);
  delete recirculated.events[1].action;
  recirculated.events.push({ t: 4100, pass: 2, kind: 'recirculate' });
  assert.equal(buildTraceView({ packets: [recirculated] }, { diagnostic: 'recirculated' }).summary.packetCount, 1);
});

test('missing counterparts are explicit and self-comparison is suppressed', () => {
  const missing = { ...traceB, packets: traceB.packets.filter(packet => packet.id !== 'p-miss') };
  assert.deepEqual(buildTraceView(traceA, { diagnostic: 'table-miss', comparisonTrace: missing }).comparison.removedPacketIds, ['p-miss']);
  assert.equal(buildTraceView(traceA, { comparisonTrace: traceA }).comparison, null);
  assert.deepEqual(compareTraces(missing, traceB).addedPacketIds, ['p-miss']);
});

test('queue matching sums multiple queues and ignores unmatched or negative intervals', () => {
  const events = [
    { kind: 'queue_dequeue', queue: 1, t: 0 },
    { kind: 'queue_enqueue', queue: 0, t: 10 },
    { kind: 'queue_enqueue', queue: 1, t: 20 },
    { kind: 'queue_dequeue', queue: 1, t: 50 },
    { kind: 'queue_dequeue', queue: 0, t: 70 },
    { kind: 'queue_enqueue', queue: 2, t: 100 },
    { kind: 'queue_dequeue', queue: 2, t: 90 }
  ];
  assert.equal(queueDelayNs({ events }), 90);
});

test('pipeline path gives selected trace markers, pass boundaries, paired queue evidence, and truthful explanations', () => {
  const forward = normalizeTrace(traceA).packets.find(packet => packet.id === 'p-forward');
  const path = buildPipelinePath(forward);
  assert.deepEqual(path.passes.map(pass => pass.pass), [0]);
  assert.deepEqual(path.nodes.filter(node => ['rewrite', 'queue_enqueue', 'queue_dequeue'].includes(node.kind)).map(node => node.tone), ['rewrite', 'rewrite', 'queue', 'queue']);
  assert.equal(path.nodes.find(node => node.kind === 'queue_dequeue').detail, 'Queue 0 · 1100 → 1250 ns = 150 ns');
  assert.equal(path.queueLabel, '150 ns');
  assert.match(path.explanations.join(' '), /150 ns.*measured interval/);

  const recirculated = normalizeTrace(traceA).packets.find(packet => packet.id === 'p-recirculated');
  const recircPath = buildPipelinePath(recirculated);
  assert.deepEqual(recircPath.passes.map(pass => pass.pass), [0, 1]);
  assert.equal(recircPath.nodes.find(node => node.kind === 'recirculate').tone, 'recirculate');
  assert.match(recircPath.nodes.find(node => node.kind === 'recirculate').detail, /Pass 0 → pass 1/);
  assert.match(recircPath.explanations.join(' '), /Recorded 1 recirculation/);
  assert.doesNotMatch(recircPath.explanations.join(' '), /terminal outcome is drop/);

  const miss = normalizeTrace(traceA).packets.find(packet => packet.id === 'p-miss');
  const ttl = normalizeTrace(traceA).packets.find(packet => packet.id === 'p-ttl');
  assert.equal(buildPipelinePath(miss).nodes.find(node => node.kind === 'drop').tone, 'drop');
  assert.match(buildPipelinePath(miss).nodes.find(node => node.kind === 'drop').detail, /table miss/);
  assert.match(explainPacket(ttl).join(' '), /IPv4 TTL rewrite reached zero/);
});

test('pipeline explanations distinguish missing drop and queue evidence', () => {
  const droppedWithoutEvent = normalizeTrace({ packets: [{ id: 'drop-unknown', outcome: 'dropped', outputPorts: [], events: [] }] }).packets[0];
  assert.match(explainPacket(droppedWithoutEvent).join(' '), /no drop event or reason/);

  const ttlWithoutRewrite = normalizeTrace({ packets: [{ id: 'ttl-unknown', outcome: 'dropped', outputPorts: [], events: [{ t: 1, pass: 0, kind: 'drop', reason: 'ttl_expired' }] }] }).packets[0];
  assert.match(explainPacket(ttlWithoutRewrite).join(' '), /no IPv4 TTL-to-zero rewrite/);

  const incomplete = normalizeTrace({ packets: [{ id: 'queue-incomplete', outcome: 'forwarded', outputPorts: [1], events: [
    { t: 10, pass: 0, kind: 'queue_enqueue', queue: 0 }
  ] }] }).packets[0];
  assert.deepEqual(queueDelayDetails(incomplete).matched, []);
  assert.equal(buildPipelinePath(incomplete).queueLabel, 'Not measured');
  assert.match(explainPacket(incomplete).join(' '), /Queue evidence is incomplete/);
  assert.match(buildPipelinePath(incomplete).nodes[0].detail, /delay unavailable/);

  const recircDrop = normalizeTrace({ packets: [{ id: 'recirc-drop', outcome: 'dropped', outputPorts: [], events: [
    { t: 1, pass: 0, kind: 'recirculate' },
    { t: 2, pass: 1, kind: 'drop', reason: 'policy' }
  ] }] }).packets[0];
  assert.match(explainPacket(recircDrop).join(' '), /terminal outcome is drop/);
  assert.doesNotMatch(explainPacket(recircDrop).join(' '), /before transmission/);
});

test('malformed imported traces fail clearly instead of producing ambiguous diagnostics', () => {
  assert.throws(() => normalizeTrace({}), /packets array/);
  assert.throws(() => normalizeTrace({ packets: [traceA.packets[0], traceA.packets[0]] }), /unique/);
  assert.throws(() => normalizeTrace({ ...traceA, clockUnit: 'ms' }), /nanosecond/);
  assert.throws(() => normalizeTrace({ packets: [{ id: 'bad', events: [{ t: 'invalid' }] }] }), /finite/);
});
