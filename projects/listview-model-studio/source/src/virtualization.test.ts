import { describe, expect, it } from 'vitest'
import { calculateVirtualRange, moveActiveIndex, ROW_HEIGHT, scrollTopForIndex } from './virtualization'

describe('measured virtual list range', () => {
  it('renders only a bounded overscanned window for the large fixture', () => {
    const range = calculateVirtualRange(12_000, 0, 422)

    expect(range.start).toBe(0)
    expect(range.end).toBe(13)
    expect(range.renderedCount).toBe(13)
    expect(range.bottom).toBe((12_000 - 13) * ROW_HEIGHT)
  })

  it('clamps scroll boundaries and renders the last rows without gaps', () => {
    const itemCount = 12_000
    const viewportHeight = 422
    const range = calculateVirtualRange(itemCount, Number.MAX_SAFE_INTEGER, viewportHeight)

    expect(range.scrollTop).toBe(itemCount * ROW_HEIGHT - viewportHeight)
    expect(range.end).toBe(itemCount)
    expect(range.bottom).toBe(0)
    expect(range.start).toBe(itemCount - range.renderedCount)
  })

  it('recalculates from a measured viewport height instead of a fixed capacity', () => {
    const short = calculateVirtualRange(100, 580, 200)
    const tall = calculateVirtualRange(100, 580, 500)

    expect(short.scrollTop).toBe(580)
    expect(short.start).toBe(5)
    expect(tall.start).toBe(5)
    expect(tall.renderedCount).toBeGreaterThan(short.renderedCount)
  })

  it('scrolls a target into view by index and leaves already visible rows alone', () => {
    expect(scrollTopForIndex(2, 0, 422)).toBe(0)
    expect(scrollTopForIndex(20, 0, 422)).toBe(20 * ROW_HEIGHT + ROW_HEIGHT - 422)
    expect(scrollTopForIndex(8, 200, 422)).toBe(200)
    expect(scrollTopForIndex(11_999, 0, 422, ROW_HEIGHT, 12_000)).toBe(12_000 * ROW_HEIGHT - 422)
  })

  it('handles empty projections and invalid scroll positions', () => {
    expect(calculateVirtualRange(0, 100, 422)).toEqual({ start: 0, end: 0, scrollTop: 0, top: 0, bottom: 0, renderedCount: 0 })
    expect(calculateVirtualRange(2, -100, 422).scrollTop).toBe(0)
    expect(scrollTopForIndex(-1, 100, 422)).toBe(100)
  })

  it('moves keyboard focus without wrapping and uses the measured page size', () => {
    expect(moveActiveIndex(0, 10, 'ArrowUp', 200)).toBe(0)
    expect(moveActiveIndex(0, 10, 'ArrowDown', 200)).toBe(1)
    expect(moveActiveIndex(0, 10, 'PageDown', 200)).toBe(3)
    expect(moveActiveIndex(9, 10, 'PageDown', 200)).toBe(9)
    expect(moveActiveIndex(9, 10, 'End', 200)).toBe(9)
    expect(moveActiveIndex(4, 10, 'Home', 200)).toBe(0)
    expect(moveActiveIndex(0, 0, 'ArrowDown', 200)).toBe(-1)
  })
})
