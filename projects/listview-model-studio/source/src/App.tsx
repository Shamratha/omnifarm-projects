import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch } from 'react'
import {
  Activity,
  ArrowDownUp,
  ArrowUpRight,
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  CirclePlus,
  Code2,
  Database,
  Download,
  Eye,
  Filter,
  Layers3,
  MousePointer2,
  Pencil,
  Plus,
  Play,
  Redo2,
  RefreshCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareStack,
  Trash2,
  Undo2,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import {
  Action,
  CATEGORIES,
  Category,
  createInitialState,
  createNewItem,
  ItemPatch,
  selectVisibleIds,
  countVisible,
} from './model'
import type { ScenarioDocument } from './scenario'
import VirtualListPreview from './VirtualListPreview'
import {
  applyHistory,
  createHistory,
  HistoryState,
  parseScenario,
  parseSnapshot,
  redoHistory,
  runScenario,
  ScenarioStep,
  serializeScenario,
  serializeSnapshot,
  undoHistory,
} from './scenario'

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(
    new Date(timestamp),
  )
}

function compactNumber(value: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function EventIcon({ kind }: { kind: string }) {
  if (kind === 'add') return <CirclePlus size={16} />
  if (kind === 'remove') return <Trash2 size={15} />
  if (kind === 'update') return <Pencil size={15} />
  if (kind === 'transaction') return <SquareStack size={15} />
  if (kind === 'reorder') return <ArrowDownUp size={15} />
  if (kind === 'filter') return <Filter size={15} />
  if (kind === 'selection') return <MousePointer2 size={15} />
  return <Database size={15} />
}

type Draft = {
  title: string
  category: Category
  value: string
  active: boolean
}

function App() {
  const [history, setHistory] = useState<HistoryState>(() => createHistory(createInitialState()))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [scenarioText, setScenarioText] = useState(() => JSON.stringify({
    format: 'listview-model-studio-scenario',
    version: 1,
    name: 'Update, filter, and select',
    operations: [
      { type: 'update', id: 'fixture-00001', patch: { title: 'Scenario-edited item', value: 250 } },
      { type: 'set-filter', filter: { query: 'scenario-edited' } },
      { type: 'select', id: 'fixture-00001' },
    ],
  }, null, 2))
  const [scenarioSteps, setScenarioSteps] = useState<ScenarioStep[]>([])
  const [scenarioStepIndex, setScenarioStepIndex] = useState(0)
  const [scenarioStatus, setScenarioStatus] = useState('Ready for a scenario.')
  const importInputRef = useRef<HTMLInputElement>(null)
  const scenarioInputRef = useRef<HTMLInputElement>(null)
  const state = history.present
  const dispatch: Dispatch<Action> = (action) => setHistory((current) => applyHistory(current, action))
  const visibleIds = useMemo(() => selectVisibleIds(state), [state])
  const totalVisible = useMemo(() => countVisible(state), [state])
  const selectedItem = state.selectedIds.length === 1 ? state.itemsById[state.selectedIds[0]] : undefined
  const selectedVisibleCount = state.selectedIds.filter((id) => visibleIds.includes(id)).length

  useEffect(() => {
    if (!selectedItem) {
      setDraft(null)
      return
    }
    setDraft({
      title: selectedItem.title,
      category: selectedItem.category,
      value: String(selectedItem.value),
      active: selectedItem.active,
    })
  }, [selectedItem?.id, selectedItem?.revision])

  const addItem = () => dispatch({ type: 'add', item: createNewItem(state.nextItemNumber) })

  const batchIncrementSelected = () => {
    if (state.selectedIds.length === 0) return
    dispatch({
      type: 'batch',
      label: 'Batch +1 selected',
      operations: state.selectedIds.map((id) => ({
        type: 'update' as const,
        id,
        patch: { value: state.itemsById[id].value + 1 },
      })),
    })
  }

  const applyUpdate = () => {
    if (!selectedItem || !draft || !draft.title.trim()) return
    const patch: ItemPatch = {
      title: draft.title.trim(),
      category: draft.category,
      value: Math.max(0, Number(draft.value) || 0),
      active: draft.active,
    }
    dispatch({ type: 'update', id: selectedItem.id, patch })
  }

  const downloadJson = (filename: string, content: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportSnapshot = () => downloadJson('listview-model-snapshot.json', serializeSnapshot(state))

  const importSnapshot = async (file: File) => {
    try {
      const imported = parseSnapshot(await file.text())
      setHistory((current) => ({ past: [...current.past, current.present], present: imported, future: [] }))
      setScenarioSteps([])
      setScenarioStatus(`Imported ${imported.order.length.toLocaleString()} records. History can undo this import.`)
    } catch (error) {
      setScenarioStatus(`Snapshot rejected: ${error instanceof Error ? error.message : 'invalid snapshot'}`)
    }
  }

  const validateScenarioText = () => {
    try {
      const document = parseScenario(scenarioText)
      setScenarioStatus(`Scenario is valid: ${document.operations.length} operation${document.operations.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setScenarioStatus(`Scenario rejected before execution: ${error instanceof Error ? error.message : 'invalid scenario'}`)
    }
  }

  const runScenarioText = () => {
    let document: ScenarioDocument
    try {
      document = parseScenario(scenarioText)
    } catch (error) {
      setScenarioStatus(`Scenario rejected before execution: ${error instanceof Error ? error.message : 'invalid scenario'}`)
      return
    }
    try {
      const result = runScenario(state, document)
      setHistory((current) => ({ past: [...current.past, current.present], present: result.state, future: [] }))
      setScenarioSteps(result.steps)
      setScenarioStepIndex(0)
      setScenarioStatus(`Ran ${document.operations.length} operation${document.operations.length === 1 ? '' : 's'} with ${result.steps.length} snapshots.`)
    } catch (error) {
      setScenarioStatus(`Scenario rejected before execution: ${error instanceof Error ? error.message : 'state validation failed'}`)
    }
  }

  const importScenario = async (file: File) => {
    setScenarioText(await file.text())
    setScenarioStatus('Scenario file loaded. Validate it before execution.')
  }

  const scenarioStep = scenarioSteps[scenarioStepIndex]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Layers3 size={19} strokeWidth={2.5} /></div>
          <div>
            <div className="brand-name">model studio</div>
            <div className="brand-caption">ListView playground</div>
          </div>
        </div>

        <div className="sidebar-section-label">Workspace</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          <button className="side-nav-item is-current"><Braces size={17} /> Model playground <span className="nav-ping" /></button>
          <button className="side-nav-item"><Eye size={17} /> Render preview</button>
          <button className="side-nav-item"><Activity size={17} /> Event stream</button>
        </nav>

        <div className="sidebar-section-label side-label-spaced">Concepts</div>
        <div className="concept-list">
          <div><span className="concept-dot dot-violet" /> Stable identity</div>
          <div><span className="concept-dot dot-teal" /> Incremental updates</div>
          <div><span className="concept-dot dot-orange" /> Derived filters</div>
        </div>

        <div className="sidebar-bottom">
          <div className="fixture-card">
            <div className="fixture-card-top"><span className="live-dot" /> LOCAL FIXTURE <ShieldCheck size={13} /></div>
            <div className="fixture-count">12,000 <span>items loaded</span></div>
            <div className="fixture-bar"><span /></div>
            <div className="fixture-foot"><span>seed: 2025-01</span><span className="fixture-ready">ready</span></div>
          </div>
          <div className="sidebar-footer"><CircleHelp size={15} /> Docs &amp; model notes <ArrowUpRight size={13} /></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><ChevronDown size={13} /><strong>ListView model</strong></div>
          <div className="topbar-actions">
            <span className="runtime-pill"><span className="live-dot" /> Runtime active</span>
            <button className="icon-button" title="Reset the local fixture" onClick={() => dispatch({ type: 'reset' })}><RefreshCcw size={17} /></button>
            <div className="avatar">BW</div>
          </div>
        </header>

        <div className="content-wrap">
          <section className="intro-row">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> INCREMENTAL UI LAB</div>
              <h1>ListView model <span>studio</span></h1>
              <p className="intro-copy">Make a change. Watch one item update. Learn the model.</p>
            </div>
            <div className="intro-actions">
              <button className="button button-quiet" disabled={!history.past.length} onClick={() => setHistory(undoHistory)}><Undo2 size={15} /> Undo</button>
              <button className="button button-quiet" disabled={!history.future.length} onClick={() => setHistory(redoHistory)}><Redo2 size={15} /> Redo</button>
              <button className="button button-quiet" onClick={() => dispatch({ type: 'clear-events' })}><Trash2 size={15} /> Clear log</button>
              <button className="button button-primary" onClick={addItem}><Plus size={17} /> Add item</button>
            </div>
          </section>

          <section className="hero-card">
            <div className="hero-copy">
              <div className="hero-kicker"><Sparkles size={14} /> A small model with a big job</div>
              <h2>Change the data,<br /><em>not the whole list.</em></h2>
              <p>Stable IDs keep identity intact while add, remove, update, and filter operations flow through the preview.</p>
              <div className="hero-tags"><span><Check size={13} /> keyed rows</span><span><Check size={13} /> local only</span><span><Check size={13} /> beginner-friendly</span></div>
            </div>
            <div className="hero-graphic" aria-hidden="true">
              <div className="graphic-orbit orbit-one" /><div className="graphic-orbit orbit-two" />
              <div className="graphic-node node-main"><Zap size={21} fill="currentColor" /></div>
              <div className="graphic-node node-a">id</div><div className="graphic-node node-b">+</div><div className="graphic-node node-c">↻</div>
              <div className="graphic-line line-a" /><div className="graphic-line line-b" /><div className="graphic-line line-c" />
            </div>
            <div className="hero-metrics">
              <div><strong>{compactNumber(state.order.length)}</strong><span>items in model</span></div>
              <div><strong>{compactNumber(totalVisible)}</strong><span>match filter</span></div>
              <div><strong>{state.events.length}</strong><span>events logged</span></div>
            </div>
          </section>

          <section className="toolbar-card">
            <div className="toolbar-search">
              <Search size={18} />
              <input
                value={state.filter.query}
                onChange={(event) => dispatch({ type: 'set-filter', filter: { query: event.target.value } })}
                placeholder="Search title, description, or ID…"
                aria-label="Search list items"
              />
              {state.filter.query && <button className="search-clear" title="Clear search" onClick={() => dispatch({ type: 'set-filter', filter: { query: '' } })}><X size={15} /></button>}
              <kbd>/</kbd>
            </div>
            <div className="toolbar-divider" />
            <label className="select-control">
              <span>Category</span>
              <select value={state.filter.category} onChange={(event) => dispatch({ type: 'set-filter', filter: { category: event.target.value as Category | 'All' } })}>
                <option value="All">All categories</option>
                {CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="check-control">
              <input type="checkbox" checked={state.filter.activeOnly} onChange={(event) => dispatch({ type: 'set-filter', filter: { activeOnly: event.target.checked } })} />
              <span className="fake-check"><Check size={12} /></span> Active only
            </label>
            <div className="toolbar-spacer" />
            <div className="mode-control">
              <span className="mode-label">Select</span>
              <button className={state.selectionMode === 'single' ? 'mode-button is-selected' : 'mode-button'} onClick={() => dispatch({ type: 'set-selection-mode', mode: 'single' })}>Single</button>
              <button className={state.selectionMode === 'multiple' ? 'mode-button is-selected' : 'mode-button'} onClick={() => dispatch({ type: 'set-selection-mode', mode: 'multiple' })}>Multi</button>
            </div>
          </section>

          <section className="operations-strip" aria-label="Model operations">
            <button className="button button-primary" disabled={state.selectedIds.length === 0} aria-describedby="operations-help" onClick={batchIncrementSelected}><SquareStack size={15} /> Batch +1 selected</button>
            <button className="button button-quiet" disabled={state.selectedIds.length === 0} aria-describedby="operations-help" onClick={() => dispatch({ type: 'remove', ids: state.selectedIds })}><Trash2 size={15} /> Remove selected</button>
            <button className="button button-quiet" disabled={state.order.length < 2} aria-describedby="operations-help" onClick={() => dispatch({ type: 'reorder', ids: [...state.order].reverse() })}><ArrowDownUp size={15} /> Reverse order</button>
            <p id="operations-help">Select rows to batch +1 or remove, including hidden selected IDs. A batch commits all updates together in one transaction. Reverse affects the full model.</p>
            <div className="operation-metrics" aria-label="Model update counters">
              <span>MODEL UPDATES</span><strong>{state.updateMetrics.requested}</strong><small>requested</small><strong className="metric-good">{state.updateMetrics.changed}</strong><small>changed</small><strong>{state.updateMetrics.skipped}</strong><small>skipped</small><strong className="metric-bad">{state.updateMetrics.rejected}</strong><small>rejected</small><strong>{state.updateMetrics.transactions}</strong><small>transactions</small>
            </div>
          </section>

          <section className="workspace-grid">
            <VirtualListPreview state={state} visibleIds={visibleIds} dispatch={dispatch} />

            <aside className="inspector-panel panel-card">
              <div className="panel-heading"><div><div className="panel-title"><span className="heading-icon icon-teal"><Settings2 size={16} /></span> Model inspector</div><div className="panel-subtitle">State at this exact moment</div></div><button className="small-icon-button" title="Inspector help"><CircleHelp size={16} /></button></div>
              <div className="inspector-stats">
                <div><span>Total</span><strong>{compactNumber(state.order.length)}</strong></div>
                <div><span>Visible</span><strong>{compactNumber(totalVisible)}</strong></div>
                <div><span>Selected</span><strong className={state.selectedIds.length ? 'text-violet' : ''}>{state.selectedIds.length}</strong></div>
              </div>
              <div className="selection-banner"><MousePointer2 size={15} /><span><strong>{state.selectedIds.length ? `${state.selectedIds.length} selected` : 'Nothing selected'}</strong>{state.selectedIds.length > 0 && selectedVisibleCount !== state.selectedIds.length ? ` · ${state.selectedIds.length - selectedVisibleCount} hidden by filter` : ' · click a row to inspect'}</span>{state.selectedIds.length > 0 && <button onClick={() => dispatch({ type: 'clear-selection' })}>Clear</button>}</div>

              {selectedItem && draft ? (
                <div className="editor-form">
                  <div className="editor-kicker"><Pencil size={13} /> EDITING ITEM <span>REV {selectedItem.revision}</span></div>
                  <div className="stable-id-display"><span className="id-lock"><ShieldCheck size={14} /></span><div><span>Stable identity</span><strong>{selectedItem.id}</strong></div><span className="locked-label">LOCKED</span></div>
                  <label className="field-label">Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
                  <div className="field-row"><label className="field-label">Category<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as Category })}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label><label className="field-label">Value<input type="number" min="0" value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} /></label></div>
                  <label className="toggle-field"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span className="toggle-track"><span /></span><span>Active item</span></label>
                  <button className="button button-update" onClick={applyUpdate}><Zap size={15} /> Apply update <span>⌘ ↵</span></button>
                </div>
              ) : state.selectedIds.length > 1 ? (
                <div className="multi-selection-card"><div className="multi-icon"><SquareStack size={21} /></div><strong>Multiple items selected</strong><p>Use modifier-click or shift-click to adjust the selection range. Batch +1 selected updates all selected values in one transaction. Batch and remove include hidden selected IDs.</p><div className="selected-id-list">{state.selectedIds.slice(0, 5).map((id) => <span key={id}>{id}</span>)}{state.selectedIds.length > 5 && <span>+{state.selectedIds.length - 5} more</span>}</div></div>
              ) : (
                <div className="inspector-empty"><div className="empty-illustration"><MousePointer2 size={22} /></div><strong>Select an item to inspect</strong><p>Click any preview row to see its stable ID, fields, and revision.</p><div className="empty-tip"><Zap size={13} /> Tip: cmd/ctrl-click for multi-select</div></div>
              )}
              <div className="inspector-footer"><span>Model status</span><span className="status-ok"><span className="live-dot" /> consistent</span></div>
            </aside>
          </section>

          <section className="scenario-panel panel-card">
            <div className="panel-heading">
              <div><div className="panel-title"><span className="heading-icon icon-purple"><Code2 size={16} /></span> Scenario authoring</div><div className="panel-subtitle">Validate the full sequence, then inspect every state transition</div></div>
              <div className="scenario-actions">
                <button className="button button-quiet" onClick={exportSnapshot}><Download size={14} /> Export model</button>
                <button className="button button-quiet" onClick={() => importInputRef.current?.click()}><Upload size={14} /> Import model</button>
              </div>
            </div>
            <input className="sr-only" type="file" accept="application/json,.json" ref={importInputRef} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importSnapshot(file); event.target.value = '' }} />
            <input className="sr-only" type="file" accept="application/json,.json" ref={scenarioInputRef} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importScenario(file); event.target.value = '' }} />
            <div className="scenario-grid">
              <div className="scenario-editor">
                <label htmlFor="scenario-json">Scenario JSON <span>v1 · up to 200 operations</span></label>
                <textarea id="scenario-json" value={scenarioText} spellCheck={false} onChange={(event) => setScenarioText(event.target.value)} />
                <div className="scenario-actions">
                  <button className="button button-quiet" onClick={() => scenarioInputRef.current?.click()}><Upload size={14} /> Load scenario</button>
                  <button className="button button-quiet" onClick={() => { try { downloadJson('listview-scenario.json', serializeScenario(parseScenario(scenarioText))) } catch (error) { setScenarioStatus(`Scenario export rejected: ${error instanceof Error ? error.message : 'invalid scenario'}`) } }}><Download size={14} /> Save scenario</button>
                  <button className="button button-quiet" onClick={validateScenarioText}><ShieldCheck size={14} /> Validate</button>
                  <button className="button button-primary" onClick={runScenarioText}><Play size={14} /> Run</button>
                </div>
                <p className="scenario-status" role="status" aria-live="polite">{scenarioStatus}</p>
                <p className="scenario-help">Model imports and successful runs are one undoable edit each. Browsing a recorded step does not change the live model.</p>
              </div>
              <div className="scenario-trace">
                <div className="trace-heading"><strong>Operation snapshots</strong><span>{scenarioSteps.length ? `${scenarioSteps.length} recorded states` : 'No run yet'}</span></div>
                {scenarioSteps.length ? <>
                  <label className="trace-step-select">Inspect step <select value={scenarioStepIndex} onChange={(event) => setScenarioStepIndex(Number(event.target.value))}>{scenarioSteps.map((step) => <option key={step.index} value={step.index}>{step.index === 0 ? '0 · Initial state' : `${step.index} · ${step.operation?.type}`}</option>)}</select></label>
                  <div className="trace-summary"><strong>{scenarioStep?.summary}</strong><span>{scenarioStep?.model.total.toLocaleString()} total · {scenarioStep?.visible.count.toLocaleString()} matching · {scenarioStep?.model.selectedIds.length} selected</span></div>
                  <div className="trace-json-grid"><div><h3>Model state</h3><pre>{JSON.stringify({ ...scenarioStep?.model, itemsById: undefined }, null, 2)}</pre></div><div><h3>Visible view</h3><pre>{JSON.stringify(scenarioStep?.visible, null, 2)}</pre></div></div>
                  <details className="trace-items"><summary>Full item state after this operation</summary><pre>{JSON.stringify(scenarioStep?.model.itemsById, null, 2)}</pre></details>
                </> : <div className="trace-empty"><Code2 size={24} /><strong>Trace each operation</strong><p>Run a scenario to see the initial state plus the model and visible view after every operation.</p></div>}
              </div>
            </div>
          </section>

          <section className="events-panel panel-card">
            <div className="panel-heading"><div><div className="panel-title"><span className="heading-icon icon-orange"><Activity size={16} /></span> Event log</div><div className="panel-subtitle">Every state operation, in order</div></div><div className="event-summary"><span className="event-count">{state.events.length}</span> events <span className="event-live"><span className="live-dot" /> listening</span></div></div>
            <div className="event-list">
              {state.events.slice(0, 6).map((event) => <div className="event-row" key={event.id}><span className={`event-icon event-${event.kind}`}><EventIcon kind={event.kind} /></span><div className="event-main"><strong>{event.summary}</strong><span>{event.detail}</span></div><span className="event-target">{event.targetIds.length ? event.targetIds[0] : 'model'}</span><time>{formatTime(event.timestamp)}</time><span className={`event-status status-${event.status}`}>{event.status}</span></div>)}
              {state.events.length === 0 && <div className="event-empty">Event log is clear. Make a change to start a new trace.</div>}
            </div>
            {state.events.length > 6 && <div className="event-footer">Showing latest 6 events <span>·</span> {state.events.length - 6} earlier events in local history</div>}
          </section>

          <footer className="page-footer"><span><BookOpen size={14} /> Inspired by cross-platform ListView component design</span><span>MIT App Inventor · <a href="https://summerofcode.withgoogle.com/programs/2026/projects/sxZpFLJk" target="_blank" rel="noreferrer">source reference <ArrowUpRight size={12} /></a></span></footer>
        </div>
      </main>
    </div>
  )
}

export default App
