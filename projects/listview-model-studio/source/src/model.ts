export type SelectionMode = 'single' | 'multiple'

export type Category = 'Books' | 'Music' | 'Games' | 'Tools' | 'Travel' | 'Science'

export type ListItem = {
  id: string
  title: string
  description: string
  category: Category
  value: number
  active: boolean
  revision: number
  createdAt: string
}

export type FilterState = {
  query: string
  category: Category | 'All'
  activeOnly: boolean
}

export type EventKind = 'add' | 'remove' | 'update' | 'filter' | 'selection' | 'transaction' | 'reorder' | 'system'

export type ModelEvent = {
  id: number
  kind: EventKind
  summary: string
  detail: string
  targetIds: string[]
  timestamp: string
  status: 'success' | 'partial' | 'rejected'
}

// Cumulative model operations since reset, independent of the capped event log.
export type UpdateMetrics = {
  requested: number
  changed: number
  skipped: number
  rejected: number
  transactions: number
}

export type ModelState = {
  itemsById: Record<string, ListItem>
  order: string[]
  filter: FilterState
  selectionMode: SelectionMode
  selectedIds: string[]
  anchorId: string | null
  updateMetrics: UpdateMetrics
  events: ModelEvent[]
  nextItemNumber: number
  nextEventNumber: number
}

export type ItemPatch = Partial<Pick<ListItem, 'title' | 'description' | 'category' | 'value' | 'active'>>

export type ModelOperation =
  | { type: 'add'; item: ListItem }
  | { type: 'remove'; ids: string[] }
  | { type: 'update'; id: string; patch: ItemPatch }

export type Action = ModelOperation
  | { type: 'batch'; operations: ModelOperation[]; label?: string }
  | { type: 'reorder'; ids: string[] }
  | { type: 'set-filter'; filter: Partial<FilterState> }
  | { type: 'set-selection-mode'; mode: SelectionMode }
  | { type: 'select'; id: string; additive?: boolean; range?: boolean; visibleIds?: string[] }
  | { type: 'clear-selection' }
  | { type: 'clear-events' }
  | { type: 'reset' }

export const CATEGORIES: Category[] = ['Books', 'Music', 'Games', 'Tools', 'Travel', 'Science']

const TITLES = [
  'A field guide to small systems',
  'The quiet architecture of change',
  'Notes from the edge of the map',
  'A practical atlas of patterns',
  'Signals in a noisy world',
  'The maker’s weekend notebook',
  'Designing for the next step',
  'A short history of useful things',
]

const DESCRIPTORS = [
  'A compact reference for curious builders.',
  'A repeatable workflow with room to explore.',
  'Small pieces, composed into something useful.',
  'An approachable guide for the everyday edge cases.',
  'A clear path from first idea to finished detail.',
]

export function createFixture(size = 12_000): ListItem[] {
  return Array.from({ length: size }, (_, index) => {
    const category = CATEGORIES[index % CATEGORIES.length]
    const title = `${TITLES[index % TITLES.length]} · ${String(index + 1).padStart(5, '0')}`
    const searchableTerm = index % 11 === 0 ? ' · alpha collection' : index % 17 === 0 ? ' · beta archive' : ''
    return {
      id: `fixture-${String(index + 1).padStart(5, '0')}`,
      title: `${title}${searchableTerm}`,
      description: DESCRIPTORS[index % DESCRIPTORS.length],
      category,
      value: 12 + ((index * 37) % 489),
      active: index % 7 !== 0,
      revision: 1,
      createdAt: new Date(Date.UTC(2025, 0, (index % 28) + 1)).toISOString(),
    }
  })
}

function pushEvent(state: ModelState, event: Omit<ModelEvent, 'id' | 'timestamp'>): ModelState {
  return {
    ...state,
    nextEventNumber: state.nextEventNumber + 1,
    events: [
      {
        ...event,
        id: state.nextEventNumber,
        timestamp: new Date().toISOString(),
      },
      ...state.events,
    ].slice(0, 80),
  }
}

export function createInitialState(items = createFixture()): ModelState {
  const seenIds = new Set<string>()
  for (const item of items) {
    if (!item.id.trim() || seenIds.has(item.id)) {
      throw new Error(`Duplicate or empty stable item ID: ${item.id || '<empty>'}`)
    }
    seenIds.add(item.id)
  }
  const itemsById = Object.fromEntries(items.map((item) => [item.id, item]))
  return {
    itemsById,
    order: items.map((item) => item.id),
    filter: { query: '', category: 'All', activeOnly: false },
    selectionMode: 'multiple',
    selectedIds: [],
    anchorId: null,
    updateMetrics: { requested: 0, changed: 0, skipped: 0, rejected: 0, transactions: 0 },
    events: [
      {
        id: 1,
        kind: 'system',
        summary: 'Fixture loaded',
        detail: `${items.length.toLocaleString()} local records ready`,
        targetIds: [],
        timestamp: new Date().toISOString(),
        status: 'success',
      },
    ],
    nextItemNumber: 1,
    nextEventNumber: 2,
  }
}

export function matchesFilter(item: ListItem, filter: FilterState): boolean {
  const query = filter.query.trim().toLowerCase()
  const matchesQuery = !query || `${item.id} ${item.title} ${item.description} ${item.category}`.toLowerCase().includes(query)
  const matchesCategory = filter.category === 'All' || item.category === filter.category
  const matchesActive = !filter.activeOnly || item.active
  return matchesQuery && matchesCategory && matchesActive
}

export function selectVisibleItems(state: ModelState): ListItem[] {
  const visible: ListItem[] = []
  for (const id of state.order) {
    const item = state.itemsById[id]
    if (item && matchesFilter(item, state.filter)) {
      visible.push(item)
    }
  }
  return visible
}

export function selectVisibleIds(state: ModelState): string[] {
  const ids: string[] = []
  for (const id of state.order) {
    const item = state.itemsById[id]
    if (item && matchesFilter(item, state.filter)) ids.push(id)
  }
  return ids
}

export function countVisible(state: ModelState): number {
  let count = 0
  for (const id of state.order) {
    const item = state.itemsById[id]
    if (item && matchesFilter(item, state.filter)) count += 1
  }
  return count
}

function formatIds(ids: string[]): string {
  if (ids.length === 0) return ''
  if (ids.length === 1) return ids[0]
  return `${ids[0]} +${ids.length - 1} more`
}

type CoreResult = {
  state: ModelState
  summary: string
  detail: string
  targetIds: string[]
  status: 'success' | 'partial' | 'rejected'
}

function applyAdd(state: ModelState, item: ListItem): CoreResult {
  if (!item.id.trim() || state.itemsById[item.id]) {
    return {
      state,
      summary: 'Add rejected',
      detail: `Stable ID ${item.id || '<empty>'} is empty or already exists`,
      targetIds: item.id ? [item.id] : [],
      status: 'rejected',
    }
  }
  const nextItem = { ...item, revision: item.revision || 1 }
  return {
    state: {
      ...state,
      itemsById: { ...state.itemsById, [nextItem.id]: nextItem },
      order: [...state.order, nextItem.id],
      nextItemNumber: state.nextItemNumber + 1,
    },
    summary: 'Item added',
    detail: `${nextItem.id} appended to the model`,
    targetIds: [nextItem.id],
    status: 'success',
  }
}

function applyRemove(state: ModelState, ids: string[]): CoreResult {
  const requestedIds = Array.from(new Set(ids))
  const foundIds = requestedIds.filter((id) => Boolean(state.itemsById[id]))
  if (foundIds.length === 0) {
    return {
      state,
      summary: 'Remove rejected',
      detail: 'No matching stable IDs found',
      targetIds: requestedIds,
      status: 'rejected',
    }
  }
  const nextItems = { ...state.itemsById }
  foundIds.forEach((id) => delete nextItems[id])
  const nextSelected = state.selectedIds.filter((id) => !foundIds.includes(id))
  return {
    state: {
      ...state,
      itemsById: nextItems,
      order: state.order.filter((id) => !foundIds.includes(id)),
      selectedIds: nextSelected,
      // A removed anchor is cleared rather than silently moving selection to a neighbor.
      anchorId: foundIds.includes(state.anchorId ?? '') ? null : state.anchorId,
    },
    summary: `${foundIds.length} item${foundIds.length === 1 ? '' : 's'} removed`,
    detail: `${formatIds(foundIds)} released from the model`,
    targetIds: foundIds,
    status: foundIds.length === requestedIds.length ? 'success' : 'partial',
  }
}

function applyUpdate(state: ModelState, id: string, patch: ItemPatch): CoreResult {
  const updateMetrics = { ...state.updateMetrics, requested: state.updateMetrics.requested + 1 }
  const current = state.itemsById[id]
  if (!current) {
    return {
      state: {
        ...state,
        updateMetrics: { ...updateMetrics, rejected: updateMetrics.rejected + 1 },
      },
      summary: 'Update rejected',
      detail: `No item found for ${id}`,
      targetIds: [id],
      status: 'rejected',
    }
  }
  const changedFields = (Object.keys(patch) as (keyof ItemPatch)[]).filter((key) => patch[key] !== current[key])
  if (changedFields.length === 0) {
    return {
      state: {
        ...state,
        updateMetrics: { ...updateMetrics, skipped: updateMetrics.skipped + 1 },
      },
      summary: 'Update skipped',
      detail: `${id} already has those values`,
      targetIds: [id],
      status: 'success',
    }
  }
  const updated = { ...current, ...patch, revision: current.revision + 1 }
  return {
    state: {
      ...state,
      itemsById: { ...state.itemsById, [id]: updated },
      updateMetrics: { ...updateMetrics, changed: updateMetrics.changed + 1 },
    },
    summary: 'Item patched',
    detail: `${id} · ${changedFields.join(', ')} · revision ${updated.revision}`,
    targetIds: [id],
    status: 'success',
  }
}

function applyReorder(state: ModelState, ids: string[]): CoreResult {
  const uniqueIds = new Set(ids)
  const isCompletePermutation = ids.length === state.order.length
    && uniqueIds.size === state.order.length
    && state.order.every((id) => uniqueIds.has(id))
  if (!isCompletePermutation) {
    return {
      state,
      summary: 'Reorder rejected',
      detail: 'Order must contain every stable ID exactly once',
      targetIds: ids,
      status: 'rejected',
    }
  }
  return {
    state: { ...state, order: [...ids] },
    summary: 'Model reordered',
    detail: `Canonical order changed for ${ids.length.toLocaleString()} items; selection stayed ID-based`,
    targetIds: state.selectedIds,
    status: 'success',
  }
}

function applyOperation(state: ModelState, operation: ModelOperation): CoreResult {
  if (operation.type === 'add') return applyAdd(state, operation.item)
  if (operation.type === 'remove') return applyRemove(state, operation.ids)
  return applyUpdate(state, operation.id, operation.patch)
}

function recordRejectedBatchUpdates(state: ModelState, operations: ModelOperation[]): ModelState {
  // Use the original state so no temporary changed/skipped counts survive rollback.
  const rejected = operations.reduce((count, operation) => count + (operation.type === 'update' ? 1 : 0), 0)
  return {
    ...state,
    updateMetrics: {
      ...state.updateMetrics,
      requested: state.updateMetrics.requested + rejected,
      rejected: state.updateMetrics.rejected + rejected,
    },
  }
}

function emitCoreResult(state: ModelState, kind: EventKind, result: CoreResult): ModelState {
  return pushEvent(result.state, {
    kind,
    summary: result.summary,
    detail: result.detail,
    targetIds: result.targetIds,
    status: result.status,
  })
}

function reduceBatch(state: ModelState, operations: ModelOperation[], label?: string): ModelState {
  if (operations.length === 0) {
    return pushEvent(state, {
      kind: 'transaction',
      summary: 'Batch rejected',
      detail: 'An empty transaction has no operations to commit',
      targetIds: [],
      status: 'rejected',
    })
  }

  // Validate additions against the original collection and each other. This also
  // rejects remove-then-add ID reuse inside one transaction.
  const addedIds = new Set<string>()
  for (const operation of operations) {
    if (operation.type !== 'add') continue
    if (!operation.item.id.trim() || state.itemsById[operation.item.id] || addedIds.has(operation.item.id)) {
      return pushEvent(recordRejectedBatchUpdates(state, operations), {
        kind: 'transaction',
        summary: 'Batch rejected',
        detail: `Duplicate or empty stable ID ${operation.item.id || '<empty>'}; no changes committed`,
        targetIds: operation.item.id ? [operation.item.id] : [],
        status: 'rejected',
      })
    }
    addedIds.add(operation.item.id)
  }

  let working = state
  const targetIds: string[] = []
  for (const operation of operations) {
    const result = applyOperation(working, operation)
    if (result.status !== 'success') {
      return pushEvent(recordRejectedBatchUpdates(state, operations), {
        kind: 'transaction',
        summary: 'Batch rejected',
        detail: `${result.detail}; no changes committed`,
        targetIds: Array.from(new Set([...targetIds, ...result.targetIds])),
        status: 'rejected',
      })
    }
    working = result.state
    targetIds.push(...result.targetIds)
  }
  return pushEvent({
    ...working,
    updateMetrics: { ...working.updateMetrics, transactions: working.updateMetrics.transactions + 1 },
  }, {
    kind: 'transaction',
    summary: label || 'Batch committed',
    detail: `${operations.length} operation${operations.length === 1 ? '' : 's'} committed atomically across ${new Set(targetIds).size} stable ID${new Set(targetIds).size === 1 ? '' : 's'}`,
    targetIds: Array.from(new Set(targetIds)),
    status: 'success',
  })
}

export function reduceModel(state: ModelState, action: Action): ModelState {
  switch (action.type) {
    case 'add':
      return emitCoreResult(state, 'add', applyAdd(state, action.item))
    case 'remove':
      return emitCoreResult(state, 'remove', applyRemove(state, action.ids))
    case 'update':
      return emitCoreResult(state, 'update', applyUpdate(state, action.id, action.patch))
    case 'batch':
      return reduceBatch(state, action.operations, action.label)
    case 'reorder':
      return emitCoreResult(state, 'reorder', applyReorder(state, action.ids))
    case 'set-filter': {
      const filter = { ...state.filter, ...action.filter }
      const next = { ...state, filter }
      return pushEvent(next, {
        kind: 'filter',
        summary: 'Filter changed',
        detail: `${filter.query.trim() || 'All records'}${filter.category !== 'All' ? ` · ${filter.category}` : ''}${filter.activeOnly ? ' · active only' : ''}`,
        targetIds: [],
        status: 'success',
      })
    }
    case 'set-selection-mode': {
      const selectedIds = action.mode === 'single' ? state.selectedIds.slice(-1) : state.selectedIds
      const next = { ...state, selectionMode: action.mode, selectedIds, anchorId: selectedIds[0] ?? null }
      return pushEvent(next, {
        kind: 'selection',
        summary: `${action.mode === 'single' ? 'Single' : 'Multiple'} selection enabled`,
        detail: selectedIds.length ? `${selectedIds.length} selection retained` : 'Selection is empty',
        targetIds: selectedIds,
        status: 'success',
      })
    }
    case 'select': {
      if (!state.itemsById[action.id]) return state
      const visibleIds = action.visibleIds ?? selectVisibleIds(state)
      let selectedIds: string[]
      if (state.selectionMode === 'single') {
        selectedIds = [action.id]
      } else if (action.range && state.anchorId && visibleIds.includes(state.anchorId)) {
        const start = visibleIds.indexOf(state.anchorId)
        const end = visibleIds.indexOf(action.id)
        const range = visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)
        selectedIds = Array.from(new Set([...state.selectedIds, ...range]))
      } else if (action.additive) {
        selectedIds = state.selectedIds.includes(action.id)
          ? state.selectedIds.filter((id) => id !== action.id)
          : [...state.selectedIds, action.id]
      } else {
        selectedIds = [action.id]
      }
      const next = { ...state, selectedIds, anchorId: action.range ? state.anchorId ?? action.id : action.id }
      return pushEvent(next, {
        kind: 'selection',
        summary: selectedIds.length ? `${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'} selected` : 'Selection cleared',
        detail: action.range ? 'Visible range selected' : action.additive ? 'Selection toggled' : 'Selection replaced',
        targetIds: selectedIds,
        status: 'success',
      })
    }
    case 'clear-selection':
      return pushEvent({ ...state, selectedIds: [], anchorId: null }, {
        kind: 'selection',
        summary: 'Selection cleared',
        detail: 'No items are currently selected',
        targetIds: [],
        status: 'success',
      })
    case 'clear-events':
      return { ...state, events: [] }
    case 'reset':
      return createInitialState()
  }
}

export function createNewItem(number: number): ListItem {
  return {
    id: `local-${String(number).padStart(5, '0')}`,
    title: 'A new list item',
    description: 'Created from the list editor.',
    category: 'Tools',
    value: 99,
    active: true,
    revision: 1,
    createdAt: new Date().toISOString(),
  }
}
