import { describe, expect, it } from 'vitest'
import { shouldAutoRestart, type AutoRestartInput } from './policy'

/** Local time on 2026-10-27. */
const at = (h: number, m: number): Date => new Date(2026, 9, 27, h, m)

const night = (over: Partial<AutoRestartInput> = {}): AutoRestartInput => ({
  pending: true,
  idleSeconds: 900,
  now: at(2, 0),
  chatWorking: false,
  ...over,
})

describe('shouldAutoRestart', () => {
  it('restarts when pending, idle 15 minutes, at night, with no chat working', () => {
    expect(shouldAutoRestart(night())).toBe(true)
  })

  it('needs a pending update', () => {
    expect(shouldAutoRestart(night({ pending: false }))).toBe(false)
  })

  it('needs 900 seconds idle', () => {
    expect(shouldAutoRestart(night({ idleSeconds: 899 }))).toBe(false)
    expect(shouldAutoRestart(night({ idleSeconds: 900 }))).toBe(true)
    expect(shouldAutoRestart(night({ idleSeconds: 5000 }))).toBe(true)
  })

  it('only between 23:00 and 07:59 local', () => {
    expect(shouldAutoRestart(night({ now: at(7, 59) }))).toBe(true)
    expect(shouldAutoRestart(night({ now: at(8, 0) }))).toBe(false)
    expect(shouldAutoRestart(night({ now: at(14, 0) }))).toBe(false)
    expect(shouldAutoRestart(night({ now: at(22, 59) }))).toBe(false)
    expect(shouldAutoRestart(night({ now: at(23, 0) }))).toBe(true)
    expect(shouldAutoRestart(night({ now: at(0, 0) }))).toBe(true)
  })

  it('waits while a chat this app runs is working', () => {
    expect(shouldAutoRestart(night({ chatWorking: true }))).toBe(false)
  })
})
