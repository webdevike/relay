import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const shown = vi.hoisted(() => vi.fn())
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => undefined,
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show: shown } }))

import type { ArtifactTab } from '@evaos/chat-core/artifacts'
import { act, applyView, artifactsStore, dismissNotice, newNotices } from './artifacts-store'

const tab = (id: string, extra: Partial<ArtifactTab> = {}): ArtifactTab => ({
  id,
  title: id,
  createdBy: 'astra',
  createdAt: 0,
  hidden: false,
  rule: {},
  ...extra,
})

describe('artifacts store', () => {
  beforeEach(() => {
    localStorage.clear()
    artifactsStore.setState({ up: false, threads: {}, active: {}, notices: [] })
    invoke.mockReset()
    shown.mockReset()
  })

  it('announces an agent tab once, never a default or one Isaac made', () => {
    const tabs = [
      tab('links', { createdBy: 'default', fresh: true }),
      tab('mine', { createdBy: 'isaac', fresh: true }),
      tab('open-prs', { fresh: true }),
      tab('old'),
    ]
    expect(newNotices('assistant:astra', tabs, new Set()).map((n) => n.tab)).toEqual(['open-prs'])
    expect(newNotices('assistant:astra', tabs, new Set(['assistant:astra\nopen-prs']))).toEqual([])
  })

  it('keeps each thread, and shows a new tab notice only the first time it is seen', () => {
    const view = {
      thread: 'assistant:astra',
      up: true,
      loaded: true,
      items: [],
      tabs: [tab('open-prs', { fresh: true })],
    }
    applyView(view)
    expect(artifactsStore.getState().threads['assistant:astra']).toEqual({
      loaded: true,
      items: [],
      tabs: view.tabs,
    })
    expect(artifactsStore.getState().notices).toEqual([
      { thread: 'assistant:astra', tab: 'open-prs', by: 'astra', title: 'open-prs' },
    ])
    dismissNotice('assistant:astra', 'open-prs')
    applyView(view)
    expect(artifactsStore.getState().notices).toEqual([])
  })

  it("shows the host's refusal word for word", async () => {
    invoke.mockResolvedValue({
      ok: true,
      value: { ok: false, error: 'Isaac hid a tab like this.' },
    })
    expect(await act('assistant:astra', { op: 'tab.remove', tab: 'x' })).toEqual({
      ok: false,
      error: 'Isaac hid a tab like this.',
    })
    expect(shown).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Isaac hid a tab like this.' }),
    )
    invoke.mockResolvedValue({ ok: true, value: { ok: true, id: 'x' } })
    expect((await act('assistant:astra', { op: 'pin', id: 'url:a', pinned: true })).ok).toBe(true)
    expect(shown).toHaveBeenCalledTimes(1)
  })
})
