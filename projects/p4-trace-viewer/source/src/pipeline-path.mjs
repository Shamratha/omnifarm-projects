import { derivePacketMetrics, explainPacket, queueDelayDetails } from './trace-model.mjs';

const display = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const human = value => String(value ?? '').replaceAll('_', ' ');
const markers = {
  parser: { symbol: 'P', label: 'Parser', tone: 'parser' },
  table: { symbol: 'T', label: 'Table', tone: 'table' },
  rewrite: { symbol: 'Δ', label: 'Rewrite', tone: 'rewrite' },
  drop: { symbol: '×', label: 'Drop', tone: 'drop' },
  recirculate: { symbol: '↻', label: 'Recirculation', tone: 'recirculate' },
  queue_enqueue: { symbol: '◷', label: 'Queue entry', tone: 'queue' },
  queue_dequeue: { symbol: '◷', label: 'Queue delay', tone: 'queue' },
  tx: { symbol: '→', label: 'Transmit', tone: 'tx' }
};

export function buildPipelinePath(packet) {
  const queue = queueDelayDetails(packet);
  const intervals = new Map(queue.matched.flatMap(interval => [
    [interval.enqueueIndex, interval], [interval.dequeueIndex, interval]
  ]));
  const passes = [];
  const nodes = packet.events.map((event, index) => {
    const marker = markers[event.kind] ?? { symbol: '•', label: human(event.kind), tone: 'other' };
    let title = marker.label;
    let detail = '';
    if (event.kind === 'parser') {
      title = `Parse ${event.header ?? 'packet'}`;
      detail = `${event.state ?? 'Parser state unavailable'} · TTL ${display(event.ttl)}`;
    } else if (event.kind === 'table') {
      title = `${event.table ?? 'unnamed table'} · ${event.result ?? 'result unavailable'}`;
      detail = `Key ${display(event.key)}${event.action ? ` → action ${event.action}` : ''}${event.params ? ` · ${display(event.params)}` : ''}`;
    } else if (event.kind === 'rewrite') {
      title = `Rewrite ${event.field ?? 'field'}`;
      detail = `${display(event.before)} → ${display(event.after)}`;
    } else if (event.kind === 'drop') {
      title = 'Drop · packet terminated';
      detail = `${event.reason ? human(event.reason) : 'Reason unavailable'} · no output from this drop event`;
    } else if (event.kind === 'recirculate') {
      const next = packet.events.slice(index + 1).find(item => item.pass > event.pass);
      title = 'Recirculation · return to ingress';
      detail = next ? `Pass ${event.pass} → pass ${next.pass} · parser runs again` : 'No subsequent ingress pass recorded';
    } else if (event.kind === 'queue_enqueue' || event.kind === 'queue_dequeue') {
      const interval = intervals.get(index);
      title = event.kind === 'queue_enqueue' ? `Queue entry · queue ${event.queue ?? 'default'}` : 'Queue delay · residence interval';
      detail = interval
        ? `Queue ${interval.queue} · ${interval.enqueueT} → ${interval.dequeueT} ns = ${interval.delayNs} ns`
        : `Queue ${event.queue ?? 'default'} · unmatched ${event.kind === 'queue_enqueue' ? 'enqueue' : 'dequeue'}; delay unavailable`;
    } else if (event.kind === 'tx') {
      title = `Transmit · port ${display(event.port)}`;
      detail = 'Packet leaves the pipeline';
    } else {
      detail = Object.entries(event).filter(([key]) => !['kind', 't', 'pass'].includes(key)).map(([key, value]) => `${key}: ${display(value)}`).join(' · ');
    }
    const node = { index, kind: event.kind, pass: event.pass, t: event.t, ...marker, title, detail };
    let group = passes.at(-1);
    if (!group || group.pass !== event.pass) {
      group = { pass: event.pass, nodes: [] };
      passes.push(group);
    }
    group.nodes.push(node);
    return node;
  });
  return {
    nodes,
    passes,
    outcome: packet.outcome,
    metrics: derivePacketMetrics(packet),
    explanations: explainPacket(packet),
    queue,
    queueLabel: queue.matched.length ? `${queue.totalNs} ns${queue.unmatchedEnqueues.length || queue.unmatchedDequeues.length ? ' · partial' : ''}` : 'Not measured'
  };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function renderPipelinePath(path) {
  const legend = ['drop', 'rewrite', 'recirculate', 'queue_dequeue'].map(kind => {
    const marker = markers[kind];
    return `<span class="path-legend-item"><span class="legend-symbol marker-${marker.tone}" aria-hidden="true">${marker.symbol}</span>${marker.label}</span>`;
  }).join('');
  const groups = path.passes.map(group => `<section class="pipeline-pass" data-pass="${group.pass}" aria-label="Pipeline pass ${group.pass}"><h3 class="pass-boundary">Pass ${group.pass} <span>${group.pass === 0 ? 'Initial ingress' : 'Re-entry / recorded pipeline pass'}</span></h3><ol class="timeline">${group.nodes.map(node => `<li class="event event-${node.tone}" data-event-kind="${escape(node.kind)}"><div class="event-time">${node.t} ns</div><span class="event-dot marker-${node.tone}" aria-hidden="true">${node.symbol}</span><div class="event-content"><div class="event-kind">${escape(node.label)} · pass ${node.pass}</div><div class="event-main">${escape(node.title)}</div><div class="event-detail">${escape(node.detail)}</div></div></li>`).join('')}</ol></section>`).join('');
  return `<div class="path" aria-label="Selected packet pipeline path"><div class="path-label">PIPELINE PATH · ${path.nodes.length} EVENTS · ${escape(path.outcome.toUpperCase())}</div><div class="path-legend" aria-label="Marker legend">${legend}</div>${groups || '<p class="muted">No pipeline events recorded.</p>'}</div>`;
}
