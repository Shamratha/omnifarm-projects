const asArray = value => Array.isArray(value) ? value : [];

export function normalizeTrace(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Trace must be an object');
  if (!Array.isArray(input.packets)) throw new TypeError('Trace must contain a packets array');
  const trace = {
    schemaVersion: input.schemaVersion ?? 1,
    traceId: String(input.traceId ?? 'local-trace'),
    device: String(input.device ?? 'bmv2-simple_switch'),
    clockUnit: String(input.clockUnit ?? 'ns'),
    packets: input.packets.map((packet, index) => ({
      id: String(packet.id ?? `packet-${index + 1}`),
      ingressPort: packet.ingressPort ?? null,
      length: packet.length ?? null,
      outcome: packet.outcome === 'dropped' ? 'dropped' : 'forwarded',
      outputPorts: asArray(packet.outputPorts).map(Number),
      events: asArray(packet.events).map((event, eventIndex) => ({
        ...event,
        t: Number(event.t ?? eventIndex),
        pass: Number(event.pass ?? 0),
        kind: String(event.kind ?? 'event')
      }))
    }))
  };
  if (trace.schemaVersion !== 1 || trace.clockUnit !== 'ns') throw new TypeError('Expected schemaVersion 1 and nanosecond (ns) timestamps');
  const ids = new Set();
  for (const packet of trace.packets) {
    if (!packet.id.trim() || ids.has(packet.id)) throw new TypeError('Packet IDs must be nonempty and unique within a trace');
    ids.add(packet.id);
    let lastTime = -Infinity;
    for (const event of packet.events) {
      if (!Number.isFinite(event.t) || event.t < lastTime || !Number.isInteger(event.pass) || event.pass < 0) {
        throw new TypeError('Events need finite, chronological timestamps and nonnegative integer passes');
      }
      lastTime = event.t;
    }
  }
  return trace;
}

export function packetEvents(packet, kind) {
  return packet.events.filter(event => !kind || event.kind === kind);
}

export function queueDelayNs(packet) {
  return queueDelayDetails(packet).totalNs;
}

export function queueDelayDetails(packet) {
  const pending = new Map();
  const matched = [];
  const unmatchedEnqueues = [];
  const unmatchedDequeues = [];
  for (const [index, event] of packetEvents(packet).entries()) {
    if (event.kind === 'queue_enqueue') {
      const queue = String(event.queue ?? 'default');
      const values = pending.get(queue) ?? [];
      values.push({ index, event });
      pending.set(queue, values);
    }
    if (event.kind === 'queue_dequeue') {
      const queue = String(event.queue ?? 'default');
      const values = pending.get(queue) ?? [];
      const enqueue = values.shift();
      if (!enqueue) {
        unmatchedDequeues.push({ index, queue, dequeueT: event.t });
      } else if (event.t >= enqueue.event.t) {
        matched.push({
          queue,
          enqueueIndex: enqueue.index,
          dequeueIndex: index,
          enqueueT: enqueue.event.t,
          dequeueT: event.t,
          delayNs: event.t - enqueue.event.t
        });
      } else {
        unmatchedEnqueues.push({ index: enqueue.index, queue, enqueueT: enqueue.event.t });
        unmatchedDequeues.push({ index, queue, dequeueT: event.t });
      }
      pending.set(queue, values);
    }
  }
  for (const values of pending.values()) {
    for (const { index, event } of values) unmatchedEnqueues.push({ index, queue: String(event.queue ?? 'default'), enqueueT: event.t });
  }
  return {
    matched,
    unmatchedEnqueues,
    unmatchedDequeues,
    totalNs: matched.reduce((total, interval) => total + interval.delayNs, 0)
  };
}

export function derivePacketMetrics(packetInput) {
  const packet = packetInput.events ? packetInput : normalizeTrace({ packets: [packetInput] }).packets[0];
  const tables = packetEvents(packet, 'table');
  const rewrites = packetEvents(packet, 'rewrite');
  const passes = packet.events.length ? Math.max(...packet.events.map(event => event.pass ?? 0)) + 1 : 0;
  const drop = packetEvents(packet, 'drop')[0];
  return {
    passCount: passes,
    queueDelayNs: queueDelayNs(packet),
    tableHits: tables.filter(event => event.result === 'hit').length,
    tableMisses: tables.filter(event => event.result === 'miss').length,
    rewriteCount: rewrites.length,
    actionNames: tables.filter(event => event.action).map(event => event.action),
    dropReason: drop?.reason ?? null,
    outputPorts: [...packet.outputPorts]
  };
}

export function summarize(traceInput) {
  const trace = normalizeTrace(traceInput);
  const metrics = trace.packets.map(derivePacketMetrics);
  const tables = {};
  const actions = {};
  const dropsByReason = {};
  for (const packet of trace.packets) {
    for (const event of packetEvents(packet, 'table')) {
      tables[event.table ?? 'unnamed'] ??= { hits: 0, misses: 0 };
      if (event.result === 'miss') tables[event.table ?? 'unnamed'].misses += 1;
      else tables[event.table ?? 'unnamed'].hits += 1;
      if (event.action) actions[event.action] = (actions[event.action] ?? 0) + 1;
    }
    const reason = packetEvents(packet, 'drop')[0]?.reason;
    if (reason) dropsByReason[reason] = (dropsByReason[reason] ?? 0) + 1;
  }
  return {
    packetCount: trace.packets.length,
    outcomeCounts: {
      forwarded: trace.packets.filter(packet => packet.outcome === 'forwarded').length,
      dropped: trace.packets.filter(packet => packet.outcome === 'dropped').length
    },
    recirculatedPackets: trace.packets.filter(packet => packetEvents(packet, 'recirculate').length > 0).length,
    tableHits: metrics.reduce((total, item) => total + item.tableHits, 0),
    tableMisses: metrics.reduce((total, item) => total + item.tableMisses, 0),
    queueDelayNsTotal: metrics.reduce((total, item) => total + item.queueDelayNs, 0),
    queueDelayNsMax: Math.max(0, ...metrics.map(item => item.queueDelayNs)),
    dropsByReason,
    tables,
    actions
  };
}

export function filterPackets(traceInput, filters = {}) {
  const trace = normalizeTrace(traceInput);
  return trace.packets.filter(packet => {
    const metrics = derivePacketMetrics(packet);
    const tables = packetEvents(packet, 'table');
    if (filters.query && !JSON.stringify(packet).toLowerCase().includes(String(filters.query).toLowerCase())) return false;
    if (filters.outcome && packet.outcome !== filters.outcome) return false;
    if ((filters.table || filters.tableResult) && !tables.some(event =>
      (!filters.table || event.table === filters.table) && (!filters.tableResult || event.result === filters.tableResult))) return false;
    if (filters.action && !metrics.actionNames.includes(filters.action)) return false;
    if (filters.recirculated != null && (packetEvents(packet, 'recirculate').length > 0) !== Boolean(filters.recirculated)) return false;
    if (filters.dropReason && metrics.dropReason !== filters.dropReason) return false;
    if (filters.minQueueDelayNs != null && metrics.queueDelayNs < Number(filters.minQueueDelayNs)) return false;
    if (filters.passCount != null && metrics.passCount !== Number(filters.passCount)) return false;
    return true;
  });
}

function packetComparisonSnapshot(packet) {
  const metrics = derivePacketMetrics(packet);
  return {
    outcome: packet.outcome,
    outputPorts: [...packet.outputPorts],
    queueDelayNs: metrics.queueDelayNs,
    passCount: metrics.passCount,
    recirculated: packetEvents(packet, 'recirculate').length > 0,
    parsers: packetEvents(packet, 'parser').map(({ pass, state, header, ttl }) => ({ pass, state: state ?? null, header: header ?? null, ttl: ttl ?? null })),
    tables: packetEvents(packet, 'table').map(({ pass, table, result, key, action, params }) => ({ pass, name: table, result, key: key ?? null, action: action ?? null, params: params ?? null })),
    rewrites: packetEvents(packet, 'rewrite').map(({ pass, field, before, after }) => ({ pass, field, before, after })),
    dropReason: metrics.dropReason
  };
}

export function compareTraces(leftInput, rightInput, options = {}) {
  const leftBase = normalizeTrace(leftInput);
  const rightBase = normalizeTrace(rightInput);
  const left = options.leftPackets ? { ...leftBase, packets: options.leftPackets } : leftBase;
  const right = options.rightPackets ? { ...rightBase, packets: options.rightPackets } : rightBase;
  const leftById = new Map(left.packets.map(packet => [packet.id, packet]));
  const rightById = new Map(right.packets.map(packet => [packet.id, packet]));
  const ids = [...new Set([...leftById.keys(), ...rightById.keys()])].sort();
  const addedPacketIds = ids.filter(id => !leftById.has(id));
  const removedPacketIds = ids.filter(id => !rightById.has(id));
  const unchangedPacketIds = [];
  const changedPacketIds = [];
  const changes = [];
  const fields = ['outcome', 'outputPorts', 'queueDelayNs', 'passCount', 'recirculated', 'parsers', 'tables', 'rewrites', 'dropReason'];
  for (const id of ids.filter(item => leftById.has(item) && rightById.has(item))) {
    const before = packetComparisonSnapshot(leftById.get(id));
    const after = packetComparisonSnapshot(rightById.get(id));
    const changed = fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
    if (!changed.length) unchangedPacketIds.push(id);
    else {
      changedPacketIds.push(id);
      const beforeOutput = {};
      const afterOutput = {};
      for (const field of changed) {
        beforeOutput[field] = before[field];
        afterOutput[field] = after[field];
      }
      changes.push({ packetId: id, fields: changed, before: beforeOutput, after: afterOutput });
    }
  }
  return { addedPacketIds, removedPacketIds, unchangedPacketIds, changedPacketIds, changes };
}

export function exportReport(traceInput, visiblePackets = null) {
  const trace = normalizeTrace(traceInput);
  const scopedTrace = visiblePackets ? { ...trace, packets: visiblePackets } : trace;
  const summary = summarize(scopedTrace);
  const report = {
    schemaVersion: trace.schemaVersion,
    traceId: trace.traceId,
    summary: {
      packets: summary.packetCount,
      forwarded: summary.outcomeCounts.forwarded,
      dropped: summary.outcomeCounts.dropped,
      recirculated: summary.recirculatedPackets,
      tableHits: summary.tableHits,
      tableMisses: summary.tableMisses,
      queueDelayNsTotal: summary.queueDelayNsTotal,
      queueDelayNsMax: summary.queueDelayNsMax,
      ttlExpiredDrops: summary.dropsByReason.ttl_expired ?? 0
    },
    tables: Object.keys(summary.tables).sort().map(name => ({ name, ...summary.tables[name] })),
    packets: [...scopedTrace.packets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(packet => {
      const metrics = derivePacketMetrics(packet);
      return {
        id: packet.id,
        outcome: packet.outcome,
        outputs: [...packet.outputPorts],
        passes: metrics.passCount,
        queueDelayNs: metrics.queueDelayNs,
        ...(metrics.dropReason ? { dropReason: metrics.dropReason } : {}),
        explanations: explainPacket(packet),
        pipeline: packetComparisonSnapshot(packet)
      };
    })
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function explainPacket(packetInput) {
  const packet = packetInput.events ? packetInput : normalizeTrace({ packets: [packetInput] }).packets[0];
  const drop = packetEvents(packet, 'drop')[0];
  const rewrites = packetEvents(packet, 'rewrite');
  const explanations = [];
  if (packet.outcome === 'dropped' && !drop) explanations.push('Dropped outcome recorded, but no drop event or reason was provided.');
  if (drop?.reason === 'table_miss') explanations.push('Dropped because no entry matched the table key.');
  if (drop?.reason === 'ttl_expired') {
    const ttlZero = rewrites.some(event => event.field === 'ipv4.ttl' && Number(event.after) === 0);
    explanations.push(ttlZero ? 'Dropped after the IPv4 TTL rewrite reached zero.' : 'TTL expiry was reported, but no IPv4 TTL-to-zero rewrite was recorded.');
  }
  if (drop && !['table_miss', 'ttl_expired'].includes(drop.reason)) explanations.push(`Dropped by ${drop.reason ?? 'an unknown pipeline event'}.`);
  const recirculations = packetEvents(packet, 'recirculate');
  if (recirculations.length) explanations.push(`Recorded ${recirculations.length} recirculation${recirculations.length === 1 ? '' : 's'} for another ingress pipeline pass${recirculations.length === 1 ? '' : 'es'}${packet.outcome === 'dropped' ? '; terminal outcome is drop.' : '.'}`);
  if (rewrites.length) explanations.push(`Recorded ${rewrites.length} rewrite${rewrites.length === 1 ? '' : 's'}: ${rewrites.map(event => `pass ${event.pass} ${event.field} ${event.before} → ${event.after}`).join('; ')}.`);
  if (!drop && packetEvents(packet, 'tx').length) explanations.push(`Transmitted on port${packet.outputPorts.length === 1 ? '' : 's'} ${packet.outputPorts.join(', ')}.`);
  const queue = queueDelayDetails(packet);
  if (queue.matched.length) explanations.push(`Spent ${queue.totalNs} ns in the output queue across ${queue.matched.length} measured interval${queue.matched.length === 1 ? '' : 's'}.`);
  if (queue.unmatchedEnqueues.length || queue.unmatchedDequeues.length) explanations.push(`Queue evidence is incomplete: ${queue.unmatchedEnqueues.length} enqueue${queue.unmatchedEnqueues.length === 1 ? '' : 's'} and ${queue.unmatchedDequeues.length} dequeue${queue.unmatchedDequeues.length === 1 ? '' : 's'} could not be paired.`);
  return explanations;
}
