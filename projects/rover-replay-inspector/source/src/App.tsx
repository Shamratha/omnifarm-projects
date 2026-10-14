import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, AudioLines, Box, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Crosshair, Flag, Gauge, GitCompareArrows, Layers2, ListFilter, Map, Maximize2, Menu, MousePointer2, Pause, Play, Radar, RotateCcw, Route, ShieldCheck, ShieldX, SkipBack, SkipForward, TriangleAlert, X } from 'lucide-react';
import { analyzeRun, createReport, cumulativeRewards, formatTime, getDecisionEvidence, runs, SCENARIO, type DecisionEvidence, type PolicyRun, type ReplayFrame } from './lib/replay';
import { DecisionInspector, timingStamp } from './DecisionInspector';
import PolicyComparison from './PolicyComparison';
import UnsafeActionPanel from './UnsafeActionPanel';
import CompletionSummary from './CompletionSummary';
import './inspection-clarity.css';

type Tab = 'overview' | 'comparison' | 'events';
type Modal = 'scenario' | 'help' | null;
const names: Record<string, string> = { ppo: 'PPO', sac: 'SAC', baseline: 'Rule-based' };
const colors: Record<string, string> = { ppo: '#e98641', sac: '#2a9e93', baseline: '#8992b3' };

function App() {
  const [selectedId, setSelectedId] = useState('ppo');
  const [frameIndex, setFrameIndex] = useState(48);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState<Tab>('overview');
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState('');
  const [showOther, setShowOther] = useState(true);
  const [showSensors, setShowSensors] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [expandedMap, setExpandedMap] = useState(false);
  const [eventFilter, setEventFilter] = useState('all');
  const [mobileNav, setMobileNav] = useState(false);
  const run = runs.find(r => r.id === selectedId)!;
  const summary = useMemo(() => analyzeRun(run), [run]);
  const frame = run.frames[frameIndex];
  const evidence = useMemo(() => getDecisionEvidence(frame), [frame]);

  useEffect(() => {
    if (!playing) return;
    const interval = window.setInterval(() => setFrameIndex(i => {
      if (i >= run.frames.length - 1) { setPlaying(false); return i; }
      return i + 1;
    }), 500 / speed);
    return () => window.clearInterval(interval);
  }, [playing, speed, run]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { setModal(null); setLayersOpen(false); setMobileNav(false); }
      if (modal && event.key === 'Tab') {
        const focusable = document.querySelectorAll<HTMLButtonElement>('.modal button');
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  function seek(index: number) { setFrameIndex(Math.max(0, Math.min(run.frames.length - 1, index))); setPlaying(false); }
  function togglePlay() { if (frameIndex === run.frames.length - 1) setFrameIndex(0); setPlaying(p => !p); }
  function inspectPolicy(id: string, recordingIndex: number) {
    const targetRun = runs.find(run => run.id === id)!;
    const position = targetRun.frames.findIndex(frame => frame.index === recordingIndex);
    setSelectedId(id);
    setFrameIndex(Math.max(0, position));
    setPlaying(false);
    setExpandedMap(false);
    setTab('overview');
  }
  function exportReport() {
    const url = URL.createObjectURL(new Blob([createReport(runs)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'rover-lab-warehouse-seed-18427.json'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast('Deterministic report exported · 3 policy runs');
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('overview'); }}><span className="brand-icon"><Radar size={23} /></span><span>rover<span className="brand-light">lab</span><span className="brand-dot">.</span></span></a>
      <div className="workspace-label">WORKSPACE <span>LOCAL</span></div>
      <nav aria-label="Workspace navigation">
        <button className={tab === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => { setTab('overview'); setMobileNav(false); }}><Route size={18} /> Replay inspector <span className="nav-indicator" /></button>
        <button className={tab === 'comparison' ? 'nav-item active' : 'nav-item'} onClick={() => { setTab('comparison'); setMobileNav(false); }}><GitCompareArrows size={18} /> Policy comparison</button>
        <button className={tab === 'events' ? 'nav-item active' : 'nav-item'} onClick={() => { setTab('events'); setMobileNav(false); }}><AudioLines size={18} /> Event log <span className="nav-count">{summary.events.length}</span></button>
        <div className="nav-divider" />
        <button className="nav-item" onClick={() => setModal('scenario')}><Box size={18} /> Bundled scenarios <span className="nav-count">1</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="local-card"><span className="local-icon"><ShieldCheck size={20} /></span><strong>Simulation, not operation</strong><p>Inspect recorded decisions.<br />Never send robot commands.</p><span className="local-status"><i /> Fully local workspace</span></div>
        <button className="nav-item help-link" onClick={() => setModal('help')}><CircleHelp size={18} /> Quick guide <ArrowUpRight size={15} /></button>
        <div className="sidebar-version"><span>ROVER LAB</span><span>v1.0.0</span></div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><button className="mobile-toggle icon-button" aria-label="Toggle navigation" onClick={() => setMobileNav(v => !v)}><Menu size={20} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{tab === 'overview' ? 'Replay inspector' : tab === 'comparison' ? 'Policy comparison' : 'Event log'}</strong></div><div className="topbar-right"><span className="environment"><i /> Simulation environment</span><span className="topbar-divider" /><button className="icon-button" aria-label="Open quick guide" onClick={() => setModal('help')}><CircleHelp size={18} /></button><div className="avatar">RL</div></div></header>
      <main>
        <section className="page-heading"><div><div className="eyebrow">OBSERVE. UNDERSTAND. ITERATE.</div><h1>{tab === 'overview' ? 'Replay inspector' : tab === 'comparison' ? 'Policy comparison' : 'Event log'}<span className="beta-tag">LOCAL</span></h1><p>{tab === 'overview' ? 'Every action has a story. Find out where your policy went off course.' : tab === 'comparison' ? 'Same world. Different decisions. Compare outcomes without losing the context.' : 'A frame-by-frame record of safety boundaries and policy decisions.'}</p></div><button className="button primary" onClick={exportReport}><ArrowDownToLine size={16} /> Export report <ChevronDown size={14} /></button></section>

        <section className="run-bar" aria-label="Replay configuration"><div className="scenario-picker" onClick={() => setModal('scenario')} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setModal('scenario'); }}><span className="scenario-icon"><Box size={21} /></span><div><span className="field-label">SCENARIO</span><strong>Warehouse navigation <ChevronDown size={14} /></strong></div></div><div className="run-bar-separator" /><div className="policy-picker"><label htmlFor="policy" className="field-label">ACTIVE POLICY</label><div><i style={{ background: colors[selectedId] }} /><select id="policy" value={selectedId} onChange={e => { setSelectedId(e.target.value); setPlaying(false); }}>{runs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div></div><div className="run-metadata"><span>SEED <b>18427</b></span><span>RUN <b>WHS-0042</b></span><span className="bundled-badge"><span className="tiny-dot" /> Bundled replay</span></div></section>

        <div className="section-tabs" role="tablist" aria-label="Inspector views"><button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'selected' : ''} onClick={() => setTab('overview')}><Map size={15} /> Replay overview</button><button role="tab" aria-selected={tab === 'comparison'} className={tab === 'comparison' ? 'selected' : ''} onClick={() => setTab('comparison')}><GitCompareArrows size={15} /> Policy comparison <span>3</span></button><button role="tab" aria-selected={tab === 'events'} className={tab === 'events' ? 'selected' : ''} onClick={() => setTab('events')}><AudioLines size={15} /> Event log <span>{summary.events.length}</span></button><div className="dataset-note"><CheckCheck size={14} /> Deterministic dataset</div></div>

        <section className="metric-grid" aria-label="Run summary">
          <Metric icon={<Clock3 size={17} />} title="REPLAY DURATION" value={summary.duration.toFixed(1)} unit="s" footer={`${summary.frameCount} recorded frames`} detail="2 Hz" />
          <Metric icon={<Flag size={17} />} title="GOAL COMPLETION" value={`${summary.completedGoals}`} unit={`/ ${summary.totalGoals}`} footer={summary.completionStatus === 'complete' ? 'All waypoints reached' : 'Partial route completion'} detail={summary.completionStatus === 'partial' ? 'PARTIAL' : `${Math.round(summary.completion * 100)}%`} tone={summary.completionStatus === 'partial' ? 'partial-metric' : 'teal'} />
          <Metric icon={<Activity size={17} />} title="CUMULATIVE REWARD" value={summary.totalReward.toFixed(2)} footer="Undiscounted return" detail="Σ rₜ" />
          <Metric icon={<ShieldX size={17} />} title="SAFETY VIOLATIONS" value={`${summary.events.length}`} footer={summary.events.length ? `${summary.contacts} contact frames detected` : 'No unsafe actions detected'} detail={summary.events.length ? 'Review needed' : 'Safe run'} tone={summary.events.length ? 'orange' : 'teal'} />
        </section>
        <CompletionSummary summary={summary} />

        {tab === 'overview' && <>
          <div className={`replay-layout ${expandedMap ? 'map-expanded' : ''}`}>
            <div className="replay-main-column"><section className="panel map-panel"><div className="panel-heading"><div className="panel-title"><Map size={17} /><h2>Trajectory replay</h2><span className="subtle-tag">2D TOP VIEW</span></div><div className="map-actions"><div className="layers-container"><button className={`small-button ${layersOpen ? 'pressed' : ''}`} onClick={() => setLayersOpen(v => !v)} aria-expanded={layersOpen}><Layers2 size={14} /> Layers <ChevronDown size={12} /></button>{layersOpen && <div className="layers-popover"><label><input type="checkbox" checked={showOther} onChange={e => setShowOther(e.target.checked)} /> Other policies</label><label><input type="checkbox" checked={showSensors} onChange={e => setShowSensors(e.target.checked)} /> Sensor footprint</label></div>}</div><button className="icon-button compact" aria-label={expandedMap ? 'Restore map size' : 'Expand map'} onClick={() => setExpandedMap(v => !v)}><Maximize2 size={15} /></button></div></div>
              <div className="map-canvas"><div className="map-label"><span className="tiny-dot" /> WAREHOUSE / SECTOR 04</div><span className="map-live"><i /> FRAME {String(frameIndex).padStart(3, '0')}</span><WarehouseMap run={run} frame={frame} showOther={showOther} showSensors={showSensors} onContact={seek} onGoal={i => { const f = run.frames.find(f => Math.hypot(f.x - run.goals[i].x, f.y - run.goals[i].y) < .1); if (f) seek(f.index); else setToast('This waypoint was not reached by the active policy.'); }} /><div className="map-scale"><span /> 10 m</div><div className="map-coordinate">x {frame.x.toFixed(1)} <span>/</span> y {frame.y.toFixed(1)} m</div></div>
              <div className="map-legend"><div className="policy-legends">{runs.map(r => <span key={r.id} className={!showOther && r.id !== selectedId ? 'dimmed' : ''}><i style={{ background: colors[r.id] }} />{names[r.id]}{r.id === selectedId && <small>active</small>}</span>)}</div><div className="map-symbols"><span><i className="goal-symbol" /> Goal</span><span><i className="obstacle-symbol" /> Obstacle</span><span><i className="contact-symbol" /> Contact</span></div></div>
              <div className="collision-list" aria-label="Collision frames"><span><TriangleAlert size={13} /> CONTACT FRAMES</span>{run.frames.some(f => f.contact) ? run.frames.filter(f => f.contact).map(f => <button key={f.index} aria-pressed={frameIndex === f.index} onClick={() => seek(f.index)}>#{f.index} · {formatTime(f.time)} <Crosshair size={12} /></button>) : <small>No contact frames in this run</small>}</div>
            </section>
            <Timeline run={run} index={frameIndex} evidence={evidence} seek={seek} playing={playing} togglePlay={togglePlay} speed={speed} setSpeed={setSpeed} />
            </div>
            <aside className="inspection-column"><UnsafeActionPanel run={run} summary={summary} seek={seek} />
              <section className="panel sensor-panel"><div className="panel-heading"><div className="panel-title"><Radar size={16} /><h2>Sensor snapshot</h2><span className="subtle-tag">LINKED TO ACTION</span></div><span className="mono subtle">{formatTime(frame.time)}</span></div><div className="sensor-grid"><Sensor label="Velocity" value={frame.speed.toFixed(2)} unit="m/s" /><Sensor label="Clearance" value={frame.clearance.toFixed(2)} unit="m" warning={frame.clearance < 2} /><Sensor label="Observation age" value={`${evidence.observationAgeMs}`} unit="ms" warning={evidence.timing === 'delayed-while-moving'} /><Sensor label="Contact state" value={frame.contact ? 'Detected' : 'Clear'} warning={frame.contact} /></div><div className="sensor-footnote"><span className={evidence.timing === 'delayed-while-moving' ? 'orange-dot' : 'teal-dot'} /> {evidence.timing === 'delayed-while-moving' ? `Observation from ${evidence.observationTime.toFixed(3)} s · ${evidence.observationAgeMs} ms delay` : `Observation from ${evidence.observationTime.toFixed(3)} s · synchronized`}</div></section>
            </aside>
          </div>
          <DecisionInspector run={run} index={frameIndex} seek={seek} />
          <PolicyComparison runs={runs} activeId={selectedId} onSelect={id => { setSelectedId(id); setPlaying(false); }} onInspect={inspectPolicy} onExport={exportReport} onView={() => setTab('comparison')} compact />
        </>}

        {tab === 'comparison' && <><PolicyComparison runs={runs} activeId={selectedId} onSelect={id => { setSelectedId(id); setPlaying(false); }} onInspect={inspectPolicy} onExport={exportReport} /><section className="panel reward-panel"><div className="panel-heading"><div className="panel-title"><Activity size={17} /><h2>Cumulative reward by policy</h2></div><span className="subtle">Undiscounted · 60 seconds</span></div><RewardChart /><div className="chart-note"><CircleHelp size={14} /> Higher reward is not a safety guarantee. Rankings use total reward; exact ties share a rank.</div></section></>}

        {tab === 'events' && <section className="panel events-panel"><div className="panel-heading"><div className="panel-title"><AudioLines size={17} /><h2>Safety event log</h2><span className="subtle-tag">{summary.events.length} EVENTS</span></div><label className="filter-label"><ListFilter size={15} /><select aria-label="Filter event type" value={eventFilter} onChange={e => setEventFilter(e.target.value)}><option value="all">All event types</option><option value="contact">Obstacle contact</option><option value="stale-observation">Delayed observations</option><option value="clearance">Low clearance</option></select></label></div><div className="events-list">{summary.events.filter(e => eventFilter === 'all' || e.type === eventFilter).map((event, i) => <button className="event-row" key={`${event.frameIndex}-${event.type}`} onClick={() => { seek(event.frameIndex); setTab('overview'); }}><span className={`event-severity ${event.severity}`}><TriangleAlert size={17} /></span><span className="mono">{formatTime(event.time)}</span><div><strong>{event.title}{i === 0 && event === summary.firstUnsafe && <small>FIRST UNSAFE</small>}</strong><p>{event.description}</p></div><span className="subtle mono">Frame {event.frameIndex}</span><ArrowUpRight size={16} /></button>)}{!summary.events.filter(e => eventFilter === 'all' || e.type === eventFilter).length && <div className="empty-state"><ShieldCheck size={32} /><h3>All clear here</h3><p>No {eventFilter === 'all' ? 'safety' : eventFilter} events recorded for {run.name}.</p></div>}</div></section>}

        <footer className="page-footer"><span><ShieldCheck size={13} /> Simulator viewer only. No hardware connections or control commands.</span><span>Bundled data <span className="footer-dot">·</span> Seed 18427 <span className="footer-dot">·</span> Local by design</span></footer>
      </main>
    </div>
    {toast && <div className="toast" role="status"><CheckCheck size={18} />{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className="modal" role="dialog" aria-modal="true" aria-label={modal === 'help' ? 'Quick guide' : 'Bundled scenario'} onClick={e => e.stopPropagation()}><button className="icon-button modal-close" aria-label="Close dialog" onClick={() => setModal(null)} autoFocus><X size={20} /></button><span className="modal-icon">{modal === 'help' ? <CircleHelp size={25} /> : <Box size={25} />}</span><h2>{modal === 'help' ? 'A closer look at every decision.' : 'One world. Three approaches.'}</h2>{modal === 'help' ? <><p>Rover Lab is an offline inspector for bundled simulated rover trajectories. It cannot connect to or operate a robot.</p><ol><li><strong>Choose a policy.</strong> Use the active policy selector to switch recorded runs.</li><li><strong>Follow the timeline.</strong> Play, step, or scrub to synchronize the map and sensor readings. Orange ticks mark unsafe frames.</li><li><strong>Investigate the first failure.</strong> Jump directly to the first unsafe action, then compare the other policies.</li><li><strong>Take the evidence with you.</strong> Export a deterministic JSON summary of all runs, safety events, and rankings.</li></ol><div className="modal-note">Safety rules: contact is always unsafe; moving with observations older than 500 ms or clearance below 2 m is flagged. Goals and reward are evaluated separately.</div></> : <><p>The bundled warehouse route tests goal seeking, obstacle avoidance, and response to delayed sensor observations.</p><div className="scenario-detail"><span>Scenario<strong>{SCENARIO.name}</strong></span><span>Environment<strong>100 × 70 m · 2 static obstacles</strong></span><span>Recording<strong>60 seconds · 2 Hz · seed {SCENARIO.seed}</strong></span><span>Policies<strong>PPO v2.4 / SAC v1.8 / Rule-based</strong></span><span>Goal positions<strong>(35, 42) → (65, 20) → (88, 12)</strong></span></div><div className="modal-note">All trajectories, contacts, observations, and reward traces are synthetic fixtures bundled with the app. No remote services are used.</div></>}<button className="button primary modal-done" onClick={() => setModal(null)}>Got it <ArrowRight size={15} /></button></section></div>}
  </div>;
}

function Metric({ icon, title, value, unit, footer, detail, tone = '' }: { icon: React.ReactNode; title: string; value: string; unit?: string; footer: string; detail: string; tone?: string }) {
  return <div className={`metric-card ${tone}`}><div className="metric-label"><span>{title}</span>{icon}</div><div className="metric-value">{value}<span>{unit}</span></div><div className="metric-footer"><span>{footer}</span><strong>{detail}</strong></div></div>;
}

function Sensor({ label, value, unit, warning }: { label: string; value: string; unit?: string; warning?: boolean }) {
  return <div className={`sensor ${warning ? 'sensor-warning' : ''}`}><span>{label}</span><strong>{value}<small>{unit}</small></strong></div>;
}

function WarehouseMap({ run, frame, showOther, showSensors, onContact, onGoal }: { run: PolicyRun; frame: ReplayFrame; showOther: boolean; showSensors: boolean; onContact: (index: number) => void; onGoal: (i: number) => void }) {
  const sx = (x: number) => 42 + x * 5.62;
  const sy = (y: number) => 26 + y * 4.96;
  const path = (r: PolicyRun) => r.frames.map(f => `${sx(f.x)},${sy(f.y)}`).join(' ');
  const contacts = run.frames.filter(f => f.contact);
  const contactLocations = contacts.filter((f, i) => contacts.findIndex(other => other.x === f.x && other.y === f.y) === i);
  return <svg className="warehouse-svg" viewBox="0 0 645 373" role="group" aria-label={`Warehouse map showing ${run.name} at x ${frame.x.toFixed(1)}, y ${frame.y.toFixed(1)}`}>
    <defs><pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="#dce2e5" strokeWidth="1" /></pattern><filter id="shadow"><feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity=".11" /></filter></defs>
    <rect x="20" y="20" width="602" height="348" rx="6" fill="#f7f9f8" stroke="#d9dfe1" /><rect x="20" y="20" width="602" height="348" rx="6" fill="url(#grid)" />
    <path d="M20 114H622 M20 264H622" stroke="#e5e9e9" strokeWidth="1" strokeDasharray="3 5" />
    <text x="35" y="53" className="map-zone">LOADING BAY</text><text x="35" y="350" className="map-zone">WEST CORRIDOR</text><text x="505" y="350" className="map-zone">EAST DOCKS</text>
    {SCENARIO.obstacles.map((o, i) => <g key={i} className="map-obstacle"><rect x={sx(o.x)} y={sy(o.y)} width={o.w * 5.62} height={o.h * 4.96} rx="3" fill="#d3d8dc" stroke="#b8c0c4" filter="url(#shadow)" /><path d={`M${sx(o.x) + 10} ${sy(o.y) + 12}l${o.w * 5.62 - 20} ${o.h * 4.96 - 24}M${sx(o.x) + o.w * 5.62 - 10} ${sy(o.y) + 12}l-${o.w * 5.62 - 20} ${o.h * 4.96 - 24}`} stroke="#b8c0c4" strokeWidth="1" /><text x={sx(o.x) + 8} y={sy(o.y) + o.h * 2.48 + 3} className="obstacle-label">OBSTACLE 0{i + 1}</text></g>)}
    {showOther && runs.filter(r => r.id !== run.id).map(r => <polyline key={r.id} points={path(r)} fill="none" stroke={colors[r.id]} strokeWidth="2" opacity=".3" strokeDasharray="5 5" />)}
    <polyline points={path(run)} fill="none" stroke={colors[run.id]} strokeWidth="3" opacity=".9" />
    {run.goals.map((goal, i) => <g key={goal.id} className="goal-point" onClick={() => onGoal(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGoal(i); } }} tabIndex={0} role="button" aria-label={`${goal.id} waypoint`}><circle cx={sx(goal.x)} cy={sy(goal.y)} r="10" fill="#fff" stroke="#2a9e93" strokeWidth="2" /><path d={`M${sx(goal.x) - 3} ${sy(goal.y) - 4}v9l4 -2 4 2v-9z`} fill="#2a9e93" /><text x={sx(goal.x) + 14} y={sy(goal.y) + 4} className="goal-label">{goal.id.replace('dock-', 'DOCK ')}</text></g>)}
    <g className="start-point"><circle cx={sx(SCENARIO.start.x)} cy={sy(SCENARIO.start.y)} r="7" fill="#fff" stroke="#738098" strokeWidth="2" /><circle cx={sx(SCENARIO.start.x)} cy={sy(SCENARIO.start.y)} r="2.5" fill="#738098" /><text x={sx(SCENARIO.start.x) - 10} y={sy(SCENARIO.start.y) + 22} className="start-label">START</text></g>
    {showSensors && <circle cx={sx(frame.x)} cy={sy(frame.y)} r={Math.max(10, Math.min(35, frame.clearance * 8))} fill={colors[run.id]} opacity=".08" stroke={colors[run.id]} strokeDasharray="3 4" />}
    <g className="rover-marker" transform={`translate(${sx(frame.x)} ${sy(frame.y)}) rotate(${frame.heading * 180 / Math.PI})`}><circle r="9" fill={colors[run.id]} stroke="#fff" strokeWidth="2" /><path d="M6 0L-5-5V5z" fill="#fff" /></g>
    {contactLocations.map(f => <g key={`contact-${f.index}`} className="collision-marker" onClick={() => onContact(f.index)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onContact(f.index); } }} tabIndex={0} role="button" aria-label={`Collision marker at ${formatTime(f.time)}, frame ${f.index}`}><title>Inspect contact at {formatTime(f.time)}. Use contact frame buttons below the map to inspect each recorded contact.</title><circle cx={sx(f.x)} cy={sy(f.y)} r="12" fill="#fff7f1" stroke="#d65f44" strokeWidth="2" /><circle cx={sx(f.x)} cy={sy(f.y)} r="16" fill="none" stroke="#d65f44" strokeWidth="1" strokeDasharray="2 3" opacity=".75" /><path d={`M${sx(f.x) - 4} ${sy(f.y) - 4}l8 8m0-8l-8 8`} stroke="#d65f44" strokeWidth="2" /><text x={sx(f.x) + 19} y={sy(f.y) - 17} className="collision-label">CONTACT · {formatTime(f.time)}</text></g>)}
    <text x="37" y="14" className="axis-label">N</text><path d="M38 19v-7m0-2l-3 4h6z" stroke="#6f7a7e" fill="none" /><text x="601" y="359" className="axis-label">100m</text>
  </svg>;
}

function Timeline({ run, index, evidence, seek, playing, togglePlay, speed, setSpeed }: { run: PolicyRun; index: number; evidence: DecisionEvidence; seek: (i: number) => void; playing: boolean; togglePlay: () => void; speed: number; setSpeed: (v: number) => void }) {
  const frame = run.frames[index];
  return <section className="panel timeline-panel">
    <div className="timeline-heading"><div className="panel-title"><Gauge size={16} /><h2>Decision timeline</h2><span className="subtle-tag">{run.frames.length} FRAMES</span></div><div className="timeline-readout"><span className="mono">{formatTime(frame.time)}</span><span>/</span><span className="mono">01:00.0</span><span className="timeline-divider" /><span className="live-read"><i /> {playing ? 'PLAYING' : 'PAUSED'}</span></div></div>
    <div className="decision-evidence" aria-label="Decision evidence for selected frame">
      <div className="decision-evidence-title"><span><Crosshair size={14} /> ACTION {String(index).padStart(3, '0')}</span><b>{evidence.actionLabel}</b><strong>{evidence.steeringLabel}</strong><span className={`decision-status ${evidence.timing === 'delayed-while-moving' ? 'delayed' : evidence.contact ? 'contact' : 'synced'}`}><i /> {evidence.timing === 'delayed-while-moving' ? 'DELAYED INPUT' : evidence.timing === 'stale-while-stationary' ? 'STALE · STATIONARY' : evidence.contact ? 'CONTACT' : 'WITHIN TIMING LIMIT'}</span></div>
      <div className="decision-evidence-grid"><span><small>DECISION TIME</small><b>{timingStamp(evidence.decisionTime)}</b></span><span><small>OBSERVATION TAKEN</small><b>{timingStamp(evidence.observationTime)}</b></span><span><small>OBSERVATION AGE</small><b className={evidence.timing === 'delayed-while-moving' ? 'alert-value' : ''}>{evidence.observationAgeMs} ms</b></span><span><small>READINGS AT ACTION</small><b>{frame.speed.toFixed(2)} m/s · {frame.clearance.toFixed(2)} m clr</b></span><span><small>REWARD</small><b className={evidence.reward < 0 ? 'alert-value' : ''}>{evidence.reward >= 0 ? '+' : ''}{evidence.reward.toFixed(2)}</b></span></div>
    </div>
    <div className="scrubber-wrap">
      <div className="reward-strip"><span>REWARD TRACE <b>{frame.reward >= 0 ? '+' : ''}{frame.reward.toFixed(2)}</b></span><svg viewBox="0 0 1000 28" preserveAspectRatio="none" role="img" aria-label="Per-frame reward trace">{run.frames.map(f => <rect key={f.index} x={f.index / 121 * 1000} y={f.reward >= 0 ? 14 - Math.min(12, f.reward * 2) : 14} width="5" height={Math.max(.7, Math.min(12, Math.abs(f.reward) * 2))} fill={f.reward < 0 ? '#e98641' : '#5fae9f'} opacity={f.index === index ? 1 : .6} />)}<line x1="0" x2="1000" y1="14" y2="14" stroke="#e5eae8" /></svg></div>
      <div className="scrubber-track"><div className="scrubber-progress" style={{ width: `${index / (run.frames.length - 1) * 100}%` }} /><span className="scrubber-knob" style={{ left: `${index / (run.frames.length - 1) * 100}%` }} /><div className="event-ticks">
        {analyzeRun(run).events.map((event, i) => <button key={`${event.frameIndex}-${i}`} className={`event-tick ${event.type}`} style={{ left: `${event.frameIndex / (run.frames.length - 1) * 100}%` }} aria-label={`Jump to ${event.title} at ${formatTime(event.time)}`} onClick={() => seek(event.frameIndex)} />)}
        {run.frames.filter(f => f.goalReached).map(f => <button key={`goal-${f.index}`} className="event-tick goal" style={{ left: `${f.index / (run.frames.length - 1) * 100}%` }} aria-label={`Jump to goal at ${formatTime(f.time)}`} onClick={() => seek(f.index)} />)}
      </div><input aria-label="Replay timeline" aria-valuetext={`${formatTime(frame.time)}, frame ${index}`} type="range" min="0" max={run.frames.length - 1} value={index} onChange={e => seek(Number(e.target.value))} /></div>
      <div className="time-axis"><span>00:00</span><span>00:15</span><span>00:30</span><span>00:45</span><span>01:00</span></div>
    </div>
    <div className="timeline-controls"><div className="control-group"><button className="icon-button" aria-label="Restart replay" onClick={() => seek(0)}><RotateCcw size={16} /></button><button className="icon-button" aria-label="Previous frame" onClick={() => seek(index - 1)}><SkipBack size={16} /></button><button className="play-button" onClick={togglePlay} aria-label={playing ? 'Pause replay' : 'Play replay'}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><button className="icon-button" aria-label="Next frame" onClick={() => seek(index + 1)}><SkipForward size={16} /></button></div><div className="timeline-hint"><span className="orange-tick" /> Safety event <span className="hint-divider" /><span className="teal-tick" /> Goal reached <span className="hint-divider" /><MousePointer2 size={13} /> Click timeline to inspect</div><div className="speed-control"><span>SPEED</span>{[.5, 1, 2].map(v => <button key={v} className={speed === v ? 'speed-active' : ''} onClick={() => setSpeed(v)}>{v}×</button>)}</div></div>
  </section>;
}

function RewardChart() {
  const points = (r: PolicyRun) => cumulativeRewards(r.frames).map(point => ({ x: point.time, y: point.totalReward }));
  const all = runs.flatMap(r => points(r).map(p => p.y));
  const max = Math.ceil(Math.max(...all) / 10) * 10;
  const min = Math.floor(Math.min(0, ...all) / 10) * 10;
  const y = (value: number) => 220 - (value - min) / (max - min) * 190;
  const path = (r: PolicyRun) => points(r).map((p, i) => `${i ? 'L' : 'M'} ${30 + p.x * 8.95} ${y(p.y)}`).join(' ');
  return <div className="reward-chart"><svg viewBox="0 0 580 260" role="img" aria-label="Cumulative reward chart"><path d="M30 30V220H566" stroke="#d7dddf" fill="none" />{[0, .5, 1].map(fraction => { const value = min + fraction * (max - min); return <g key={fraction}><path d={`M30 ${y(value)}H566`} stroke="#e7ebec" strokeDasharray="3 4" /><text x="4" y={y(value) + 3}>{value.toFixed(0)}</text></g>; })}<text x="28" y="244">0s</text><text x="290" y="244">30s</text><text x="543" y="244">60s</text>{runs.map(r => <path key={r.id} d={path(r)} fill="none" stroke={colors[r.id]} strokeWidth={r.id === 'ppo' ? 3 : 2} strokeDasharray={r.id === 'baseline' ? '5 4' : undefined} />)}{runs.map(r => { const ps = points(r); const p = ps[ps.length - 1]; return <circle key={`${r.id}-end`} cx={30 + p.x * 8.95} cy={y(p.y)} r="4" fill={colors[r.id]} stroke="#fff" strokeWidth="2" />; })}</svg><div className="chart-legend">{runs.map(r => <span key={r.id}><i style={{ background: colors[r.id] }} />{r.name}</span>)}</div></div>;
}

export default App;
