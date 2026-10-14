import type { ListItem } from './model'

function itemLabel(id: string, itemsById: Record<string, ListItem>): string {
  return itemsById[id]?.title ?? id
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export function selectionAnnouncement(
  previousIds: string[],
  selectedIds: string[],
  visibleIds: string[],
  itemsById: Record<string, ListItem>,
): string {
  const previous = new Set(previousIds)
  const current = new Set(selectedIds)
  const added = selectedIds.filter((id) => !previous.has(id))
  const removed = previousIds.filter((id) => !current.has(id))
  const hiddenCount = selectedIds.filter((id) => !visibleIds.includes(id)).length
  const visibleCount = selectedIds.length - hiddenCount

  if (selectedIds.length === 0) return 'Selection cleared. 0 items selected.'
  if (added.length === 1 && removed.length === 0 && hiddenCount === 0) {
    const id = added[0]
    const position = visibleIds.indexOf(id)
    const location = position >= 0 ? `visible position ${position + 1} of ${visibleIds.length}` : 'hidden by the current filter'
    return `${itemLabel(id, itemsById)} selected. ${location}. ${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'} selected.`
  }
  if (removed.length === 1 && added.length === 0 && hiddenCount === 0) {
    return `${itemLabel(removed[0], itemsById)} unselected. ${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'} selected.`
  }
  if (sameIds(previousIds, selectedIds)) {
    return `${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'} selected. ${visibleCount} visible of ${visibleIds.length}; ${hiddenCount} hidden by filter.`
  }
  return `${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'} selected. ${visibleCount} visible of ${visibleIds.length}; ${hiddenCount} hidden by filter.`
}
