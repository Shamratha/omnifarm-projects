import { describe, expect, it } from 'vitest'
import { createFixture } from './model'
import { selectionAnnouncement } from './accessibility'

describe('selection announcements', () => {
  it('announces a newly selected item with visible position', () => {
    const items = createFixture(3)
    const itemsById = Object.fromEntries(items.map((item) => [item.id, item]))
    expect(selectionAnnouncement([], [items[1].id], items.map((item) => item.id), itemsById)).toContain('visible position 2 of 3')
  })

  it('announces hidden selection counts without treating filtered items as removed', () => {
    const items = createFixture(2)
    const itemsById = Object.fromEntries(items.map((item) => [item.id, item]))
    expect(selectionAnnouncement([items[0].id], [items[0].id, items[1].id], [items[0].id], itemsById)).toContain('1 hidden by filter')
  })

  it('announces removal and clearing', () => {
    const items = createFixture(1)
    const itemsById = { [items[0].id]: items[0] }
    expect(selectionAnnouncement([items[0].id], [], [], itemsById)).toContain('Selection cleared')
    expect(selectionAnnouncement([items[0].id], [], [items[0].id], itemsById)).toContain('Selection cleared')
  })
})
