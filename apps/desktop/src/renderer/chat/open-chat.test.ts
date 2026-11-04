import { beforeEach, describe, expect, it, vi } from 'vitest'

type Resolve = (v: unknown) => void
const pending = new Map<string, Resolve>()
const invoke = vi.fn(
  (_ch: string, args: { file: string }) =>
    new Promise((res) => {
      pending.set(args.file, res)
    }),
)
const show = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: [string, { file: string }]) => invoke(...a) }))
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import { chatStore } from './chat-store'
import { dropChatPane, newChatPaneId, openChatFile } from './open-chat'

const MAIN = 'pane-main'

const ok = (title: string) => ({
  ok: true,
  value: {
    title,
    messages: [],
    meta: { model: null, thinking: null, contextTokens: null },
    owner: null,
  },
})

beforeEach(() => {
  invoke.mockClear()
  show.mockClear()
  pending.clear()
})

describe('openChatFile', () => {
  it('re-opens the shown chat when another open is in flight, dropping the stale result', async () => {
    const a = openChatFile('/s/a.jsonl', MAIN)
    pending.get('/s/a.jsonl')!(ok('A'))
    await a
    expect(chatStore.getState().panes[MAIN]?.file).toBe('/s/a.jsonl')

    const b = openChatFile('/s/b.jsonl', MAIN)
    const again = openChatFile('/s/a.jsonl', MAIN)
    expect(invoke).toHaveBeenCalledTimes(3)
    pending.get('/s/b.jsonl')!(ok('B'))
    pending.get('/s/a.jsonl')!(ok('A'))
    await Promise.all([b, again])
    expect(chatStore.getState().panes[MAIN]?.file).toBe('/s/a.jsonl')
  })

  it('surfaces a failed open', async () => {
    const p = openChatFile('/s/c.jsonl', MAIN)
    pending.get('/s/c.jsonl')!({ ok: false, error: { code: 'x', message: 'nope' } })
    await p
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'nope' }))
  })

  it("opens a second pane's chat beside another; a drop waits for its open, which then lands nowhere", async () => {
    const main = openChatFile('/s/m.jsonl', MAIN)
    pending.get('/s/m.jsonl')!(ok('M'))
    await main
    const id = newChatPaneId()
    expect(id).toMatch(/^pane-\d+$/)
    expect(newChatPaneId()).not.toBe(id)
    const tool = openChatFile('/s/nova.jsonl', id)
    expect(invoke).toHaveBeenLastCalledWith('chat.open', { paneId: id, file: '/s/nova.jsonl' })
    dropChatPane(id)
    await Promise.resolve()
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('chat.drop')
    pending.get('/s/nova.jsonl')!(ok('Nova'))
    await tool
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('chat.drop', { paneId: id }))
    expect(chatStore.getState().panes[id]).toBeUndefined()
    expect(chatStore.getState().panes[MAIN]?.file).toBe('/s/m.jsonl')
  })
})
