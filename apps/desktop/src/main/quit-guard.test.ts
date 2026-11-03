import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  dialog: {},
  ipcMain: {},
  BaseWindow: class {},
  WebContentsView: class {},
}))

import {
  confirmDetail,
  createQuitGuard,
  createReplyRegistry,
  type Entry,
  type Failure,
  type QuitGuardDeps,
} from './quit-guard'

const entry = [{ id: 'f', label: 'notes.md' }]

function make(over: Partial<QuitGuardDeps> & { choice?: 0 | 1 | 2; failures?: Failure[] } = {}) {
  const confirm = vi.fn(async () => over.choice ?? 0)
  const failure = vi.fn(async () => {})
  const saveAll = vi.fn(async () => over.failures ?? [])
  const askEdits = over.askEdits ?? vi.fn(async () => entry)
  const g = createQuitGuard({ askEdits, saveAll, dialog: { confirm, failure } })
  return { g, confirm, failure, saveAll, askEdits }
}

describe('quit guard', () => {
  it('closes without a dialog when nothing is dirty', async () => {
    const m = make({ askEdits: async () => [] })
    expect(await m.g.guardedClose()).toBe(true)
    expect(m.confirm).not.toHaveBeenCalled()
  })
  it('Cancel aborts without saving', async () => {
    const m = make({ choice: 2 })
    expect(await m.g.guardedClose()).toBe(false)
    expect(m.saveAll).not.toHaveBeenCalled()
    expect(m.g.approved()).toBe(false)
  })
  it('Discard proceeds, Save runs saves', async () => {
    const d = make({ choice: 1 })
    expect(await d.g.guardedClose()).toBe(true)
    expect(d.saveAll).not.toHaveBeenCalled()
    const s = make({ choice: 0 })
    expect(await s.g.guardedClose()).toBe(true)
    expect(s.saveAll).toHaveBeenCalled()
  })
  it('a save failure stays open with the failure box', async () => {
    const m = make({ choice: 0, failures: [{ id: 'f', label: 'notes.md', message: 'x' }] })
    expect(await m.g.guardedClose()).toBe(false)
    expect(m.failure).toHaveBeenCalledWith(
      'Could not save notes.md. EvaOS stays open so nothing is lost.',
    )
  })
  it('hung renderer fails closed and asks the user', async () => {
    vi.useFakeTimers()
    const reg = createReplyRegistry()
    const askEdits = () => reg.request<Entry[] | null>(() => {}, 2000, null)
    const m = make({ askEdits, choice: 2 })
    const p = m.g.guardedClose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe(false)
    expect(m.confirm).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('registry ignores unknown ids and resolves known ones', async () => {
    const reg = createReplyRegistry()
    let id = ''
    const p = reg.request<number>((i) => (id = i), 1000, 0)
    reg.resolve('nope', 9)
    reg.resolve(id, 7)
    expect(await p).toBe(7)
  })
  it('approval sticks and concurrent calls share one prompt', async () => {
    const m = make({ choice: 1 })
    const [a, b] = await Promise.all([m.g.guardedClose(), m.g.guardedClose()])
    expect([a, b]).toEqual([true, true])
    expect(m.confirm).toHaveBeenCalledTimes(1)
    expect(await m.g.guardedClose()).toBe(true)
    expect(m.askEdits).toHaveBeenCalledTimes(1)
  })
  it('detail lists 5 labels then a count', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, label: `f${i}` }))
    const d = confirmDetail(many)
    expect(d.split('\n').slice(0, 6)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'and 2 more'])
    expect(d).toContain('Save them before EvaOS closes, or discard them. Cancel keeps EvaOS open.')
  })
})
