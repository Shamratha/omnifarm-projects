import { describe, expect, it } from 'vitest'
import {
  FilterState,
  ItemPatch,
  ListItem,
  ModelOperation,
  createFixture,
  createInitialState,
  createNewItem,
  reduceModel,
  selectVisibleIds,
} from './model'

type ReferenceModel = {
  items: ListItem[]
  order: string[]
  filter: FilterState
}

function createReference(items: ListItem[]): ReferenceModel {
  return {
    items: items.map((item) => ({ ...item })),
    order: items.map((item) => item.id),
    filter: { query: '', category: 'All', activeOnly: false },
  }
}

function referenceApply(model: ReferenceModel, operation: ModelOperation) {
  if (operation.type === 'add') {
    if (model.items.some((item) => item.id === operation.item.id)) throw new Error('duplicate')
    model.items.push({ ...operation.item, revision: operation.item.revision || 1 })
    model.order.push(operation.item.id)
    return
  }
  if (operation.type === 'remove') {
    const ids = new Set(operation.ids)
    model.items = model.items.filter((item) => !ids.has(item.id))
    model.order = model.order.filter((id) => !ids.has(id))
    return
  }
  const item = model.items.find((candidate) => candidate.id === operation.id)
  if (!item) throw new Error('missing')
  const changed = (Object.keys(operation.patch) as (keyof ItemPatch)[]).some((key) => operation.patch[key] !== item[key])
  Object.assign(item, operation.patch)
  if (changed) item.revision += 1
}

function referenceVisibleIds(model: ReferenceModel): string[] {
  const itemsById = new Map(model.items.map((item) => [item.id, item]))
  return model.order.filter((id) => {
    const item = itemsById.get(id)
    if (!item) return false
    const query = model.filter.query.trim().toLowerCase()
    const textMatches = query.length === 0
      || [item.id, item.title, item.description, item.category].some((value) => value.toLowerCase().includes(query))
    const categoryMatches = model.filter.category === 'All' || item.category === model.filter.category
    return textMatches && categoryMatches && (!model.filter.activeOnly || item.active)
  })
}

function expectCanonicalModelsToMatch(state: ReturnType<typeof createInitialState>, reference: ReferenceModel) {
  expect(state.order).toEqual(reference.order)
  expect(state.order.map((id) => state.itemsById[id])).toEqual(
    reference.order.map((id) => reference.items.find((item) => item.id === id)),
  )
}

describe('incremental list model', () => {
  it('keeps IDs stable across updates and filters', () => {
    const [first, second] = createFixture(2)
    let state = createInitialState([first, second])

    state = reduceModel(state, { type: 'update', id: first.id, patch: { title: 'Only alpha' } })
    expect(state.itemsById[first.id].id).toBe(first.id)
    expect(state.itemsById[first.id].revision).toBe(2)

    state = reduceModel(state, { type: 'set-filter', filter: { query: 'only alpha' } })
    expect(selectVisibleIds(state)).toEqual([first.id])
    expect(state.order).toEqual([first.id, second.id])
  })

  it('removes selected items from both the collection and selection', () => {
    const [first, second] = createFixture(2)
    let state = createInitialState([first, second])
    state = reduceModel(state, { type: 'select', id: first.id, visibleIds: state.order })
    state = reduceModel(state, { type: 'select', id: second.id, additive: true, visibleIds: state.order })
    state = reduceModel(state, { type: 'remove', ids: [first.id] })

    expect(state.order).toEqual([second.id])
    expect(state.selectedIds).toEqual([second.id])
    expect(state.itemsById[first.id]).toBeUndefined()
  })

  it('supports visible range selection without selecting hidden rows', () => {
    const items = createFixture(4)
    items[1] = { ...items[1], active: false }
    let state = createInitialState(items)
    state = reduceModel(state, { type: 'select', id: items[0].id, visibleIds: state.order })
    state = reduceModel(state, { type: 'set-filter', filter: { activeOnly: true } })
    const visibleIds = selectVisibleIds(state)
    const lastVisibleId = visibleIds[visibleIds.length - 1]
    state = reduceModel(state, { type: 'select', id: lastVisibleId, range: true, visibleIds })

    expect(state.selectedIds.every((id) => visibleIds.includes(id))).toBe(true)
  })

  it('rejects duplicate IDs without changing the model', () => {
    const item = createFixture(1)[0]
    let state = createInitialState([item])
    state = reduceModel(state, { type: 'add', item })

    expect(state.order).toEqual([item.id])
    expect(state.events[0].status).toBe('rejected')
  })

  it('adds local items with a distinct stable ID', () => {
    const state = createInitialState([])
    const item = createNewItem(state.nextItemNumber)
    const next = reduceModel(state, { type: 'add', item })

    expect(next.order).toEqual([item.id])
    expect(next.itemsById[item.id].revision).toBe(1)
  })

  it('keeps a selected ID when editing it, even when the edit hides it', () => {
    const item = createFixture(1)[0]
    let state = createInitialState([item])
    state = reduceModel(state, { type: 'select', id: item.id })
    state = reduceModel(state, { type: 'update', id: item.id, patch: { title: 'No longer matches' } })
    state = reduceModel(state, { type: 'set-filter', filter: { query: 'never matches' } })

    expect(state.selectedIds).toEqual([item.id])
    expect(selectVisibleIds(state)).toEqual([])
    expect(state.itemsById[item.id].revision).toBe(2)
  })

  it('preserves selected IDs when a filter hides them without changing the data', () => {
    const items = createFixture(2)
    let state = createInitialState(items)
    state = reduceModel(state, { type: 'select', id: items[0].id })
    state = reduceModel(state, { type: 'set-filter', filter: { query: items[1].id } })

    expect(state.selectedIds).toEqual([items[0].id])
    expect(selectVisibleIds(state)).toEqual([items[1].id])
    expect(state.itemsById[items[0].id]).toEqual(items[0])
  })

  it('removes selected IDs and clears a removed anchor without selecting a neighbor', () => {
    const items = createFixture(3)
    let state = createInitialState(items)
    state = reduceModel(state, { type: 'select', id: items[0].id })
    state = reduceModel(state, { type: 'select', id: items[1].id, additive: true })
    expect(state.anchorId).toBe(items[1].id)
    state = reduceModel(state, { type: 'remove', ids: [items[1].id] })

    expect(state.selectedIds).toEqual([items[0].id])
    expect(state.anchorId).toBeNull()
    expect(state.order).toEqual([items[0].id, items[2].id])
  })

  it('keeps selection and anchor IDs stable while reorder changes range order', () => {
    const items = createFixture(4)
    let state = createInitialState(items)
    state = reduceModel(state, { type: 'select', id: items[0].id })
    state = reduceModel(state, { type: 'reorder', ids: [items[3].id, items[2].id, items[1].id, items[0].id] })
    state = reduceModel(state, { type: 'select', id: items[2].id, range: true })

    expect(state.selectedIds).toEqual([items[0].id, items[2].id, items[1].id])
    expect(state.anchorId).toBe(items[0].id)
    expect(state.events[0].kind).toBe('selection')
    expect(state.events[1].kind).toBe('reorder')
  })

  it('commits a valid batch as one transaction and preserves selected IDs', () => {
    const items = createFixture(2)
    let state = createInitialState(items)
    state = reduceModel(state, { type: 'select', id: items[0].id })
    state = reduceModel(state, { type: 'select', id: items[1].id, additive: true })
    const beforeEvents = state.events.length
    state = reduceModel(state, {
      type: 'batch',
      label: 'Increment selected',
      operations: state.selectedIds.map((id) => ({ type: 'update' as const, id, patch: { value: state.itemsById[id].value + 1 } })),
    })

    expect(state.events).toHaveLength(beforeEvents + 1)
    expect(state.events[0].kind).toBe('transaction')
    expect(state.events[0].status).toBe('success')
    expect(state.selectedIds).toEqual([items[0].id, items[1].id])
    expect(state.itemsById[items[0].id].value).toBe(items[0].value + 1)
    expect(state.itemsById[items[1].id].value).toBe(items[1].value + 1)
  })

  it('includes filtered-out selected IDs in a batch transaction', () => {
    const items = createFixture(2)
    let state = createInitialState(items)
    state = reduceModel(state, { type: 'select', id: items[0].id })
    state = reduceModel(state, { type: 'set-filter', filter: { query: items[1].id } })
    state = reduceModel(state, {
      type: 'batch',
      operations: [{ type: 'update', id: items[0].id, patch: { value: items[0].value + 5 } }],
    })

    expect(state.itemsById[items[0].id].value).toBe(items[0].value + 5)
    expect(state.selectedIds).toEqual([items[0].id])
    expect(selectVisibleIds(state)).toEqual([items[1].id])
  })

  it('rolls back a batch when any operation is invalid or duplicates an ID', () => {
    const item = createFixture(1)[0]
    const added = createNewItem(1)
    const initial = createInitialState([item])
    const state = reduceModel(initial, {
      type: 'batch',
      operations: [
        { type: 'update', id: item.id, patch: { value: 777 } },
        { type: 'add', item },
        { type: 'add', item: added },
      ],
    })

    expect(state.order).toEqual(initial.order)
    expect(state.itemsById[item.id].value).toBe(item.value)
    expect(state.itemsById[added.id]).toBeUndefined()
    expect(state.events[0].status).toBe('rejected')
    expect(state.events[0].detail).toContain('no changes committed')
  })

  it('rejects duplicate IDs in the initial fixture and in reorder permutations', () => {
    const items = createFixture(2)
    expect(() => createInitialState([items[0], { ...items[1], id: items[0].id }])).toThrow(/Duplicate/)

    const state = createInitialState(items)
    const rejected = reduceModel(state, { type: 'reorder', ids: [items[0].id, items[0].id] })
    expect(rejected.order).toEqual(state.order)
    expect(rejected.events[0].status).toBe('rejected')
  })

  it('matches a simple array reference through mixed incremental operations', () => {
    const items = createFixture(6)
    const reference = createReference(items)
    let state = createInitialState(items)
    const added = createNewItem(50)
    const operations: ModelOperation[] = [
      { type: 'update', id: items[1].id, patch: { title: 'reference update', value: 321 } },
      { type: 'add', item: added },
      { type: 'remove', ids: [items[4].id] },
    ]

    for (const operation of operations) {
      state = reduceModel(state, operation)
      referenceApply(reference, operation)
      expectCanonicalModelsToMatch(state, reference)
    }

    const batchOperations: ModelOperation[] = [
      { type: 'update', id: items[2].id, patch: { value: 404 } },
      { type: 'update', id: added.id, patch: { active: false } },
    ]
    state = reduceModel(state, { type: 'batch', operations: batchOperations, label: 'Reference batch' })
    batchOperations.forEach((operation) => referenceApply(reference, operation))
    expectCanonicalModelsToMatch(state, reference)

    const reordered = [...reference.order].reverse()
    state = reduceModel(state, { type: 'reorder', ids: reordered })
    reference.order = reordered
    expectCanonicalModelsToMatch(state, reference)

    reference.filter = { query: 'reference', category: 'All', activeOnly: false }
    state = reduceModel(state, { type: 'set-filter', filter: reference.filter })
    expect(selectVisibleIds(state)).toEqual(referenceVisibleIds(reference))
  })
})
