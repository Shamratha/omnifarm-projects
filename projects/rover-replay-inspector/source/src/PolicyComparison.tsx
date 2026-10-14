import { useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, Crosshair, FileJson, GitCompareArrows, ShieldCheck, TriangleAlert } from 'lucide-react';
import { compareRuns, createReport, formatTime, type PolicyRun } from './lib/replay';
import './comparison.css';

type Props = {
  runs: PolicyRun[];
  activeId: string;
  onSelect: (id: string) => void;
  onInspect: (id: string, frameIndex: number) => void;
  onView?: () => void;
  onExport: () => void;
  compact?: boolean;
};

export default function PolicyComparison({ runs, activeId, onSelect, onInspect, onView, onExport, compact = false }: Props) {
  const compared = useMemo(() => compareRuns(runs), [runs]);
  const report = useMemo(() => createReport(runs), [runs]);
  const [preview, setPreview] = useState(false);
  const selected = compared.find(entry => entry.run.id === activeId);
  return <>
    <section className={`panel comparison-panel ${compact ? 'compact-comparison' : ''}`} aria-label="Policy comparison results">
      <div className="panel-heading"><div className="panel-title"><GitCompareArrows size={17} /><h2>Policy comparison</h2><span className="subtle-tag">SAME SCENARIO</span></div>{onView ? <button className="text-button" onClick={onView}>View full comparison <ArrowRight size={14} /></button> : <span className="subtle-tag">{runs.length} BUNDLED RUNS</span>}</div>
      <div className="table-wrap"><table className="policy-comparison-table"><caption className="sr-only">Full-run comparison ranked by unrounded undiscounted reward; completion and safety are separate.</caption><thead><tr><th scope="col">POLICY / RANK</th><th scope="col" aria-sort="descending">TOTAL REWARD ↓</th><th scope="col">COMPLETION</th><th scope="col">SAFETY</th><th scope="col">FIRST UNSAFE ACTION</th><th scope="col">OUTCOME</th></tr></thead><tbody>
        {compared.map(({ run, summary, rank }) => <tr key={run.id} data-policy-id={run.id} className={activeId === run.id ? 'active-row' : ''}>
          <td><div className="policy-cell"><span className="rank">{rank}</span><i style={{ background: run.color }} /><button className="policy-select" onClick={() => onSelect(run.id)} aria-label={`Inspect ${run.name}`} aria-pressed={activeId === run.id}>{run.name}</button>{activeId === run.id && <small>active</small>}</div></td>
          <td><strong className="table-number" title={`Unrounded reward: ${summary.totalReward}`}>{summary.totalReward.toFixed(2)}</strong></td>
          <td><span className="goal-count"><span className={summary.completionStatus === 'complete' ? 'check-circle' : 'partial-circle'}>{summary.completionStatus === 'complete' ? <Check size={11} /> : '—'}</span>{summary.completedGoals} / {summary.totalGoals}</span><span className={`comparison-cell-note completion-state ${summary.completionStatus}`}>{completionLabel(summary.completionStatus)} · {(summary.completion * 100).toFixed(1)}%</span></td>
          <td><span className={`status ${summary.safetyStatus === 'safe' ? 'success' : 'warning'}`}>{summary.safetyStatus === 'safe' ? <ShieldCheck size={13} /> : <TriangleAlert size={13} />}{summary.safetyStatus === 'safe' ? 'Safe' : summary.safetyStatus === 'no-data' ? 'No data' : 'Unsafe'} · {summary.events.length} flags</span><span className="comparison-cell-note">{summary.contacts} contact frames · {summary.unsafeFrames} unsafe frames</span></td>
          <td>{summary.firstUnsafe ? <button className="comparison-evidence-link" aria-label={`Inspect first unsafe action for ${run.name}`} onClick={() => onInspect(run.id, summary.firstUnsafe!.frameIndex)}><Crosshair size={12} />{formatTime(summary.firstUnsafe.time)} · {summary.firstUnsafe.title}</button> : <span className="muted-dash">None recorded</span>}</td>
          <td><span className={`run-status ${summary.success ? 'success' : 'review'}`}><i />{summary.success ? 'Success' : summary.completionStatus === 'partial' ? 'Partial · not successful' : summary.completionStatus === 'complete' && summary.safetyStatus === 'unsafe' ? 'Complete · unsafe' : 'Not successful'}</span></td>
        </tr>)}
      </tbody></table></div>
      <div className="comparison-foot"><span>Full-precision reward ↓ <span className="foot-separator" /> Exact ties share competition rank; policy ID breaks display ties.</span></div>
    </section>
    {!compact && selected && <section className="panel policy-inspection" aria-label="Selected policy inspection">
      <div className="panel-heading"><div className="panel-title"><Crosshair size={17} /><h2>{selected.run.name} · inspection</h2></div><button className="text-button" onClick={() => onInspect(selected.run.id, selected.summary.firstUnsafe?.frameIndex ?? selected.run.frames[0]?.index ?? 0)}>Open replay evidence <ArrowRight size={14} /></button></div>
      <div className="policy-inspection-grid">
        <div className={`completion-inspection ${selected.summary.completionStatus}`}><h3>Completion</h3><strong>{selected.summary.completedGoals} of {selected.summary.totalGoals} goals · {completionLabel(selected.summary.completionStatus)}</strong><p><b>{selected.summary.remainingGoals} {selected.summary.remainingGoals === 1 ? 'goal' : 'goals'} remaining.</b> {selected.summary.success ? 'Complete with no safety violations.' : 'Not a successful run: success requires complete goals and a safe recording.'}</p></div>
        <div><h3>Safety breakdown</h3><strong>{selected.summary.events.length} rule violations across {selected.summary.unsafeFrames} frames</strong><p>{selected.summary.contacts} contact frames · {selected.summary.eventCounts.staleObservation} moving-delay flags · {selected.summary.eventCounts.clearance} low-clearance flags</p><p>{selected.summary.criticalEvents} critical · {selected.summary.warningEvents} warning events</p></div>
        <div><h3>Observation & clearance</h3><strong>Max observation age: {selected.summary.maxObservationAgeMs === null ? 'No data' : `${selected.summary.maxObservationAgeMs} ms`}</strong><p>Minimum clearance: {selected.summary.minClearance === null ? 'No data' : `${selected.summary.minClearance.toFixed(2)} m`}. Max age includes stationary frames; only moving ages above 500 ms are flagged.</p></div>
        <div><h3>Recorded evidence</h3><strong>{selected.summary.frameCount} frames · {selected.summary.duration.toFixed(1)} s</strong><p>Total reward: {selected.summary.totalReward.toFixed(2)}. Multiple rules can flag one frame; contact frames are not collision episodes. Reward is not a safety guarantee.</p></div>
      </div>
    </section>}
    {!compact && <section className="panel inspection-report-panel" aria-label="Deterministic inspection report">
      <div className="panel-heading"><div className="panel-title"><FileJson size={17} /><h2>Deterministic inspection report</h2><span className="subtle-tag">JSON · SCHEMA 1</span></div><button className="small-button" onClick={onExport}><ArrowDownToLine size={14} /> Download inspection JSON</button></div>
      <div className="inspection-report-body"><p>All {runs.length} policies, regardless of the active policy, playback position, or event filter. Includes partial-completion counts, per-rule safety metrics, first-unsafe evidence, ranking, and full recorded traces.</p><ul><li>Summaries and traces: policy ID ascending.</li><li>Frames: simulation time, then frame index. Safety rules: contact → observation delay → clearance.</li><li>Goals: goal ID ascending. Rank: full-precision reward descending, exact ties share rank.</li><li>Stable field order; no export timestamp or UI state. Observation linkage does not establish causation.</li></ul><button className="text-button" aria-expanded={preview} aria-controls="report-json-preview" onClick={() => setPreview(value => !value)}><FileJson size={14} /> {preview ? 'Hide JSON preview' : 'Preview exact JSON'}</button>{preview && <pre id="report-json-preview" tabIndex={0} aria-label="Exact report JSON preview">{report}</pre>}</div>
    </section>}
  </>;
}

function completionLabel(status: ReturnType<typeof compareRuns>[number]['summary']['completionStatus']) {
  return status === 'complete' ? 'Complete' : status === 'partial' ? 'Partial' : status === 'no-goals' ? 'No goals' : 'Not started';
}
