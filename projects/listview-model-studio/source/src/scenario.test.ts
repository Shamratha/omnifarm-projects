import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyHistory,
  createHistory,
  parseScenario,
  parseSnapshot,
  redoHistory,
  runScenario,
  serializeScenario,
  serializeSnapshot,
  undoHistory,
  validateScenario,
} from './scenario'
import {
  type ModelState,
  createFixture,
  createInitialState,
  createNewItem,
  reduceModel,
  selectVisibleIds,
} from './model'
import * as model from './model'
import type { ScenarioDocument, ScenarioOperation, SnapshotEnvelope } from './scenario'

const NOW = '2026-10-14T12:00:00.000Z'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function scenario(operations: ScenarioOperation[] = []): ScenarioDocument {
  return { format: 'listview-model-studio-scenario', version: 1, name: 'Test scenario', operations }
}

function snapshot(): SnapshotEnvelope {
  return JSON.parse(serializeSnapshot(createInitialState(createFixture(2)), NOW)) as SnapshotEnvelope
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep)
    Object.freeze(value)
  }
  return value
}

describe('strict snapshots', () => {
  it('round-trips a state and uses the supplied export time', () => {
    const state = reduceModel(createInitialState(createFixture(2)), { type: 'select', id: 'fixture-00001' })
    const text = serializeSnapshot(state, '2026-10-14T12:00:00.000Z')
    expect(JSON.parse(text)).toMatchObject({
      format: 'listview-model-studio',
      version: 1,
      exportedAt: '2026-10-14T12:00:00.000Z',
    })
    expect(parseSnapshot(text)).toEqual(state)
    expect(parseSnapshot(text)).not.toBe(state)
  })

  it('rejects unknown fields and invalid patch/state fields without mutation', () => {
    const state = createInitialState(createFixture(1))
    const valid = JSON.parse(serializeSnapshot(state, 'fixed')) as Record<string, unknown>
    const invalid = {
      ...valid,
      state: {
        ...(valid.state as object),
        itemsById: {
          ...(valid.state as { itemsById: object }).itemsById,
          'fixture-00001': {
            ...(valid.state as { itemsById: Record<string, object> }).itemsById['fixture-00001'],
            revision: '2',
          },
        },
        unexpected: true,
      },
    }
    const before = JSON.stringify(state)
    expect(() => parseSnapshot(JSON.stringify(invalid))).toThrow(/unknown field|revision/)
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('scenarios', () => {
  it('validates strict documents, including patch id/revision and visibleIds', () => {
    const result = validateScenario({
      format: 'listview-model-studio-scenario',
      version: 1,
      name: 'bad',
      operations: [
        { type: 'select', id: 'fixture-00001', visibleIds: [] },
        { type: 'update', id: 'fixture-00001', patch: { revision: 2 } },
      ],
    })
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toMatch(/unknown field visibleIds|unknown field revision/)
    expect(() => parseScenario(JSON.stringify({
      format: 'listview-model-studio-scenario',
      version: 1,
      name: 'bad',
      operations: [],
      extra: true,
    }))).toThrow(/unknown field extra/)
  })

  it('builds bounded visible views and matches direct reducer results', () => {
    const initial = createInitialState(createFixture(25))
    const document = {
      format: 'listview-model-studio-scenario' as const,
      version: 1 as const,
      name: 'trace',
      operations: [
        { type: 'select' as const, id: 'fixture-00001' },
        { type: 'set-filter' as const, filter: { category: 'Books' as const } },
        { type: 'update' as const, id: 'fixture-00001', patch: { value: 777 } },
      ],
    }
    const run = runScenario(initial, document)
    let direct = initial
    for (const operation of document.operations) direct = reduceModel(direct, operation)
    expect(run.state).toEqual(direct)
    expect(run.steps).toHaveLength(4)
    expect(run.steps[0].operation).toBeNull()
    expect(run.steps[0].visible.count).toBe(25)
    expect(run.steps[0].visible.firstIds).toHaveLength(20)
    expect(run.steps[0].visible.lastIds).toHaveLength(20)
    expect(run.steps[2].visible.count).toBe(5)
    expect(run.steps[2].visible.ids).toEqual(['fixture-00001', 'fixture-00007', 'fixture-00013', 'fixture-00019', 'fixture-00025'])
    expect(run.steps[2].visible.firstIds).toHaveLength(5)
    expect(run.steps[2].visible.lastIds).toHaveLength(5)
    expect(run.steps[3].model.itemsById['fixture-00001'].value).toBe(777)
    expect(run.steps.every((step) => step.accepted)).toBe(true)
  })

  it('does not publish a partial trace for state-dependent failures', () => {
    const initial = createInitialState(createFixture(1))
    const document = {
      format: 'listview-model-studio-scenario' as const,
      version: 1 as const,
      name: 'invalid',
      operations: [
        { type: 'update' as const, id: 'fixture-00001', patch: { value: 4 } },
        { type: 'add' as const, item: { ...createFixture(1)[0], id: 'fixture-00001' } },
      ],
    }
    const before = JSON.stringify(initial)
    expect(() => runScenario(initial, document)).toThrow(/duplicate add ID/)
    expect(JSON.stringify(initial)).toBe(before)
  })

  it('rejects a state-dependent batch atomically and leaves the input untouched', () => {
    const initial = createInitialState(createFixture(1))
    const document = {
      format: 'listview-model-studio-scenario' as const,
      version: 1 as const,
      name: 'rollback',
      operations: [{
        type: 'batch' as const,
        operations: [
          { type: 'update' as const, id: 'fixture-00001', patch: { value: 999 } },
          { type: 'add' as const, item: { ...createFixture(1)[0], id: 'fixture-00001' } },
        ],
      }],
    }
    const before = JSON.stringify(initial)
    expect(() => runScenario(initial, document)).toThrow(/duplicate|no changes committed/)
    expect(JSON.stringify(initial)).toBe(before)
  })

  it('enforces the trace operation limit before reducing', () => {
    const document = {
      format: 'listview-model-studio-scenario',
      version: 1,
      name: 'too long',
      operations: Array.from({ length: 201 }, () => ({ type: 'clear-selection' })),
    }
    const result = validateScenario(document)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('200')
  })
})

describe('authoring history', () => {
  it('undoes, redoes, and clears the redo branch after a new action', () => {
    const initial = createInitialState(createFixture(1))
    const action = { type: 'update' as const, id: 'fixture-00001', patch: { value: 100 } }
    const changed = applyHistory(createHistory(initial), action)
    expect(undoHistory(changed).present).toBe(initial)
    const undone = undoHistory(changed)
    const redone = redoHistory(undone)
    expect(redone.present).toEqual(changed.present)
    const branched = applyHistory(undone, { type: 'set-filter', filter: { query: 'fixture' } })
    expect(branched.future).toEqual([])
    const empty = createHistory(initial)
    expect(undoHistory(empty)).toBe(empty)
    expect(redoHistory(empty)).toBe(empty)
  })
})

describe('snapshot validation boundaries', () => {
  const invalidSnapshots: [string, (envelope: SnapshotEnvelope) => void][] = [
    ['format', (value) => Object.assign(value, { format: 'other' })],
    ['version', (value) => Object.assign(value, { version: '1' })],
    ['future version', (value) => Object.assign(value, { version: 2 })],
    ['exportedAt type', (value) => Object.assign(value, { exportedAt: 0 })],
    ['unknown envelope key', (value) => Object.assign(value, { extra: true })],
    ['missing state field', (value) => Reflect.deleteProperty(value.state, 'events')],
    ['unknown state key', (value) => Object.assign(value.state, { extra: true })],
    ['map type', (value) => Object.assign(value.state, { itemsById: [] })],
    ['item type', (value) => Object.assign(value.state.itemsById, { 'fixture-00001': null })],
    ['duplicate item IDs', (value) => { value.state.itemsById['fixture-00002'].id = 'fixture-00001' }],
    ['map key mismatch', (value) => { value.state.itemsById['fixture-00001'].id = 'other' }],
    ['duplicate order IDs', (value) => { value.state.order = ['fixture-00001', 'fixture-00001'] }],
    ['missing order ID', (value) => { value.state.order.pop() }],
    ['unknown order ID', (value) => { value.state.order[1] = 'missing' }],
    ['order type', (value) => Object.assign(value.state, { order: [123] })],
    ['item category', (value) => Object.assign(value.state.itemsById['fixture-00001'], { category: 'All' })],
    ['item value', (value) => Object.assign(value.state.itemsById['fixture-00001'], { value: '12' })],
    ['item revision type', (value) => Object.assign(value.state.itemsById['fixture-00001'], { revision: '1' })],
    ['zero revision', (value) => { value.state.itemsById['fixture-00001'].revision = 0 }],
    ['negative revision', (value) => { value.state.itemsById['fixture-00001'].revision = -1 }],
    ['fractional revision', (value) => { value.state.itemsById['fixture-00001'].revision = 1.5 }],
    ['item active type', (value) => Object.assign(value.state.itemsById['fixture-00001'], { active: 1 })],
    ['unknown item key', (value) => Object.assign(value.state.itemsById['fixture-00001'], { extra: true })],
    ['filter query type', (value) => Object.assign(value.state.filter, { query: false })],
    ['filter category', (value) => Object.assign(value.state.filter, { category: 'Other' })],
    ['filter active type', (value) => Object.assign(value.state.filter, { activeOnly: 'false' })],
    ['unknown filter key', (value) => Object.assign(value.state.filter, { extra: true })],
    ['selection mode', (value) => Object.assign(value.state, { selectionMode: 'many' })],
    ['unknown selection', (value) => { value.state.selectedIds = ['missing'] }],
    ['duplicate selection', (value) => { value.state.selectedIds = ['fixture-00001', 'fixture-00001'] }],
    ['single-mode selection', (value) => {
      value.state.selectionMode = 'single'
      value.state.selectedIds = [...value.state.order]
    }],
    ['unknown anchor', (value) => { value.state.anchorId = 'missing' }],
    ['anchor type', (value) => Object.assign(value.state, { anchorId: 0 })],
    ['negative metric', (value) => { value.state.updateMetrics.requested = -1 }],
    ['fractional metric', (value) => { value.state.updateMetrics.transactions = 0.5 }],
    ['metric type', (value) => Object.assign(value.state.updateMetrics, { requested: '0' })],
    ['inconsistent metrics', (value) => { value.state.updateMetrics.requested = 1 }],
    ['unknown metric key', (value) => Object.assign(value.state.updateMetrics, { extra: 0 })],
    ['events type', (value) => Object.assign(value.state, { events: {} })],
    ['event kind', (value) => Object.assign(value.state.events[0], { kind: 'other' })],
    ['event status', (value) => Object.assign(value.state.events[0], { status: false })],
    ['unknown event key', (value) => Object.assign(value.state.events[0], { extra: true })],
    ['duplicate event ID', (value) => { value.state.events.push({ ...value.state.events[0] }) }],
    ['event counter consistency', (value) => { value.state.nextEventNumber = 1 }],
    ['counter type', (value) => Object.assign(value.state, { nextItemNumber: '1' })],
    ['unsafe counter', (value) => { value.state.nextItemNumber = Number.MAX_SAFE_INTEGER + 1 }],
  ]

  it.each(invalidSnapshots)('rejects %s without repairing the document', (_name, invalidate) => {
    const envelope = snapshot()
    invalidate(envelope)
    const before = JSON.stringify(envelope)
    expect(() => parseSnapshot(before)).toThrow(/Invalid snapshot/)
    expect(JSON.stringify(envelope)).toBe(before)
    // Envelope-only errors do not make the contained model state invalid.
    if (!['format', 'version', 'future version', 'exportedAt type', 'unknown envelope key'].includes(_name)) {
      expect(() => serializeSnapshot(envelope.state)).toThrow()
    }
  })

  it('returns deeply fresh states and preserves valid selection/anchor edge cases', () => {
    const items = createFixture(2)
    let initial = createInitialState(items)
    initial = reduceModel(initial, { type: 'select', id: items[0].id })
    initial = reduceModel(initial, { type: 'select', id: items[0].id, additive: true })
    initial = reduceModel(initial, { type: 'set-filter', filter: { query: '  no matching item  ' } })
    // A toggled-off item remains the anchor, even when selection is empty.
    expect(initial.anchorId).toBe(items[0].id)
    const text = serializeSnapshot(freezeDeep(initial), new Date(NOW))
    const parsed = parseSnapshot(text)
    expect(parsed).toEqual(initial)
    expect(parsed.filter.query).toBe('  no matching item  ')
    parsed.itemsById[items[0].id].title = 'Mutated import'
    parsed.order.reverse()
    parsed.filter.query = 'Mutated filter'
    parsed.events[0].targetIds.push('another')
    expect(parseSnapshot(text)).toEqual(initial)

    let removedAnchor = createInitialState(items.map((item) => ({ ...item })))
    removedAnchor = reduceModel(removedAnchor, { type: 'select', id: items[0].id })
    removedAnchor = reduceModel(removedAnchor, { type: 'select', id: items[1].id, additive: true })
    removedAnchor = reduceModel(removedAnchor, { type: 'remove', ids: [items[1].id] })
    expect(removedAnchor.anchorId).toBeNull()
    expect(parseSnapshot(serializeSnapshot(removedAnchor))).toEqual(removedAnchor)
    const empty = reduceModel(createInitialState([]), { type: 'clear-events' })
    expect(parseSnapshot(serializeSnapshot(empty))).toEqual(empty)
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-JSON numeric value %s before serialization', (value) => {
    const state = createInitialState(createFixture(1))
    state.itemsById[state.order[0]].value = value
    expect(() => serializeSnapshot(state)).toThrow(/finite number/)
    expect(state.itemsById[state.order[0]].value).toBe(value)
  })

  it('rejects malformed JSON and invalid clock values', () => {
    expect(() => parseSnapshot('{')).toThrow(/JSON/)
    expect(() => parseSnapshot('null')).toThrow(/object/)
    const duplicateKey = JSON.stringify(snapshot()).replace('"version":1', '"version":1,"version":1')
    expect(() => parseSnapshot(duplicateKey)).toThrow(/Duplicate object key .*version/)
    expect(() => serializeSnapshot(createInitialState([]), new Date(NaN))).toThrow(/invalid Date/)
    expect(JSON.parse(serializeSnapshot(createInitialState([]))).exportedAt).toBe(NOW)
  })
})

describe('strict scenario structure', () => {
  const invalidOperations: [string, unknown][] = [
    ['null operation', null],
    ['array operation', []],
    ['missing type', {}],
    ['type type', { type: false }],
    ['unsupported action', { type: 'reset' }],
    ['unknown action key', { type: 'clear-selection', extra: true }],
    ['invalid add item', { type: 'add', item: null }],
    ['normalized add revision', { type: 'add', item: { ...createFixture(1)[0], revision: 0 } }],
    ['remove IDs type', { type: 'remove', ids: 'item' }],
    ['remove duplicate IDs', { type: 'remove', ids: ['item', 'item'] }],
    ['empty remove', { type: 'remove', ids: [] }],
    ['empty ID', { type: 'select', id: '  ' }],
    ['select ID type', { type: 'select', id: 123 }],
    ['visible IDs', { type: 'select', id: 'item', visibleIds: [] }],
    ['additive type', { type: 'select', id: 'item', additive: 'true' }],
    ['range type', { type: 'select', id: 'item', range: 1 }],
    ['undefined optional flag', { type: 'select', id: 'item', range: undefined }],
    ['patch type', { type: 'update', id: 'item', patch: [] }],
    ['patch id', { type: 'update', id: 'item', patch: { id: 'changed' } }],
    ['patch revision', { type: 'update', id: 'item', patch: { revision: 2 } }],
    ['patch timestamp', { type: 'update', id: 'item', patch: { createdAt: NOW } }],
    ['patch title type', { type: 'update', id: 'item', patch: { title: 0 } }],
    ['patch description type', { type: 'update', id: 'item', patch: { description: null } }],
    ['patch category', { type: 'update', id: 'item', patch: { category: 'All' } }],
    ['patch active type', { type: 'update', id: 'item', patch: { active: 'true' } }],
    ['patch value type', { type: 'update', id: 'item', patch: { value: '1' } }],
    ['patch infinite value', { type: 'update', id: 'item', patch: { value: Infinity } }],
    ['patch undefined value', { type: 'update', id: 'item', patch: { value: undefined } }],
    ['filter type', { type: 'set-filter', filter: false }],
    ['filter unknown key', { type: 'set-filter', filter: { extra: true } }],
    ['filter query type', { type: 'set-filter', filter: { query: 0 } }],
    ['filter category', { type: 'set-filter', filter: { category: 'Unknown' } }],
    ['filter flag type', { type: 'set-filter', filter: { activeOnly: 'false' } }],
    ['mode', { type: 'set-selection-mode', mode: 'other' }],
    ['reorder IDs type', { type: 'reorder', ids: [0] }],
    ['duplicate reorder', { type: 'reorder', ids: ['item', 'item'] }],
    ['batch type', { type: 'batch', operations: {} }],
    ['empty batch', { type: 'batch', operations: [] }],
    ['batch label type', { type: 'batch', label: 123, operations: [{ type: 'remove', ids: ['item'] }] }],
    ['nested batch', { type: 'batch', operations: [{ type: 'batch', operations: [] }] }],
    ['non-model batch action', { type: 'batch', operations: [{ type: 'clear-selection' }] }],
  ]

  it.each(invalidOperations)('rejects %s and validates the whole document before reducing', (_name, operation) => {
    const initial = freezeDeep(createInitialState(createFixture(1)))
    const document = { ...scenario(), operations: [{ type: 'clear-selection' }, operation] }
    const reducer = vi.spyOn(model, 'reduceModel')
    const result = validateScenario(document)
    expect(result.valid).toBe(false)
    expect(result.errors.join('; ')).toContain('scenario.operations[1]')
    expect(() => runScenario(initial, document as ScenarioDocument)).toThrow(/Invalid scenario/)
    expect(reducer).not.toHaveBeenCalled()
  })

  it.each([null, [], {}, { ...scenario(), version: '1' }, { ...scenario(), name: 0 }, { ...scenario(), extra: true }].map((value) => [value]))
    ('rejects malformed document %j', (value) => {
      expect(validateScenario(value).valid).toBe(false)
      expect(() => parseScenario(JSON.stringify(value))).toThrow(/Invalid scenario/)
    })

  it('rejects array holes, returns all errors, and round-trips a valid document', () => {
    expect(validateScenario({ ...scenario(), operations: new Array(1) }).valid).toBe(false)
    const invalid = { ...scenario(), operations: [
      { type: 'update', id: 'item', patch: { id: 'other', revision: 2, value: '1' } },
      { type: 'select', id: 'item', range: 'true' },
    ] }
    const before = JSON.stringify(invalid)
    const result = validateScenario(invalid)
    expect(result.errors.join('; ')).toContain('unknown field id')
    expect(result.errors.join('; ')).toContain('unknown field revision')
    expect(result.errors.join('; ')).toContain('patch.value')
    expect(result.errors.join('; ')).toContain('range')
    expect(JSON.stringify(invalid)).toBe(before)
    const document = scenario([{ type: 'update', id: 'item', patch: {} }, { type: 'set-filter', filter: {} }])
    expect(parseScenario(serializeScenario(document))).toEqual(document)
    const parsed = parseScenario(serializeScenario(document))
    parsed.operations[0] = { type: 'set-filter', filter: { query: 'mutated' } }
    expect(parseScenario(serializeScenario(document))).toEqual(document)
    expect(() => serializeScenario(invalid as unknown as ScenarioDocument)).toThrow()
    expect(() => parseScenario('{"format":"listview-model-studio-scenario","version":1,"name":"x","operations":[{"type":"clear-selection"},{"type":"clear-selection"}]}'))
      .not.toThrow()
    expect(() => parseScenario('{')).toThrow(/JSON/)
  })
})

describe('scenario execution boundaries', () => {
  const first = 'fixture-00001'
  const second = 'fixture-00002'
  const added = createNewItem(1)
  const failures: [string, ScenarioOperation][] = [
    ['duplicate add', { type: 'add', item: createFixture(1)[0] }],
    ['missing update', { type: 'update', id: 'missing', patch: {} }],
    ['missing remove', { type: 'remove', ids: ['missing'] }],
    ['partially missing remove', { type: 'remove', ids: [first, 'missing'] }],
    ['missing select', { type: 'select', id: 'missing' }],
    ['prototype select', { type: 'select', id: 'toString' }],
    ['incomplete reorder', { type: 'reorder', ids: [first] }],
    ['unknown reorder ID', { type: 'reorder', ids: [first, 'missing'] }],
    ['missing batch update', { type: 'batch', operations: [
      { type: 'update', id: first, patch: { value: 777 } },
      { type: 'update', id: 'missing', patch: {} },
    ] }],
    ['partially missing batch remove', { type: 'batch', operations: [
      { type: 'update', id: first, patch: { value: 777 } },
      { type: 'remove', ids: [first, 'missing'] },
    ] }],
    ['duplicate batch adds', { type: 'batch', operations: [
      { type: 'add', item: added }, { type: 'add', item: added },
    ] }],
    ['batch original ID reuse', { type: 'batch', operations: [
      { type: 'remove', ids: [first] }, { type: 'add', item: createFixture(1)[0] },
    ] }],
    ['batch new ID reuse', { type: 'batch', operations: [
      { type: 'add', item: added }, { type: 'remove', ids: [added.id] }, { type: 'add', item: added },
    ] }],
    ['batch update after remove', { type: 'batch', operations: [
      { type: 'remove', ids: [first] }, { type: 'update', id: first, patch: {} },
    ] }],
  ]

  it.each(failures)('rejects %s atomically after earlier valid operations', (_name, operation) => {
    const initial = freezeDeep(createInitialState(createFixture(2)))
    const document = freezeDeep(scenario([
      { type: 'select', id: first },
      { type: 'update', id: second, patch: { value: 999 } },
      operation,
    ]))
    const initialJson = JSON.stringify(initial)
    const documentJson = JSON.stringify(document)
    expect(() => runScenario(initial, document)).toThrow(/Scenario operation 3 rejected/)
    expect(JSON.stringify(initial)).toBe(initialJson)
    expect(JSON.stringify(document)).toBe(documentJson)
  })

  it('matches direct reducer state and views at every step through all supported operations', () => {
    const items = createFixture(3).map((item) => ({ ...item, active: true }))
    const initial = freezeDeep(createInitialState(items))
    const third = items[2].id
    const otherAdded = createNewItem(2)
    const document = freezeDeep(scenario([
      { type: 'add', item: added },
      { type: 'select', id: first },
      { type: 'set-filter', filter: { query: second } },
      { type: 'update', id: first, patch: { title: 'Hidden edit' } },
      { type: 'select', id: second, additive: true },
      { type: 'set-selection-mode', mode: 'single' },
      { type: 'set-selection-mode', mode: 'multiple' },
      { type: 'set-filter', filter: { query: '' } },
      { type: 'reorder', ids: [added.id, third, second, first] },
      { type: 'select', id: added.id },
      { type: 'select', id: second, range: true },
      { type: 'batch', label: 'Mixed transaction', operations: [
        { type: 'update', id: first, patch: { value: 999 } },
        { type: 'update', id: first, patch: { value: 999 } },
        { type: 'update', id: added.id, patch: { active: false } },
        { type: 'remove', ids: [third] },
        { type: 'add', item: otherAdded },
        { type: 'update', id: otherAdded.id, patch: {} },
      ] },
      { type: 'select', id: added.id, additive: true },
      { type: 'remove', ids: [added.id] },
      { type: 'clear-selection' },
    ]))
    const run = runScenario(initial, document)
    let direct = initial
    expect(run.steps).toHaveLength(document.operations.length + 1)
    for (let index = 0; index < run.steps.length; index += 1) {
      if (index > 0) direct = reduceModel(direct, document.operations[index - 1])
      const step = run.steps[index]
      expect(step.index).toBe(index)
      expect(step.operation).toEqual(index === 0 ? null : document.operations[index - 1])
      expect(step.accepted).toBe(true)
      expect(step.summary).toBe(index === 0 ? 'Initial state' : direct.events[0].summary)
      expect(step.model).toEqual({
        total: direct.order.length,
        order: direct.order,
        selectedIds: direct.selectedIds,
        anchorId: direct.anchorId,
        filter: direct.filter,
        selectionMode: direct.selectionMode,
        updateMetrics: direct.updateMetrics,
        itemsById: direct.itemsById,
      })
      const ids = selectVisibleIds(direct)
      expect(step.visible).toEqual({ count: ids.length, ids, firstIds: ids.slice(0, 20), lastIds: ids.slice(-20) })
    }
    expect(run.state).toEqual(direct)
    expect(run.steps[4].model.selectedIds).toEqual([first])
    expect(run.steps[4].visible.ids).toEqual([second])
    expect(run.steps[11].model.selectedIds).toEqual([added.id, third, second])
    expect(run.steps[13].model.anchorId).toBe(added.id)
    expect(run.steps[13].model.selectedIds).toEqual([second])
    expect(run.steps[14].model.anchorId).toBeNull()
    expect(run.state.updateMetrics).toEqual({ requested: 5, changed: 3, skipped: 2, rejected: 0, transactions: 1 })
  })

  it('detaches returned state, operations, and item views from inputs and other trace steps', () => {
    const initial = createInitialState(createFixture(1))
    const document = scenario([{ type: 'update', id: first, patch: { title: 'Edited' } }])
    const run = runScenario(initial, document)
    const finalTitle = run.state.itemsById[first].title
    run.steps[1].model.itemsById[first].title = 'Changed trace'
    run.steps[1].model.order.push('extra')
    run.steps[1].visible.ids.push('extra')
    const operation = run.steps[1].operation
    if (operation?.type !== 'update') throw new Error('Expected update step')
    operation.patch.title = 'Changed operation'
    expect(run.state.itemsById[first].title).toBe(finalTitle)
    expect(run.state.order).toEqual([first])
    expect(document.operations).toEqual([{ type: 'update', id: first, patch: { title: 'Edited' } }])
    expect(run.steps[0].model).toMatchObject({ itemsById: initial.itemsById, order: initial.order })
    run.state.itemsById[first].title = 'Changed result'
    expect(initial.itemsById[first].title).not.toBe('Changed result')
  })

  it('accepts zero and exactly 200 operations and rejects malformed initial states', () => {
    const initial = createInitialState([])
    expect(runScenario(initial, scenario()).steps).toHaveLength(1)
    const document = scenario(Array.from({ length: 200 }, () => ({ type: 'clear-selection' })))
    expect(runScenario(initial, document).steps).toHaveLength(201)
    const invalid = { ...initial, order: ['missing'] }
    expect(() => runScenario(invalid, scenario())).toThrow(/Invalid initial model state/)
    expect(invalid.order).toEqual(['missing'])
  })
})

describe('history identity and reducer parity', () => {
  it('restores exact prior objects across multiple undo/redo steps', () => {
    const initial = freezeDeep(createInitialState(createFixture(2)))
    const actions: ScenarioOperation[] = [
      { type: 'select', id: initial.order[0] },
      { type: 'set-filter', filter: { query: initial.order[1] } },
      { type: 'update', id: initial.order[0], patch: { title: 'Hidden but selected' } },
    ]
    let history = createHistory(initial)
    let direct: ModelState = initial
    const states = [initial]
    for (const action of actions) {
      direct = reduceModel(direct, action)
      const before = freezeDeep(history)
      history = applyHistory(before, action)
      expect(history.present).toEqual(direct)
      states.push(history.present)
    }
    for (let index = states.length - 2; index >= 0; index -= 1) {
      history = undoHistory(freezeDeep(history))
      expect(history.present).toBe(states[index])
    }
    expect(undoHistory(history)).toBe(history)
    for (let index = 1; index < states.length; index += 1) {
      history = redoHistory(freezeDeep(history))
      expect(history.present).toBe(states[index])
    }
    expect(redoHistory(history)).toBe(history)
  })

  it('keeps a redo branch on reducer identity no-ops and clears it on a new edit', () => {
    const initial = createInitialState(createFixture(1))
    const changed = applyHistory(createHistory(initial), { type: 'update', id: initial.order[0], patch: { value: 100 } })
    const undone = undoHistory(changed)
    expect(applyHistory(undone, { type: 'select', id: 'missing' })).toBe(undone)
    expect(redoHistory(undone).present).toBe(changed.present)
    const branched = applyHistory(undone, { type: 'clear-selection' })
    expect(branched.future).toEqual([])
    expect(redoHistory(branched)).toBe(branched)
    expect(undoHistory(branched).present).toBe(initial)
  })
})
