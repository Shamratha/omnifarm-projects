export const ROW_HEIGHT = 58
export const OVERSCAN_ROWS = 5

export type NavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp'

export type VirtualRange = {
  start: number
  end: number
  scrollTop: number
  top: number
  bottom: number
  renderedCount: number
}

export function calculateVirtualRange(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = ROW_HEIGHT,
  overscan = OVERSCAN_ROWS,
): VirtualRange {
  if (itemCount <= 0) {
    return { start: 0, end: 0, scrollTop: 0, top: 0, bottom: 0, renderedCount: 0 }
  }

  const safeRowHeight = Math.max(1, rowHeight)
  const safeViewportHeight = Math.max(0, viewportHeight)
  const maxScrollTop = Math.max(0, itemCount * safeRowHeight - safeViewportHeight)
  const clampedScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop)
  const firstVisible = Math.floor(clampedScrollTop / safeRowHeight)
  const visibleEnd = Math.min(itemCount, Math.max(firstVisible + 1, Math.ceil((clampedScrollTop + safeViewportHeight) / safeRowHeight)))
  const safeOverscan = Math.max(0, Math.floor(overscan))
  const start = Math.max(0, firstVisible - safeOverscan)
  const end = Math.min(itemCount, visibleEnd + safeOverscan)

  return {
    start,
    end,
    scrollTop: clampedScrollTop,
    top: start * safeRowHeight,
    bottom: Math.max(0, (itemCount - end) * safeRowHeight),
    renderedCount: end - start,
  }
}

export function scrollTopForIndex(
  index: number,
  currentScrollTop: number,
  viewportHeight: number,
  rowHeight = ROW_HEIGHT,
  itemCount = Number.POSITIVE_INFINITY,
): number {
  if (index < 0 || !Number.isFinite(index)) return currentScrollTop
  const safeRowHeight = Math.max(1, rowHeight)
  const safeViewportHeight = Math.max(0, viewportHeight)
  const itemTop = index * safeRowHeight
  const itemBottom = itemTop + safeRowHeight
  const viewportBottom = currentScrollTop + safeViewportHeight
  let nextScrollTop = currentScrollTop

  if (itemTop < currentScrollTop) nextScrollTop = itemTop
  else if (itemBottom > viewportBottom) nextScrollTop = itemBottom - safeViewportHeight

  const maxScrollTop = Math.max(0, itemCount * safeRowHeight - safeViewportHeight)
  return Math.min(Math.max(0, nextScrollTop), maxScrollTop)
}

export function moveActiveIndex(
  currentIndex: number,
  itemCount: number,
  key: NavigationKey,
  viewportHeight: number,
  rowHeight = ROW_HEIGHT,
): number {
  if (itemCount <= 0) return -1
  const current = Math.min(itemCount - 1, Math.max(0, Number.isFinite(currentIndex) ? currentIndex : 0))
  const pageRows = Math.max(1, Math.floor(Math.max(0, viewportHeight) / Math.max(1, rowHeight)))
  if (key === 'ArrowDown') return Math.min(itemCount - 1, current + 1)
  if (key === 'ArrowUp') return Math.max(0, current - 1)
  if (key === 'Home') return 0
  if (key === 'End') return itemCount - 1
  if (key === 'PageDown') return Math.min(itemCount - 1, current + pageRows)
  return Math.max(0, current - pageRows)
}
