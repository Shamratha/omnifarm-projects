import { describe, expect, it } from 'vitest'
import {
  ModelOperation,
  UpdateMetrics,
  createFixture,
  createInitialState,
  createNewItem,
  reduceModel,
  selectVisibleItems,
} from './model'

const zeroMetrics: UpdateMetrics = { requested: 0, changed: 0, skipped: 0, rejected: 0, transactions: 0 }

describe('model update metrics', () => {
  it('counts real updates, no-ops, and unknown IDs once per operation', () => {
    const [item] = createFixture(1)
    const initial = createInitialState([item])
    expect(initial.updateMetrics).toEqual(zeroMetrics)

    let state = reduceModel(initial, {
      type: 'update',
      id: item.id,
      patch: { title: 'Updated title', value: item.value + 1 },
    })
    expect(state.updateMetrics).toEqual({ requested: 1, changed: 1, skipped: 0, rejected: 0, transactions: 0 })
    expect(state.itemsById[item.id].revision).toBe(item.revision + 1)
    expect(initial.updateMetrics).toEqual(zeroMetrics)
    const updatedItem = state.itemsById[item.id]

    state = reduceModel(state, {
      type: 'update',
      id: item.id,
      patch: { title: 'Updated title', value: item.value + 1 },
    })
    expect(state.updateMetrics).toEqual({ requested: 2, changed: 1, skipped: 1, rejected: 0, transactions: 0 })
    expect(state.itemsById[item.id]).toBe(updatedItem)

    state = reduceModel(state, { type: 'update', id: 'missing', patch: {} })
    expect(state.updateMetrics).toEqual({ requested: 3, changed: 1, skipped: 1, rejected: 1, transactions: 0 })
    expect(state.itemsById[item.id]).toBe(updatedItem)
    expect(state.itemsById.missing).toBeUndefined()
    expect(state.order).toEqual([item.id])
  })

  it('counts repeated same-ID updates and no-ops in committed batch order', () => {
    const [item, other] = createFixture(2)
    const initial = createInitialState([item, other])
    const state = reduceModel(initial, {
      type: 'batch',
      operations: [
        { type: 'update', id: item.id, patch: { value: item.value + 1 } },
        { type: 'update', id: item.id, patch: { value: item.value + 1 } },
        { type: 'update', id: item.id, patch: { value: item.value } },
        { type: 'update', id: other.id, patch: {} },
      ],
    })

    expect(state.updateMetrics).toEqual({ requested: 4, changed: 2, skipped: 2, rejected: 0, transactions: 1 })
    expect(state.itemsById[item.id].value).toBe(item.value)
    expect(state.itemsById[item.id].revision).toBe(item.revision + 2)
    expect(state.itemsById[other.id]).toBe(other)
    expect(state.events).toHaveLength(initial.events.length + 1)
    expect(state.events[0]).toMatchObject({ kind: 'transaction', status: 'success' })
    expect(initial.updateMetrics).toEqual(zeroMetrics)
  })

  it('counts add/remove and all-no-op committed batches as transactions', () => {
    const [item] = createFixture(1)
    const added = createNewItem(1)
    let state = reduceModel(createInitialState([item]), {
      type: 'batch',
      operations: [{ type: 'add', item: added }, { type: 'remove', ids: [item.id] }],
    })
    expect(state.updateMetrics).toEqual({ requested: 0, changed: 0, skipped: 0, rejected: 0, transactions: 1 })
    expect(state.order).toEqual([added.id])

    state = reduceModel(state, {
      type: 'batch',
      operations: [{ type: 'update', id: added.id, patch: { value: added.value } }],
    })
    expect(state.updateMetrics).toEqual({ requested: 1, changed: 0, skipped: 1, rejected: 0, transactions: 2 })

    const metrics = state.updateMetrics
    state = reduceModel(state, { type: 'batch', operations: [] })
    expect(state.updateMetrics).toEqual(metrics)
    expect(state.events[0].status).toBe('rejected')

    const standaloneItem = createNewItem(2)
    state = reduceModel(state, { type: 'add', item: standaloneItem })
    state = reduceModel(state, { type: 'remove', ids: [standaloneItem.id] })
    expect(state.updateMetrics).toEqual(metrics)
  })

  const rejectedBatches: { reason: string; failure: ModelOperation[]; rejectedUpdates: number }[] = [
    { reason: 'missing remove', failure: [{ type: 'remove', ids: ['missing'] }], rejectedUpdates: 3 },
    { reason: 'partially missing remove', failure: [{ type: 'remove', ids: ['fixture-00001', 'missing'] }], rejectedUpdates: 3 },
    { reason: 'duplicate existing ID', failure: [{ type: 'add', item: createFixture(1)[0] }], rejectedUpdates: 3 },
    {
      reason: 'duplicate added ID',
      failure: [{ type: 'add', item: createNewItem(1) }, { type: 'add', item: createNewItem(1) }],
      rejectedUpdates: 3,
    },
    { reason: 'empty added ID', failure: [{ type: 'add', item: { ...createNewItem(1), id: '' } }], rejectedUpdates: 3 },
    { reason: 'missing update', failure: [{ type: 'update', id: 'missing', patch: {} }], rejectedUpdates: 4 },
  ]

  it.each(rejectedBatches)('rejects every submitted batch update on $reason and preserves prior metrics', ({ failure, rejectedUpdates }) => {
    const [item] = createFixture(1)
    let before = createInitialState([item])
    before = reduceModel(before, { type: 'select', id: item.id })
    before = reduceModel(before, {
      type: 'batch',
      operations: [{ type: 'update', id: item.id, patch: { value: item.value + 1 } }],
    })
    before = reduceModel(before, { type: 'update', id: item.id, patch: {} })
    before = reduceModel(before, { type: 'update', id: 'previously-missing', patch: {} })
    expect(before.updateMetrics).toEqual({ requested: 3, changed: 1, skipped: 1, rejected: 1, transactions: 1 })

    const state = reduceModel(before, {
      type: 'batch',
      operations: [
        { type: 'update', id: item.id, patch: { value: item.value + 2 } },
        { type: 'update', id: item.id, patch: { value: item.value + 2 } },
        ...failure,
        { type: 'update', id: item.id, patch: { title: 'After the failure' } },
      ],
    })

    expect(state.updateMetrics).toEqual({
      requested: 3 + rejectedUpdates,
      changed: 1,
      skipped: 1,
      rejected: 1 + rejectedUpdates,
      transactions: 1,
    })
    expect(state.itemsById).toBe(before.itemsById)
    expect(state.order).toBe(before.order)
    expect(state.selectedIds).toBe(before.selectedIds)
    expect(state.anchorId).toBe(before.anchorId)
    expect(state.nextItemNumber).toBe(before.nextItemNumber)
    expect(state.events[0]).toMatchObject({ kind: 'transaction', status: 'rejected' })
    expect(before.updateMetrics).toEqual({ requested: 3, changed: 1, skipped: 1, rejected: 1, transactions: 1 })
  })

  it('preserves all metrics when clearing events and zeros them on reset', () => {
    const [item] = createFixture(1)
    let state = createInitialState([item])
    state = reduceModel(state, { type: 'update', id: item.id, patch: { value: item.value + 1 } })
    state = reduceModel(state, { type: 'update', id: item.id, patch: {} })
    state = reduceModel(state, { type: 'update', id: 'missing', patch: {} })
    state = reduceModel(state, { type: 'batch', operations: [{ type: 'add', item: createNewItem(1) }] })
    const metrics = { requested: 3, changed: 1, skipped: 1, rejected: 1, transactions: 1 }
    expect(state.updateMetrics).toEqual(metrics)

    state = reduceModel(state, { type: 'clear-events' })
    expect(state.events).toEqual([])
    expect(state.updateMetrics).toEqual(metrics)

    state = reduceModel(state, { type: 'reset' })
    expect(state.updateMetrics).toEqual(zeroMetrics)
    state = reduceModel(state, { type: 'update', id: state.order[0], patch: {} })
    expect(state.updateMetrics).toEqual({ requested: 1, changed: 0, skipped: 1, rejected: 0, transactions: 0 })
  })

  it('retains cumulative counts after the event log cap is exceeded', () => {
    const [item] = createFixture(1)
    let state = createInitialState([item])
    for (let increment = 1; increment <= 100; increment += 1) {
      state = reduceModel(state, { type: 'update', id: item.id, patch: { value: item.value + increment } })
    }

    expect(state.events).toHaveLength(80)
    expect(state.updateMetrics).toEqual({ requested: 100, changed: 100, skipped: 0, rejected: 0, transactions: 0 })
    state = reduceModel(state, { type: 'clear-events' })
    state = reduceModel(state, { type: 'update', id: item.id, patch: { value: item.value + 100 } })
    expect(state.updateMetrics).toEqual({ requested: 101, changed: 100, skipped: 1, rejected: 0, transactions: 0 })
  })

  it('returns every matching item in canonical order without counting selector reads', () => {
    const items = createFixture(1_000)
    let state = createInitialState(items)
    expect(selectVisibleItems(state)).toEqual(items)

    state = reduceModel(state, { type: 'select', id: items[0].id })
    state = reduceModel(state, { type: 'reorder', ids: [...state.order].reverse() })
    state = reduceModel(state, { type: 'set-filter', filter: { query: 'fixture-', category: 'Music', activeOnly: true } })
    const expected = [...items].reverse().filter((item) => item.category === 'Music' && item.active)
    expect(expected.length).toBeGreaterThan(120)
    expect(selectVisibleItems(state)).toEqual(expected)
    expect(selectVisibleItems(state)).toEqual(expected)
    expect(state.selectedIds).toEqual([items[0].id])
    expect(state.anchorId).toBe(items[0].id)
    expect(state.updateMetrics).toEqual(zeroMetrics)
  })
})
