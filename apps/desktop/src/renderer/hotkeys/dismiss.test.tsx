import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { dismissTop, useDismissable } from './dismiss'

function Probe({ p, fn }: { p: number; fn: () => void }) {
  useDismissable(p, fn)
  return null
}

describe('dismiss stack', () => {
  it('returns false when empty', () => {
    expect(dismissTop()).toBe(false)
  })

  it('pops the highest priority first and unregisters on unmount', () => {
    const hi = vi.fn()
    const lo = vi.fn()
    const a = render(<Probe p={100} fn={hi} />)
    render(<Probe p={10} fn={lo} />)
    expect(dismissTop()).toBe(true)
    expect(hi).toHaveBeenCalledTimes(1)
    expect(lo).not.toHaveBeenCalled()
    a.unmount()
    expect(dismissTop()).toBe(true)
    expect(lo).toHaveBeenCalledTimes(1)
  })
})
