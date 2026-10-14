import { ArrowRight, Check, Crosshair, ShieldCheck, TriangleAlert } from 'lucide-react';
import { formatTime, getDecisionEvidence, type PolicyRun, type RunAnalysis } from './lib/replay';
import { timingStamp } from './DecisionInspector';

export default function UnsafeActionPanel({ run, summary, seek }: { run: PolicyRun; summary: RunAnalysis; seek: (position: number) => void }) {
  const first = summary.firstUnsafe;
  const position = first ? run.frames.findIndex(frame => frame.index === first.frameIndex) : -1;
  const frame = run.frames[position];
  const evidence = frame ? getDecisionEvidence(frame) : null;
  const events = first ? summary.events.filter(event => event.frameIndex === first.frameIndex) : [];
  return <section className={`panel unsafe-panel ${!first ? 'safe-panel' : ''}`} aria-label="First unsafe action evidence">
    <div className="unsafe-heading"><span className="warning-icon">{first ? <TriangleAlert size={21} /> : <ShieldCheck size={21} />}</span><h2>{first ? 'First unsafe action' : 'No unsafe action'}</h2>{first && <span className="warning-tag">UNSAFE</span>}</div>
    {first && evidence && frame ? <>
      <div className="event-time">{formatTime(first.time)}<span>FRAME {first.frameIndex}</span></div>
      <h3>{first.title}</h3>
      <p className="first-action-motion">{evidence.actionLabel}<span>{evidence.steeringLabel}</span></p>
      <dl className="first-unsafe-readings">
        <div><dt>Observation taken</dt><dd>{timingStamp(evidence.observationTime)}</dd></div>
        <div><dt>Decision made</dt><dd>{timingStamp(evidence.decisionTime)}</dd></div>
        <div className={evidence.timing === 'delayed-while-moving' ? 'reading-violation' : ''}><dt>Age at action</dt><dd>{evidence.observationAgeMs} ms</dd><small>{evidence.timing === 'delayed-while-moving' ? 'Above 500 ms moving limit' : 'No moving-delay violation'}</small></div>
        <div className={frame.contact ? 'reading-violation' : ''}><dt>Contact</dt><dd>{frame.contact ? 'Detected' : 'Clear'}</dd><small>Clearance {frame.clearance.toFixed(2)} m</small></div>
      </dl>
      <p className="first-unsafe-count">{events.length} safety rules flagged at this action</p>
      <ul className="first-unsafe-rules">{events.map(event => <li key={event.type}><TriangleAlert size={15} /><span>{event.title}</span><b>{event.severity}</b></li>)}</ul>
      <div className="cause-box"><span>WHY THIS IS UNSAFE</span><p>{first.type === 'contact' ? 'The rover occupied an obstacle cell. Contact is unsafe even when stopped; completing goals does not cancel a safety violation.' : first.type === 'stale-observation' ? 'The rover moved using an observation older than the 500 ms limit.' : 'The rover crossed the 2 m safety buffer around an obstacle.'}</p></div>
      <button className="jump-button" onClick={() => seek(position)}><Crosshair size={18} /> Jump to action <ArrowRight size={18} /></button>
      <p className="first-unsafe-note">Pinned to the first unsafe frame. Inspect other actions below; co-occurring delay and contact do not prove causation.</p>
    </> : <div className="safe-message"><p>Every recorded action stayed within the configured safety boundaries.</p><div><Check size={18} /> Fresh observations</div><div><Check size={18} /> No obstacle contact</div><div><Check size={18} /> Clearance maintained</div></div>}
  </section>;
}
