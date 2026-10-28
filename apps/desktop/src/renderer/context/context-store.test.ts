import { describe, expect, it, vi } from 'vitest'
import { contextStore, refreshContext } from './context-store'

const answers: Array<(v: unknown) => void> = []
vi.mock('../ipc', () => ({
  invoke: vi.fn(() => new Promise((resolve) => answers.push(resolve))),
  on: vi.fn(() => () => {}),
}))

const snap = (label: string) => ({ ok: true, value: { button: { label } } })

describe('refreshContext', () => {
  it('an ask overtaken by a newer one answers with the newer snapshot', async () => {
    const first = refreshContext()
    const second = refreshContext()
    answers[0]!(snap('old'))
    answers[1]!(snap('new'))
    expect((await first)?.button.label).toBe('new')
    expect((await second)?.button.label).toBe('new')
    expect(contextStore.getState().snapshot?.button.label).toBe('new')
  })
})
