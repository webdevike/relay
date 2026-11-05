import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityItem } from '@evaos/chat-core/activity'

const m = vi.hoisted(() => ({
  openInApp: vi.fn(),
  openSubagentTab: vi.fn(),
  revealTool: vi.fn(),
  requestWatch: vi.fn(),
  rows: [{ id: 'aw1', file: '/s/aw1.jsonl' }] as Array<{ id: string; file: string }>,
  owned: vi.fn(),
}))
vi.mock('../ipc', () => ({ invoke: m.owned }))
vi.mock('../navigation/open-in-app', () => ({ openInApp: m.openInApp }))
vi.mock('../tiling/tiling-store', () => ({
  openSubagentTab: m.openSubagentTab,
  revealTool: m.revealTool,
}))
vi.mock('../terminal/terminal-watch', () => ({ requestWatch: m.requestWatch }))
vi.mock('../chat/front-chat', () => ({ frontChatPaneOf: () => 'pane-1' }))
vi.mock('../chat/chat-store', () => ({
  chatStore: { getState: () => ({ panes: { 'pane-1': { file: '/s/front.jsonl' } } }) },
}))
vi.mock('../chat/list/list-store', () => ({
  listStore: { getState: () => ({ list: { rows: m.rows } }) },
}))

import { openActivity } from './open-activity'

const item = (open: ActivityItem['open'], over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'x',
  kind: 'session',
  owner: 'assistant:nova',
  title: 'Demo',
  status: 'working',
  intent: '',
  startedAt: 1,
  updatedAt: 1,
  open,
  ...over,
})

describe('openActivity', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens a session in its chat, and an assistant thread on its page', async () => {
    m.owned.mockResolvedValue({ ok: true, value: null })
    expect(await openActivity(item({ to: 'chat', thread: 'session:aw1', session: 'aw1' }))).toBe(
      true,
    )
    expect(m.openInApp).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 'chat', chat: '/s/aw1.jsonl' }),
      'split',
    )
    expect(
      await openActivity(
        item({ to: 'chat', thread: 'assistant:astra', session: 'unknown' }),
        'tab',
      ),
    ).toBe(true)
    expect(m.openInApp).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 'agent:astra' }),
      'tab',
    )
    // A chat nobody registered and the list does not know goes nowhere.
    m.openInApp.mockClear()
    expect(await openActivity(item({ to: 'chat', thread: 'session:gone', session: 'gone' }))).toBe(
      false,
    )
    expect(m.openInApp).not.toHaveBeenCalled()
  })

  it("opens an assistant's session the list does not span as a live transcript beside the chat", async () => {
    // Started in a project folder: its file is in that folder's own sessions dir, in no row.
    m.owned.mockResolvedValue({
      ok: true,
      value: { file: '/p/-Eva-work-relay/t_abc.jsonl', title: 'Registered title', closed: false },
    })
    const chip = item(
      { to: 'chat', thread: 'session:abc', session: 'abc' },
      { title: 'Per-chat isolated pane layouts' },
    )
    expect(await openActivity(chip)).toBe(true)
    expect(m.owned).toHaveBeenCalledWith('chat.ownedSession', { session: 'abc' })
    expect(m.openSubagentTab).toHaveBeenCalledWith({
      session: '/s/front.jsonl',
      file: '/p/-Eva-work-relay/t_abc.jsonl',
      name: 'Per-chat isolated pane layouts',
    })
    // Not the assistant page the click started on.
    expect(m.openInApp).not.toHaveBeenCalled()
  })

  it("opens a helper's transcript beside the chat in front", () => {
    openActivity(item({ to: 'subagent', file: '/s/n/H.jsonl', name: 'H' }, { kind: 'helper' }))
    expect(m.openSubagentTab).toHaveBeenCalledWith({
      session: '/s/front.jsonl',
      file: '/s/n/H.jsonl',
      name: 'H',
    })
  })

  it('shows a harness in the Terminal tool, attached to its pane view-only', () => {
    openActivity(item({ to: 'terminal', pane: 'w1:p3' }, { kind: 'harness', title: 'demo-claude' }))
    expect(m.requestWatch).toHaveBeenCalledWith('w1:p3', 'demo-claude')
    expect(m.revealTool).toHaveBeenCalledWith('terminal')
  })

  it('opens a canvas agent in its room', () => {
    openActivity(item({ to: 'canvas', slug: 'roadmap' }, { kind: 'canvas' }))
    expect(m.openInApp).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 'canvas', canvas: 'roadmap' }),
      'split',
    )
  })
})
