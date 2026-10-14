import { Flag, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { RunAnalysis } from './lib/replay';

export default function CompletionSummary({ summary }: { summary: RunAnalysis }) {
  if (summary.completionStatus !== 'partial') return null;
  return <section className="partial-completion-summary" aria-label="Partial completion status">
    <div className="partial-summary-title"><Flag size={24} /><div><h2>Partial completion</h2><p>The route is unfinished. This is not a successful run.</p></div></div>
    <div className="partial-summary-progress"><strong>{summary.completedGoals} <span>of {summary.totalGoals} goals</span></strong><div role="progressbar" aria-label="Recorded goal completion" aria-valuenow={summary.completedGoals} aria-valuemin={0} aria-valuemax={summary.totalGoals} aria-valuetext={`${summary.completedGoals} of ${summary.totalGoals} goals completed`}><span style={{ width: `${summary.completion * 100}%` }} /></div><b>{summary.remainingGoals} {summary.remainingGoals === 1 ? 'goal' : 'goals'} remaining</b></div>
    <div className={`partial-summary-safety ${summary.safetyStatus}`}><span>SAFETY IS SEPARATE</span><strong>{summary.safetyStatus === 'unsafe' ? <TriangleAlert size={18} /> : <ShieldCheck size={18} />}{summary.safetyStatus === 'unsafe' ? 'Unsafe run' : summary.safetyStatus === 'safe' ? 'No safety violations' : 'No recorded safety data'}</strong><p>{summary.events.length} rule flags · {summary.contacts} contact frames</p></div>
  </section>;
}
