import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent } from 'react'
import { Check, Database, ListFilter, Search } from 'lucide-react'
import type { Action, ModelState } from './model'
import { selectionAnnouncement } from './accessibility'
import { calculateVirtualRange, OVERSCAN_ROWS, ROW_HEIGHT, scrollTopForIndex } from './virtualization'

type Props = {
  state: ModelState
  visibleIds: string[]
  dispatch: Dispatch<Action>
}

export default function VirtualListPreview({ state, visibleIds, dispatch }: Props) {
  const prefix = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [jumpId, setJumpId] = useState('')
  const [jumpStatus, setJumpStatus] = useState('')
  const previousFilter = useRef(state.filter)
  const previousSelectedIds = useRef(state.selectedIds)
  const pendingFocusId = useRef<string | null>(null)
  const selectedSet = useMemo(() => new Set(state.selectedIds), [state.selectedIds])
  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds])
  const range = calculateVirtualRange(visibleIds.length, scrollTop, viewportHeight)
  const mountedIds = visibleIds.slice(range.start, range.end)
  const optionId = (id: string) => `${prefix}-option-${encodeURIComponent(id)}`
  const mountedActiveId = activeId && mountedIds.includes(activeId) ? optionId(activeId) : undefined

  const announcement = selectionAnnouncement(previousSelectedIds.current, state.selectedIds, visibleIds, state.itemsById)

  useEffect(() => {
    previousSelectedIds.current = state.selectedIds
  }, [state.selectedIds])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      setViewportHeight(list.clientHeight)
      setScrollTop(list.scrollTop)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const filterChanged = previousFilter.current !== state.filter
    previousFilter.current = state.filter
    const nextTop = filterChanged ? 0 : calculateVirtualRange(visibleIds.length, list.scrollTop, list.clientHeight).scrollTop
    list.scrollTop = nextTop
    setScrollTop(nextTop)
    // Focus fallback never changes model selection. Hidden or removed active IDs
    // are replaced with the first matching item, or null for an empty projection.
    setActiveId((current) => current && visibleIds.includes(current) ? current : visibleIds[0] ?? null)
  }, [state.filter, visibleIds])

  useLayoutEffect(() => {
    const list = listRef.current
    const pendingId = pendingFocusId.current
    if (!list || !pendingId || !mountedIds.includes(pendingId)) return
    pendingFocusId.current = null
    list.focus({ preventScroll: true })
  }, [mountedIds, scrollTop])

  const reveal = (id: string, focusList = true) => {
    const list = listRef.current
    const index = visibleIds.indexOf(id)
    if (!list || index < 0) return false
    const nextTop = scrollTopForIndex(index, list.scrollTop, list.clientHeight, ROW_HEIGHT, visibleIds.length)
    list.scrollTop = nextTop
    setScrollTop(nextTop)
    setActiveId(id)
    if (focusList) pendingFocusId.current = id
    return true
  }

  const jumpToItem = () => {
    const id = jumpId.trim()
    if (!Object.hasOwn(state.itemsById, id)) {
      setJumpStatus(`Item ${id || '(empty ID)'} was not found.`)
      return
    }
    if (!visibleSet.has(id)) {
      setJumpStatus(`Item ${id} is hidden by the current filter. Clear the filter to scroll to it.`)
      return
    }
    reveal(id)
    setJumpStatus(`Scrolled to ${id}. Selection unchanged.`)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch({ type: 'clear-selection' })
      return
    }
    if (!visibleIds.length) return
    const index = activeId ? visibleIds.indexOf(activeId) : -1
    const current = Math.max(0, index)
    const pageRows = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT))
    let nextIndex: number | undefined
    switch (event.key) {
      case 'ArrowDown': nextIndex = index < 0 ? 0 : current + 1; break
      case 'ArrowUp': nextIndex = current - 1; break
      case 'Home': nextIndex = 0; break
      case 'End': nextIndex = visibleIds.length - 1; break
      case 'PageDown': nextIndex = current + pageRows; break
      case 'PageUp': nextIndex = current - pageRows; break
      case ' ':
      case 'Enter': {
        event.preventDefault()
        const id = visibleIds[current]
        reveal(id)
        if (state.selectionMode === 'multiple' && !event.shiftKey && state.selectedIds.length === 1 && state.selectedIds.includes(id)) {
          dispatch({ type: 'clear-selection' })
        } else {
          dispatch({ type: 'select', id, additive: state.selectionMode === 'multiple', range: event.shiftKey })
        }
        return
      }
      default: return
    }
    event.preventDefault()
    const target = visibleIds[Math.min(visibleIds.length - 1, Math.max(0, nextIndex))]
    if (event.shiftKey && state.selectionMode === 'multiple') {
      // Establish the keyboard starting point if no visible selection anchor exists.
      if (!state.anchorId || !visibleSet.has(state.anchorId)) {
        dispatch({ type: 'select', id: visibleIds[current], additive: true })
      }
      dispatch({ type: 'select', id: target, range: true })
    }
    reveal(target)
  }

  return (
    <div className="preview-panel panel-card">
      <div className="panel-heading preview-heading">
        <div><div className="panel-title"><span className="heading-icon icon-purple"><ListFilter size={16} /></span> Rendered preview</div><div className="panel-subtitle">Virtual window over the complete filtered order</div></div>
        <div className="preview-status"><span className="live-dot" /> LIVE <span className="preview-divider" /> <span data-testid="rendered-count">{mountedIds.length}</span> mounted / {visibleIds.length.toLocaleString()} matching</div>
      </div>
      <form className="scroll-controls" onSubmit={(event) => { event.preventDefault(); jumpToItem() }}>
        <label htmlFor={`${prefix}-jump`}>Scroll to ID</label>
        <input id={`${prefix}-jump`} value={jumpId} onChange={(event) => setJumpId(event.target.value)} placeholder="fixture-10000" aria-describedby={`${prefix}-jump-status`} />
        <button className="button button-quiet" type="submit">Go to item</button>
        <button className="button button-quiet" type="button" disabled={!state.selectedIds.length} onClick={() => { setJumpId(state.selectedIds[0]); const id = state.selectedIds[0]; if (visibleSet.has(id)) { reveal(id); setJumpStatus(`Scrolled to ${id}. Selection unchanged.`) } else setJumpStatus(`Item ${id} is hidden by the current filter.`) }}>Show selected</button>
      </form>
      <div id={`${prefix}-jump-status`} className="jump-status" role="status" aria-live="polite">{jumpStatus}</div>
      <div className="list-header" aria-hidden="true"><span /><span>ITEM</span><span>CATEGORY</span><span>VALUE</span><span>STATE</span><span>STABLE ID</span></div>
      <div
        ref={listRef}
        className="item-list virtual-list"
        role="listbox"
        tabIndex={0}
        aria-label="Rendered model items"
        aria-describedby={`${prefix}-keyboard-help`}
        aria-multiselectable={state.selectionMode === 'multiple'}
        aria-activedescendant={mountedActiveId}
        onKeyDown={handleKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onFocus={() => { if (!activeId || !mountedIds.includes(activeId)) setActiveId(visibleIds[Math.floor((listRef.current?.scrollTop ?? 0) / ROW_HEIGHT)] ?? null) }}
        data-testid="virtual-list"
        data-viewport-height={viewportHeight}
        data-scroll-top={range.scrollTop}
        data-range-start={range.start}
        data-range-end={range.end}
        data-rendered-count={mountedIds.length}
      >
        <div style={{ height: range.top }} role="presentation" aria-hidden="true" />
        {mountedIds.map((id, offset) => {
          const item = state.itemsById[id]
          const isSelected = selectedSet.has(id)
          return (
            <div
              className={`item-row ${isSelected ? 'is-selected' : ''} ${id === activeId ? 'is-focused' : ''}`}
              key={id}
              id={optionId(id)}
              role="option"
              aria-selected={isSelected}
              aria-posinset={range.start + offset + 1}
              aria-setsize={visibleIds.length}
              aria-label={`${item.title}, ${item.category}, value ${item.value}, ${item.active ? 'active' : 'paused'}, ${id}`}
              data-item-id={id}
              style={{ height: ROW_HEIGHT }}
              onClick={(event) => { reveal(id); dispatch({ type: 'select', id, additive: state.selectionMode === 'multiple' && (event.metaKey || event.ctrlKey), range: event.shiftKey }) }}
            >
              <span className="row-check" aria-hidden="true" onClick={(event) => { event.stopPropagation(); reveal(id); dispatch({ type: 'select', id, additive: state.selectionMode === 'multiple' }) }}><span className={`fake-check ${isSelected ? 'checked' : ''}`}><Check size={12} /></span></span>
              <div className="item-primary"><span className="item-avatar">{item.title.charAt(0)}</span><div><strong>{item.title}</strong><span>{item.description}</span></div></div>
              <span className={`category-pill category-${item.category.toLowerCase()}`}>{item.category}</span>
              <span className="item-value">${item.value}</span>
              <span className="item-state"><span className={`status-dot ${item.active ? 'is-active' : 'is-inactive'}`} /> {item.active ? 'Active' : 'Paused'}</span>
              <span className="item-id">{id}</span>
            </div>
          )
        })}
        <div style={{ height: range.bottom }} role="presentation" aria-hidden="true" />
        {!visibleIds.length && <div className="empty-state" role="presentation"><Search size={22} /><strong>No matching items</strong><span>Try clearing a filter or adding a new item.</span></div>}
      </div>
      <div className="preview-measurements" data-testid="viewport-metrics">
        <span>Viewport: {viewportHeight}px measured</span><span>Scroll: {Math.round(range.scrollTop)}px</span><span>Row: {ROW_HEIGHT}px fixed</span><span>Overscan: {OVERSCAN_ROWS} each side</span><span>Mounted positions: {mountedIds.length ? `${range.start + 1}–${range.end}` : 'none'}</span>
      </div>
      <p id={`${prefix}-keyboard-help`} className="keyboard-help">Arrows / Home / End / Page Up / Down move focus. Space / Enter select. Shift-navigation extends a range. Escape clears selection.</p>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="selection-announcement">{announcement}</div>
      <div className="preview-footer"><span><Database size={14} /> {state.order.length.toLocaleString()} model records</span><span>Mounted count is not a speed benchmark</span></div>
    </div>
  )
}
