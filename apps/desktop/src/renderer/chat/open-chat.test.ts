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
vi.mock('./SessionList', () => ({ PANE_ID: 'chat' }))

import { chatStore } from './chat-store'
import { openChatFile } from './open-chat'

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
    const a = openChatFile('/s/a.jsonl')
    pending.get('/s/a.jsonl')!(ok('A'))
    await a
    expect(chatStore.getState().panes.chat?.file).toBe('/s/a.jsonl')

    const b = openChatFile('/s/b.jsonl')
    const again = openChatFile('/s/a.jsonl')
    expect(invoke).toHaveBeenCalledTimes(3)
    pending.get('/s/b.jsonl')!(ok('B'))
    pending.get('/s/a.jsonl')!(ok('A'))
    await Promise.all([b, again])
    expect(chatStore.getState().panes.chat?.file).toBe('/s/a.jsonl')
  })

  it('surfaces a failed open', async () => {
    const p = openChatFile('/s/c.jsonl')
    pending.get('/s/c.jsonl')!({ ok: false, error: { code: 'x', message: 'nope' } })
    await p
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'nope' }))
  })
})
