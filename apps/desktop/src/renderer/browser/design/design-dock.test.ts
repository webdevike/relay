import { describe, expect, it } from 'vitest'
import { dockAt, dockOf, dragOver, endDrag, startDrag } from './design-dock'

const box = { x: 100, y: 50, width: 800, height: 400 }

describe('dockAt', () => {
  it('picks the edge the pointer leans to most', () => {
    expect(dockAt(box, { x: 120, y: 250 })).toBe('left')
    expect(dockAt(box, { x: 880, y: 250 })).toBe('right')
    expect(dockAt(box, { x: 500, y: 60 })).toBe('top')
    expect(dockAt(box, { x: 500, y: 440 })).toBe('bottom')
  })

  it('still answers for a pointer outside the tab', () => {
    expect(dockAt(box, { x: -300, y: 250 })).toBe('left')
    expect(dockAt(box, { x: 500, y: 2000 })).toBe('bottom')
  })
})

describe('drag', () => {
  it('moves one tab to the dock it was dropped on and leaves the others', () => {
    expect(dockOf('t1')).toBe('right')
    startDrag('t1')
    dragOver('left')
    endDrag('t1', true)
    expect(dockOf('t1')).toBe('left')
    expect(dockOf('t2')).toBe('right')
  })

  it('a cancelled drag keeps the dock', () => {
    startDrag('t1')
    dragOver('bottom')
    endDrag('t1', false)
    expect(dockOf('t1')).toBe('left')
  })
})
