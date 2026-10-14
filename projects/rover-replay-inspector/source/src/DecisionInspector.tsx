import { useEffect, useMemo, useRef } from 'react';
import { Crosshair, Radar, TriangleAlert } from 'lucide-react';
import { analyzeRun, formatTime, getDecisionEvidence, type PolicyRun } from './lib/replay';

/** Keep precise timing visible rather than rounding timestamps to tenths. */
export function timingStamp(seconds: number) {
  return `${seconds.toFixed(3)} s`;
}

export function DecisionInspector({ run, index, seek }: { run: PolicyRun; index: number; seek: (index: number) => void }) {
  const selectedRow = useRef<HTMLTableRowElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const analysis = useMemo(() => analyzeRun(run), [run]);
  const selected = run.frames[index];
  const evidence = getDecisionEvidence(selected);
  const events = analysis.events.filter(event => event.frameIndex === selected.index);

  useEffect(() => {
    // Scroll only the action list, never the page during playback or scrubbing.
    const row = selectedRow.current;
    const container = scrollArea.current;
    if (!row || !container) return;
    const target = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    if (target < container.scrollTop + 35 || target + row.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = Math.max(0, target - container.clientHeight / 2);
    }
  }, [index, run]);

  return <div className="action-inspector">
    <div className="action-list-heading"><h3><Radar size={15} /> Observation → decision ledger</h3><span>Every recorded action · timestamps in simulation time</span></div>
    <div className="action-ledger" ref={scrollArea} role="region" aria-label="Action observation timeline" tabIndex={0}>
      <table><thead><tr><th>ACTION / TIME</th><th>RECORDED DECISION</th><th>OBSERVATION TIME</th><th>AGE AT ACTION</th><th>LINKED READINGS</th><th>SAFETY</th></tr></thead><tbody>
        {run.frames.map((frame, position) => {
          const entry = getDecisionEvidence(frame);
          const violations = analysis.events.filter(event => event.frameIndex === frame.index);
          return <tr key={frame.index} ref={position === index ? selectedRow : undefined} className={position === index ? 'selected-action' : ''} aria-current={position === index ? 'true' : undefined} onClick={() => seek(position)}>
            <td><button aria-label={`Inspect action ${frame.index} at ${formatTime(frame.time)}`} onClick={event => { event.stopPropagation(); seek(position); }}><Crosshair size={12} /> #{String(frame.index).padStart(3, '0')} <strong>{timingStamp(frame.time)}</strong></button></td>
            <td><strong>{entry.actionLabel}</strong><small>{entry.steeringLabel}</small></td>
            <td className="mono">{timingStamp(entry.observationTime)}</td>
            <td><strong className={entry.timing === 'delayed-while-moving' ? 'alert-value' : ''}>{entry.observationAgeMs} ms</strong><small>{entry.timing === 'delayed-while-moving' ? 'Delayed · moving' : entry.timing === 'stale-while-stationary' ? 'Stale · stationary' : entry.observationAgeSeconds === 0 ? 'Same timestamp' : 'Within 500 ms limit'}</small></td>
            <td><strong>{frame.clearance.toFixed(2)} m clearance</strong><small>{frame.contact ? 'Contact detected' : 'No contact'} · reward {frame.reward.toFixed(2)}</small></td>
            <td><span className={violations.length ? 'action-flagged' : 'action-clear'}>{violations.length ? <><TriangleAlert size={12} /> {violations.length} rules{frame.contact && ' · contact'}</> : 'No flags'}</span></td>
          </tr>;
        })}
      </tbody></table>
    </div>
    <section className={`selected-action-detail ${events.length ? 'has-violations' : ''}`} aria-label="Selected action explanation">
      <div className="selected-action-heading"><h3><Crosshair size={20} /> Action #{String(selected.index).padStart(3, '0')} · {timingStamp(selected.time)}</h3><span>{events.length ? 'UNSAFE ACTION' : 'NO FLAGS'} · {events.length ? `${events.length} safety rules flagged` : 'No safety rules flagged'}</span></div>
      <p className="observation-link"><b>Observation {timingStamp(evidence.observationTime)}</b><Arrow /><b>{evidence.observationAgeMs} ms age</b><Arrow /><b>Decision {timingStamp(evidence.decisionTime)}</b></p>
      <p><strong>{evidence.actionLabel} · {evidence.steeringLabel}</strong>. Decision-associated readings: clearance {evidence.clearance.toFixed(2)} m; contact {evidence.contact ? 'detected' : 'clear'}; reward {evidence.reward.toFixed(2)}.</p>
      {events.length ? <ul className="selected-violations" aria-label="Safety evidence for this action">{events.map(event => <li key={event.type} className={`violation-card ${event.severity}`}><TriangleAlert size={21} /><div><strong>{event.title} <small>{event.severity}</small></strong><p>{event.description}</p><span>{event.type === 'contact' ? 'Rule: any occupied obstacle cell is unsafe, even while stopped.' : event.type === 'stale-observation' ? 'Rule: moving with an observation older than 500 ms is unsafe.' : 'Rule: clearance below 2.00 m violates the obstacle safety buffer.'}</span></div></li>)}</ul> : <p className="no-flags">This frame has no contact, stale-moving-observation, or clearance violations.</p>}
      <p className="evidence-limit"><Radar size={13} /> Observation time is linked to this decision. Clearance and contact are recorded at the action frame, not a separately captured historical sensor payload. Co-occurring delay and contact do not prove causation.</p>
    </section>
  </div>;
}

function Arrow() { return <span aria-hidden="true">→</span>; }
