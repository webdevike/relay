import { describe, expect, it } from 'vitest'
import { clipAround } from './clip'

const pane = { x: 400, y: 40, width: 800, height: 700 }

describe('clipAround', () => {
  it('leaves a view alone when no hole touches it', () => {
    expect(clipAround(pane, [{ x: 0, y: 0, width: 300, height: 100 }])).toEqual(pane)
    expect(clipAround(pane, [])).toEqual(pane)
  })

  it('moves the top edge below a toast in the pane corner, keeping the rest of the page', () => {
    const toast = { x: 850, y: 48, width: 340, height: 96 }
    expect(clipAround(pane, [toast])).toEqual({ x: 400, y: 144, width: 800, height: 596 })
  })

  it('cuts the narrow side when the hole spans the view top to bottom', () => {
    const rail = { x: 1100, y: 0, width: 200, height: 900 }
    expect(clipAround(pane, [rail])).toEqual({ x: 400, y: 40, width: 700, height: 700 })
  })

  it('stacks several holes and hides the view when they swallow it', () => {
    const a = { x: 850, y: 48, width: 340, height: 96 }
    const b = { x: 850, y: 150, width: 340, height: 96 }
    expect(clipAround(pane, [a, b])).toEqual({ x: 400, y: 246, width: 800, height: 494 })
    const all = { x: 0, y: 0, width: 2000, height: 2000 }
    const gone = clipAround(pane, [all])
    expect(gone.width * gone.height).toBe(0)
  })
})
