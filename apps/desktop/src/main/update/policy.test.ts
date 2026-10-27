import { describe, expect, it } from 'vitest'
import { shouldAutoRestart, type AutoRestartInput } from './policy'

const away = (over: Partial<AutoRestartInput> = {}): AutoRestartInput => ({
  pending: true,
  idleSeconds: 120,
  chatWorking: false,
  ...over,
})

describe('shouldAutoRestart', () => {
  it('restarts when pending, idle 2 minutes, with no chat working', () => {
    expect(shouldAutoRestart(away())).toBe(true)
  })

  it('needs a pending update', () => {
    expect(shouldAutoRestart(away({ pending: false }))).toBe(false)
  })

  it('needs 120 seconds idle', () => {
    expect(shouldAutoRestart(away({ idleSeconds: 0 }))).toBe(false)
    expect(shouldAutoRestart(away({ idleSeconds: 119 }))).toBe(false)
    expect(shouldAutoRestart(away({ idleSeconds: 120 }))).toBe(true)
    expect(shouldAutoRestart(away({ idleSeconds: 5000 }))).toBe(true)
  })

  it('waits while a chat this app runs is working, however long Isaac is away', () => {
    expect(shouldAutoRestart(away({ chatWorking: true }))).toBe(false)
    expect(shouldAutoRestart(away({ chatWorking: true, idleSeconds: 86_400 }))).toBe(false)
  })
})
