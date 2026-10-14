import {
  CATEGORIES,
  type Action,
  type Category,
  type FilterState,
  type ListItem,
  type ModelEvent,
  type ModelOperation,
  type ModelState,
  type SelectionMode,
  type UpdateMetrics,
  reduceModel,
  selectVisibleIds,
} from './model'

export const SNAPSHOT_FORMAT = 'listview-model-studio' as const
export const SCENARIO_FORMAT = 'listview-model-studio-scenario' as const
export const SNAPSHOT_VERSION = 1 as const
export const MAX_SCENARIO_OPERATIONS = 200

export type SnapshotEnvelope = {
  format: typeof SNAPSHOT_FORMAT
  version: typeof SNAPSHOT_VERSION
  exportedAt: string
  state: ModelState
}

export type ScenarioOperation = ModelOperation
  | { type: 'batch'; operations: ModelOperation[]; label?: string }
  | { type: 'reorder'; ids: string[] }
  | { type: 'set-filter'; filter: Partial<FilterState> }
  | { type: 'set-selection-mode'; mode: SelectionMode }
  | { type: 'select'; id: string; additive?: boolean; range?: boolean }
  | { type: 'clear-selection' }

export type ScenarioDocument = {
  format: typeof SCENARIO_FORMAT
  version: typeof SNAPSHOT_VERSION
  name: string
  operations: ScenarioOperation[]
}

export type ScenarioModelView = {
  total: number
  order: string[]
  selectedIds: string[]
  anchorId: string | null
  filter: FilterState
  selectionMode: SelectionMode
  updateMetrics: UpdateMetrics
  itemsById: Record<string, ListItem>
}

export type ScenarioVisibleView = {
  count: number
  ids: string[]
  firstIds: string[]
  lastIds: string[]
}

export type ScenarioStep = {
  index: number
  operation: ScenarioOperation | null
  accepted: boolean
  summary: string
  model: ScenarioModelView
  visible: ScenarioVisibleView
}

export type ScenarioRun = {
  state: ModelState
  steps: ScenarioStep[]
}

export type HistoryState = {
  past: ModelState[]
  present: ModelState
  future: ModelState[]
}

const ITEM_KEYS = ['id', 'title', 'description', 'category', 'value', 'active', 'revision', 'createdAt']
const FILTER_KEYS = ['query', 'category', 'activeOnly']
const EVENT_KEYS = ['id', 'kind', 'summary', 'detail', 'targetIds', 'timestamp', 'status']
const METRIC_KEYS = ['requested', 'changed', 'skipped', 'rejected', 'transactions']
const STATE_KEYS = [
  'itemsById',
  'order',
  'filter',
  'selectionMode',
  'selectedIds',
  'anchorId',
  'updateMetrics',
  'events',
  'nextItemNumber',
  'nextEventNumber',
]
const PATCH_KEYS = ['title', 'description', 'category', 'value', 'active']
const EVENT_KINDS = new Set<ModelEvent['kind']>([
  'add',
  'remove',
  'update',
  'filter',
  'selection',
  'transaction',
  'reorder',
  'system',
])
const EVENT_STATUSES = new Set<ModelEvent['status']>(['success', 'partial', 'rejected'])
const CATEGORY_SET = new Set<Category>(CATEGORIES)

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function pathFor(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`
}

function hasExactKeys(value: UnknownRecord, required: string[], optional: string[], path: string, errors: string[]): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path} is missing ${key}`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) errors.push(`${path} has unknown field ${String(key)}`)
  }
}

function expectRecord(value: unknown, path: string, errors: string[]): value is UnknownRecord {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return false
  }
  return true
}

function expectString(value: unknown, path: string, errors: string[], nonEmpty = false): value is string {
  if (typeof value !== 'string' || (nonEmpty && value.trim().length === 0)) {
    errors.push(`${path} must be a${nonEmpty ? ' non-empty' : ''} string`)
    return false
  }
  return true
}

function expectBoolean(value: unknown, path: string, errors: string[]): value is boolean {
  if (typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean`)
    return false
  }
  return true
}

function expectNumber(value: unknown, path: string, errors: string[], integer = false): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    errors.push(`${path} must be a finite ${integer ? 'safe integer' : 'number'}`)
    return false
  }
  return true
}

function expectNonNegativeInteger(value: unknown, path: string, errors: string[]): value is number {
  if (!expectNumber(value, path, errors, true)) return false
  if (value < 0) {
    errors.push(`${path} must be non-negative`)
    return false
  }
  return true
}

function expectPositiveInteger(value: unknown, path: string, errors: string[]): value is number {
  if (!expectNumber(value, path, errors, true)) return false
  if (value < 1) {
    errors.push(`${path} must be positive`)
    return false
  }
  return true
}

function expectCategory(value: unknown, path: string, errors: string[]): value is Category {
  if (typeof value !== 'string' || !CATEGORY_SET.has(value as Category)) {
    errors.push(`${path} must be one of ${CATEGORIES.join(', ')}`)
    return false
  }
  return true
}

function expectSelectionMode(value: unknown, path: string, errors: string[]): value is SelectionMode {
  if (value !== 'single' && value !== 'multiple') {
    errors.push(`${path} must be single or multiple`)
    return false
  }
  return true
}

function expectStringArray(value: unknown, path: string, errors: string[], unique = false): value is string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return false
  }
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index]
    if (!expectString(entry, pathFor(path, index), errors, true)) continue
    if (unique && seen.has(entry)) errors.push(`${path} contains duplicate ID ${entry}`)
    seen.add(entry)
  }
  return true
}

function validateListItem(value: unknown, path: string, errors: string[]): value is ListItem {
  if (!expectRecord(value, path, errors)) return false
  hasExactKeys(value, ITEM_KEYS, [], path, errors)
  expectString(value.id, pathFor(path, 'id'), errors, true)
  expectString(value.title, pathFor(path, 'title'), errors)
  expectString(value.description, pathFor(path, 'description'), errors)
  expectCategory(value.category, pathFor(path, 'category'), errors)
  expectNumber(value.value, pathFor(path, 'value'), errors)
  expectBoolean(value.active, pathFor(path, 'active'), errors)
  expectPositiveInteger(value.revision, pathFor(path, 'revision'), errors)
  expectString(value.createdAt, pathFor(path, 'createdAt'), errors)
  return true
}

function validateFilter(value: unknown, path: string, errors: string[], partial: boolean): void {
  if (!expectRecord(value, path, errors)) return
  hasExactKeys(value, partial ? [] : FILTER_KEYS, partial ? FILTER_KEYS : [], path, errors)
  if (Object.prototype.hasOwnProperty.call(value, 'query')) expectString(value.query, pathFor(path, 'query'), errors)
  if (Object.prototype.hasOwnProperty.call(value, 'category')) {
    if (value.category !== 'All') expectCategory(value.category, pathFor(path, 'category'), errors)
  }
  if (Object.prototype.hasOwnProperty.call(value, 'activeOnly')) {
    expectBoolean(value.activeOnly, pathFor(path, 'activeOnly'), errors)
  }
}

function validateUpdateMetrics(value: unknown, path: string, errors: string[]): void {
  if (!expectRecord(value, path, errors)) return
  hasExactKeys(value, METRIC_KEYS, [], path, errors)
  for (const key of METRIC_KEYS) expectNonNegativeInteger(value[key], pathFor(path, key), errors)
  const { requested, changed, skipped, rejected } = value
  if (typeof requested === 'number' && typeof changed === 'number' && typeof skipped === 'number' && typeof rejected === 'number'
    && requested !== changed + skipped + rejected) {
    errors.push(`${path}.requested must equal changed + skipped + rejected`)
  }
}

function validateEvent(value: unknown, path: string, errors: string[]): void {
  if (!expectRecord(value, path, errors)) return
  hasExactKeys(value, EVENT_KEYS, [], path, errors)
  expectPositiveInteger(value.id, pathFor(path, 'id'), errors)
  if (typeof value.kind !== 'string' || !EVENT_KINDS.has(value.kind as ModelEvent['kind'])) {
    errors.push(`${path}.kind is not a valid event kind`)
  }
  expectString(value.summary, pathFor(path, 'summary'), errors)
  expectString(value.detail, pathFor(path, 'detail'), errors)
  expectStringArray(value.targetIds, pathFor(path, 'targetIds'), errors)
  expectString(value.timestamp, pathFor(path, 'timestamp'), errors)
  if (typeof value.status !== 'string' || !EVENT_STATUSES.has(value.status as ModelEvent['status'])) {
    errors.push(`${path}.status is not a valid event status`)
  }
}

function validateModelState(value: unknown): string[] {
  const errors: string[] = []
  if (!expectRecord(value, 'state', errors)) return errors
  hasExactKeys(value, STATE_KEYS, [], 'state', errors)

  const itemsByIdValue = value.itemsById
  const hasItemsById = expectRecord(itemsByIdValue, 'state.itemsById', errors)
  if (hasItemsById) {
    const itemIds = new Set(Object.keys(itemsByIdValue))
    const stableIds = new Set<string>()
    for (const [key, item] of Object.entries(itemsByIdValue)) {
      if (key.trim().length === 0) errors.push('state.itemsById has an empty map key')
      if (validateListItem(item, `state.itemsById[${JSON.stringify(key)}]`, errors)) {
        if (item.id !== key) errors.push(`state.itemsById[${JSON.stringify(key)}].id must match its map key`)
        if (stableIds.has(item.id)) errors.push(`state.itemsById contains duplicate ID ${item.id}`)
        stableIds.add(item.id)
      }
    }

    if (expectStringArray(value.order, 'state.order', errors, true)) {
      const orderSet = new Set(value.order)
      for (const id of value.order) {
        if (!Object.prototype.hasOwnProperty.call(itemsByIdValue, id)) errors.push(`state.order references missing ID ${id}`)
      }
      for (const id of itemIds) {
        if (!orderSet.has(id)) errors.push(`state.order is missing ID ${id}`)
      }
      if (value.order.length !== itemIds.size) errors.push('state.order must contain every item exactly once')
    }
  } else {
    // Keep reporting the sibling fields when itemsById itself is malformed.
    expectStringArray(value.order, 'state.order', errors, true)
  }

  validateFilter(value.filter, 'state.filter', errors, false)
  expectSelectionMode(value.selectionMode, 'state.selectionMode', errors)
  expectStringArray(value.selectedIds, 'state.selectedIds', errors, true)
  if (value.anchorId !== null) expectString(value.anchorId, 'state.anchorId', errors, true)
  if (hasItemsById) {
    if (Array.isArray(value.selectedIds)) {
      for (const id of value.selectedIds) {
        if (!Object.prototype.hasOwnProperty.call(itemsByIdValue, id)) errors.push(`state.selectedIds references missing ID ${id}`)
      }
    }
    if (typeof value.anchorId === 'string' && !Object.prototype.hasOwnProperty.call(itemsByIdValue, value.anchorId)) {
      errors.push(`state.anchorId references missing ID ${value.anchorId}`)
    }
  }
  if (Array.isArray(value.selectedIds) && value.selectionMode === 'single' && value.selectedIds.length > 1) {
    errors.push('state.selectedIds cannot contain more than one ID in single selection mode')
  }
  // An additive toggle can leave an existing, unselected ID as the anchor;
  // removing an anchor can leave non-empty selection with a null anchor.
  validateUpdateMetrics(value.updateMetrics, 'state.updateMetrics', errors)
  if (Array.isArray(value.events)) {
    const eventIds = new Set<number>()
    for (let index = 0; index < value.events.length; index += 1) {
      const event: unknown = value.events[index]
      validateEvent(event, pathFor('state.events', index), errors)
      if (isRecord(event) && typeof event.id === 'number') {
        if (eventIds.has(event.id)) errors.push(`state.events contains duplicate event ID ${event.id}`)
        eventIds.add(event.id)
        if (typeof value.nextEventNumber === 'number' && event.id >= value.nextEventNumber) {
          errors.push('state.nextEventNumber must be greater than every event ID')
        }
      }
    }
  } else {
    errors.push('state.events must be an array')
  }
  expectPositiveInteger(value.nextItemNumber, 'state.nextItemNumber', errors)
  expectPositiveInteger(value.nextEventNumber, 'state.nextEventNumber', errors)

  return errors
}

function validatePatch(value: unknown, path: string, errors: string[]): void {
  if (!expectRecord(value, path, errors)) return
  hasExactKeys(value, [], PATCH_KEYS, path, errors)
  if (Object.prototype.hasOwnProperty.call(value, 'title')) expectString(value.title, pathFor(path, 'title'), errors)
  if (Object.prototype.hasOwnProperty.call(value, 'description')) expectString(value.description, pathFor(path, 'description'), errors)
  if (Object.prototype.hasOwnProperty.call(value, 'category')) expectCategory(value.category, pathFor(path, 'category'), errors)
  if (Object.prototype.hasOwnProperty.call(value, 'value')) expectNumber(value.value, pathFor(path, 'value'), errors)
  if (Object.prototype.hasOwnProperty.call(value, 'active')) expectBoolean(value.active, pathFor(path, 'active'), errors)
}

function validateScenarioOperation(value: unknown, path: string, errors: string[], inBatch = false): void {
  if (!expectRecord(value, path, errors)) return
  if (typeof value.type !== 'string') {
    errors.push(`${path}.type must be a string`)
    return
  }
  if (inBatch && value.type !== 'add' && value.type !== 'remove' && value.type !== 'update') {
    errors.push(`${path}.type ${value.type} is not valid in a batch`)
    return
  }
  switch (value.type) {
    case 'add':
      hasExactKeys(value, ['type', 'item'], [], path, errors)
      validateListItem(value.item, pathFor(path, 'item'), errors)
      return
    case 'remove':
      hasExactKeys(value, ['type', 'ids'], [], path, errors)
      expectStringArray(value.ids, pathFor(path, 'ids'), errors, true)
      if (Array.isArray(value.ids) && value.ids.length === 0) errors.push(`${path}.ids cannot be empty`)
      return
    case 'update':
      hasExactKeys(value, ['type', 'id', 'patch'], [], path, errors)
      expectString(value.id, pathFor(path, 'id'), errors, true)
      validatePatch(value.patch, pathFor(path, 'patch'), errors)
      return
    case 'batch':
      hasExactKeys(value, ['type', 'operations'], ['label'], path, errors)
      if (Object.prototype.hasOwnProperty.call(value, 'label')) expectString(value.label, pathFor(path, 'label'), errors)
      if (!Array.isArray(value.operations)) {
        errors.push(`${path}.operations must be an array`)
      } else {
        if (value.operations.length === 0) errors.push(`${path}.operations cannot be empty`)
        for (let index = 0; index < value.operations.length; index += 1) {
          validateScenarioOperation(value.operations[index], pathFor(`${path}.operations`, index), errors, true)
        }
      }
      return
    case 'reorder':
      hasExactKeys(value, ['type', 'ids'], [], path, errors)
      expectStringArray(value.ids, pathFor(path, 'ids'), errors, true)
      return
    case 'set-filter':
      hasExactKeys(value, ['type', 'filter'], [], path, errors)
      validateFilter(value.filter, pathFor(path, 'filter'), errors, true)
      return
    case 'set-selection-mode':
      hasExactKeys(value, ['type', 'mode'], [], path, errors)
      expectSelectionMode(value.mode, pathFor(path, 'mode'), errors)
      return
    case 'select':
      // visibleIds is deliberately not part of the scenario format. A scenario
      // must derive visibility from the state it is replaying.
      hasExactKeys(value, ['type', 'id'], ['additive', 'range'], path, errors)
      expectString(value.id, pathFor(path, 'id'), errors, true)
      if (Object.prototype.hasOwnProperty.call(value, 'additive')) expectBoolean(value.additive, pathFor(path, 'additive'), errors)
      if (Object.prototype.hasOwnProperty.call(value, 'range')) expectBoolean(value.range, pathFor(path, 'range'), errors)
      return
    case 'clear-selection':
      hasExactKeys(value, ['type'], [], path, errors)
      return
    default:
      errors.push(`${path}.type ${value.type} is not a supported scenario operation`)
      return
  }
}

/** Validates only the JSON/document contract; IDs are checked against a model by runScenario. */
export function validateScenario(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!expectRecord(value, 'scenario', errors)) return { valid: false, errors }
  hasExactKeys(value, ['format', 'version', 'name', 'operations'], [], 'scenario', errors)
  if (value.format !== SCENARIO_FORMAT) errors.push(`scenario.format must be ${SCENARIO_FORMAT}`)
  if (value.version !== SNAPSHOT_VERSION) errors.push('scenario.version must be 1')
  expectString(value.name, 'scenario.name', errors)
  if (!Array.isArray(value.operations)) {
    errors.push('scenario.operations must be an array')
  } else {
    if (value.operations.length > MAX_SCENARIO_OPERATIONS) {
      errors.push(`scenario.operations cannot exceed ${MAX_SCENARIO_OPERATIONS} operations`)
    }
    for (let index = 0; index < value.operations.length; index += 1) {
      validateScenarioOperation(value.operations[index], pathFor('scenario.operations', index), errors)
    }
  }
  return { valid: errors.length === 0, errors }
}

function invalidInput(kind: string, errors: string[]): never {
  throw new Error(`Invalid ${kind}: ${errors.join('; ')}`)
}

function parseJson(text: string, kind: string): unknown {
  if (typeof text !== 'string') throw new Error(`Invalid ${kind}: JSON input must be a string`)
  try {
    const value: unknown = JSON.parse(text)
    // JSON.parse otherwise silently keeps only the last duplicate member.
    // Tokenize strings and delimiters after syntax validation so IDs (and any
    // other object fields) cannot be overwritten before shape validation.
    const containers: (Set<string> | null)[] = []
    let expectingKey = false
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g)) {
      const token = match[0]
      if (token === '{') {
        containers.push(new Set<string>())
        expectingKey = true
      } else if (token === '[') {
        containers.push(null)
        expectingKey = false
      } else if (token === '}' || token === ']') {
        containers.pop()
        expectingKey = false
      } else if (token === ',') {
        expectingKey = containers[containers.length - 1] !== null
      } else if (token.startsWith('"') && expectingKey) {
        const key = JSON.parse(token) as string
        const keys = containers[containers.length - 1]
        if (keys?.has(key)) throw new Error(`Duplicate object key ${JSON.stringify(key)}`)
        keys?.add(key)
        expectingKey = false
      }
    }
    return value
  } catch (error) {
    throw new Error(`Invalid ${kind} JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function cloneItem(item: ListItem): ListItem {
  return { ...item }
}

function cloneModelState(state: ModelState): ModelState {
  return {
    ...state,
    itemsById: Object.fromEntries(Object.entries(state.itemsById).map(([id, item]) => [id, cloneItem(item)])),
    order: [...state.order],
    filter: { ...state.filter },
    selectedIds: [...state.selectedIds],
    updateMetrics: { ...state.updateMetrics },
    events: state.events.map((event) => ({ ...event, targetIds: [...event.targetIds] })),
  }
}

function cloneModelOperation(operation: ModelOperation): ModelOperation {
  if (operation.type === 'add') return { type: 'add', item: cloneItem(operation.item) }
  if (operation.type === 'remove') return { type: 'remove', ids: [...operation.ids] }
  return { type: 'update', id: operation.id, patch: { ...operation.patch } }
}

function cloneScenarioOperation(operation: ScenarioOperation): ScenarioOperation {
  if (operation.type === 'add' || operation.type === 'remove' || operation.type === 'update') {
    return cloneModelOperation(operation)
  }
  if (operation.type === 'batch') {
    return {
      type: 'batch',
      operations: operation.operations.map(cloneModelOperation),
      ...(operation.label === undefined ? {} : { label: operation.label }),
    }
  }
  if (operation.type === 'reorder') return { type: 'reorder', ids: [...operation.ids] }
  if (operation.type === 'set-filter') return { type: 'set-filter', filter: { ...operation.filter } }
  if (operation.type === 'set-selection-mode') return { ...operation }
  if (operation.type === 'select') {
    return {
      type: 'select',
      id: operation.id,
      ...(operation.additive === undefined ? {} : { additive: operation.additive }),
      ...(operation.range === undefined ? {} : { range: operation.range }),
    }
  }
  return { type: 'clear-selection' }
}

function cloneScenarioDocument(document: ScenarioDocument): ScenarioDocument {
  return {
    format: document.format,
    version: document.version,
    name: document.name,
    operations: document.operations.map(cloneScenarioOperation),
  }
}

function validateSnapshotEnvelope(value: unknown): string[] {
  const errors: string[] = []
  if (!expectRecord(value, 'snapshot', errors)) return errors
  hasExactKeys(value, ['format', 'version', 'exportedAt', 'state'], [], 'snapshot', errors)
  if (value.format !== SNAPSHOT_FORMAT) errors.push(`snapshot.format must be ${SNAPSHOT_FORMAT}`)
  if (value.version !== SNAPSHOT_VERSION) errors.push('snapshot.version must be 1')
  expectString(value.exportedAt, 'snapshot.exportedAt', errors)
  errors.push(...validateModelState(value.state).map((error) => error.replace(/^state/, 'snapshot.state')))
  return errors
}

/** Serializes a validated model state without changing any state field. */
export function serializeSnapshot(state: ModelState, now?: Date | string): string {
  const stateErrors = validateModelState(state)
  if (stateErrors.length) invalidInput('snapshot', stateErrors)

  let exportedAt: string
  if (now === undefined) {
    exportedAt = new Date().toISOString()
  } else if (now instanceof Date) {
    if (Number.isNaN(now.getTime())) throw new Error('Invalid snapshot: now is an invalid Date')
    exportedAt = now.toISOString()
  } else if (typeof now === 'string') {
    exportedAt = now
  } else {
    throw new Error('Invalid snapshot: now must be a Date or string')
  }

  const envelope: SnapshotEnvelope = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt,
    state,
  }
  return JSON.stringify(envelope)
}

export function parseSnapshot(text: string): ModelState {
  const value = parseJson(text, 'snapshot')
  const errors = validateSnapshotEnvelope(value)
  if (errors.length) invalidInput('snapshot', errors)
  const envelope = value as SnapshotEnvelope
  return cloneModelState(envelope.state)
}

export function parseScenario(text: string): ScenarioDocument {
  const value = parseJson(text, 'scenario')
  const result = validateScenario(value)
  if (!result.valid) invalidInput('scenario', result.errors)
  return cloneScenarioDocument(value as ScenarioDocument)
}

export function serializeScenario(document: ScenarioDocument): string {
  const result = validateScenario(document)
  if (!result.valid) invalidInput('scenario', result.errors)
  return JSON.stringify(cloneScenarioDocument(document), null, 2)
}

function idsAreCompletePermutation(ids: string[], order: string[]): boolean {
  if (ids.length !== order.length) return false
  const idSet = new Set(ids)
  return idSet.size === order.length && order.every((id) => idSet.has(id))
}

function eventStatusFor(previous: ModelState, next: ModelState): ModelEvent['status'] | null {
  if (next === previous) return null
  return next.events[0]?.id === previous.nextEventNumber ? next.events[0].status : null
}

function preflightOperation(state: ModelState, operation: ScenarioOperation, index: number): ModelState {
  if (operation.type === 'batch') {
    // Match the reducer's prohibition on reusing any original ID, even after
    // removing it earlier in this transaction. Check own keys so prototype
    // names cannot masquerade as existing items during a batch dry run.
    const originalIds = new Set(state.order)
    const addedIds = new Set<string>()
    for (const nested of operation.operations) {
      if (nested.type !== 'add') continue
      if (originalIds.has(nested.item.id) || addedIds.has(nested.item.id)) {
        throw new Error(`Scenario operation ${index} rejected: duplicate batch add ID ${nested.item.id}`)
      }
      addedIds.add(nested.item.id)
    }
    const workingIds = new Set(originalIds)
    for (const nested of operation.operations) {
      if (nested.type === 'add') workingIds.add(nested.item.id)
      if (nested.type === 'update' && !workingIds.has(nested.id)) {
        throw new Error(`Scenario operation ${index} rejected: batch update references missing ID ${nested.id}`)
      }
      if (nested.type === 'remove') {
        for (const id of nested.ids) {
          if (!workingIds.has(id)) {
            throw new Error(`Scenario operation ${index} rejected: batch remove references missing ID ${id}`)
          }
        }
        for (const id of nested.ids) workingIds.delete(id)
      }
    }
  }
  if (operation.type === 'add' && Object.prototype.hasOwnProperty.call(state.itemsById, operation.item.id)) {
    throw new Error(`Scenario operation ${index} rejected: duplicate add ID ${operation.item.id}`)
  }
  if (operation.type === 'remove') {
    const missing = operation.ids.filter((id) => !Object.prototype.hasOwnProperty.call(state.itemsById, id))
    if (operation.ids.length === 0 || missing.length) {
      throw new Error(`Scenario operation ${index} rejected: remove references missing ID${missing.length === 1 ? '' : 's'} ${missing.join(', ') || '<empty>'}`)
    }
  }
  if (operation.type === 'update' && !Object.prototype.hasOwnProperty.call(state.itemsById, operation.id)) {
    throw new Error(`Scenario operation ${index} rejected: update references missing ID ${operation.id}`)
  }
  if (operation.type === 'reorder' && !idsAreCompletePermutation(operation.ids, state.order)) {
    throw new Error(`Scenario operation ${index} rejected: reorder must be a complete permutation`)
  }
  if (operation.type === 'select' && !Object.prototype.hasOwnProperty.call(state.itemsById, operation.id)) {
    throw new Error(`Scenario operation ${index} rejected: select references missing ID ${operation.id}`)
  }

  const next = reduceModel(state, operation)
  const status = eventStatusFor(state, next)
  if (status === 'rejected' || status === 'partial') {
    throw new Error(`Scenario operation ${index} rejected: ${next.events[0]?.detail || operation.type}`)
  }
  return next
}

function makeStep(index: number, operation: ScenarioOperation | null, state: ModelState): ScenarioStep {
  const visibleIds = selectVisibleIds(state)
  const event = state.events[0]
  return {
    index,
    operation: operation === null ? null : cloneScenarioOperation(operation),
    accepted: operation === null || event?.status === 'success',
    summary: operation === null ? 'Initial state' : event?.summary || 'Operation accepted',
    model: {
      total: state.order.length,
      order: [...state.order],
      selectedIds: [...state.selectedIds],
      anchorId: state.anchorId,
      filter: { ...state.filter },
      selectionMode: state.selectionMode,
      updateMetrics: { ...state.updateMetrics },
      itemsById: Object.fromEntries(Object.entries(state.itemsById).map(([id, item]) => [id, cloneItem(item)])),
    },
    visible: {
      count: visibleIds.length,
      ids: [...visibleIds],
      firstIds: visibleIds.slice(0, 20),
      lastIds: visibleIds.slice(-20),
    },
  }
}

/**
 * Validates the complete document first, then dry-runs every operation. No
 * partial state or partial step trace is returned when an operation is invalid
 * against the supplied model.
 */
export function runScenario(initial: ModelState, document: ScenarioDocument): ScenarioRun {
  const documentResult = validateScenario(document)
  if (!documentResult.valid) invalidInput('scenario', documentResult.errors)
  const stateErrors = validateModelState(initial)
  if (stateErrors.length) invalidInput('initial model state', stateErrors)

  const states: ModelState[] = [initial]
  let working = initial
  document.operations.forEach((operation, index) => {
    working = preflightOperation(working, operation, index + 1)
    states.push(working)
  })

  const steps = states.map((state, index) => makeStep(index, index === 0 ? null : document.operations[index - 1], state))
  return { state: cloneModelState(working), steps }
}

export function createHistory(initial: ModelState): HistoryState {
  return { past: [], present: initial, future: [] }
}

export function applyHistory(history: HistoryState, action: Action): HistoryState {
  const next = reduceModel(history.present, action)
  if (next === history.present) return history
  return {
    past: [...history.past, history.present],
    present: next,
    future: [],
  }
}

export function undoHistory(history: HistoryState): HistoryState {
  if (history.past.length === 0) return history
  const present = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  }
}

export function redoHistory(history: HistoryState): HistoryState {
  if (history.future.length === 0) return history
  const present = history.future[0]
  return {
    past: [...history.past, history.present],
    present,
    future: history.future.slice(1),
  }
}
