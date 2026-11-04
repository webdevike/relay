import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Assistants } from '@evaos/contract'
import { createConfigStore } from '../config-store'
import { PREFS_FILE, REPEAT_MS, STATE_FILE, createNotifier, type NotifyPlatform } from './notifier'
import type { ClickTarget } from './policy'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function setup(config = createConfigStore(dir)) {
  const shown: Array<{
    groupId: string
    title: string
    body: string
    silent: boolean
    click(): void
  }> = []
  const opened: ClickTarget[] = []
  const clock = { now: 1_000_000, idle: 3, focused: false }
  const platform: NotifyPlatform = {
    supported: () => true,
    show: ({ groupId, title, body, silent, onClick }) =>
      shown.push({ groupId, title, body, silent, click: onClick }),
    windowFocused: () => clock.focused,
    idleSeconds: () => clock.idle,
    now: () => clock.now,
    open: (t) => opened.push(t),
  }
  const changed: unknown[] = []
  const notifier = createNotifier({
    config,
    platform,
    assistantOfFile: (f) => (f === '/s/nova.jsonl' ? 'nova' : null),
    onPrefs: (p) => changed.push(p),
  })
  return { notifier, shown, opened, clock, changed, config }
}

const agents = (text: string, at: number, status: 'idle' | 'working' = 'idle'): Assistants => ({
  relayUp: true,
  agents: ['nova', 'astra'].map((id) => ({
    id,
    title: id === 'nova' ? 'Nova' : 'Astra',
    scope: '',
    avatar: { style: 'notionists' as const, seed: id },
    status,
    tool: null,
    file: `/s/${id}.jsonl`,
    // `at` is a small offset from just before the test clock's now, so every reply is fresh.
    reply: { text: `${id}: ${text}`, at: 1_000_000 - 1_000 + at },
  })),
})

describe('notifier', () => {
  it('shows an assistant reply in its own group, and a click opens that assistant', () => {
    const { notifier, shown, opened } = setup()
    notifier.onAssistants(agents('hi', 1))
    notifier.onAssistants(agents('done', 2))
    expect(shown.map((n) => [n.groupId, n.title, n.body])).toEqual([
      ['assistant:nova', 'Nova', 'nova: done'],
      ['assistant:astra', 'Astra', 'astra: done'],
    ])
    shown[0]!.click()
    expect(opened).toEqual([{ link: 'relay://assistant/nova' }])
  })

  it('respects the per-assistant mute and the global switch, and saves both', () => {
    const { notifier, shown, changed, config } = setup()
    notifier.setPrefs({ muted: ['nova', 'nova'] })
    expect(notifier.prefs()).toEqual({ enabled: true, muted: ['nova'] })
    notifier.onAssistants(agents('hi', 1))
    notifier.onAssistants(agents('done', 2))
    expect(shown.map((n) => n.title)).toEqual(['Astra'])
    notifier.setPrefs({ enabled: false })
    notifier.onAssistants(agents('later', 3))
    expect(shown).toHaveLength(1)
    expect(config.readJson(PREFS_FILE, null)).toEqual({ enabled: false, muted: ['nova'] })
    expect(changed).toHaveLength(2)
    // A new notifier on the same folder reads them back.
    expect(setup(config).notifier.prefs()).toEqual({ enabled: false, muted: ['nova'] })
  })

  it('says nothing while the Mac is idle (the phone has it) and speaks again after input', () => {
    const { notifier, shown, clock } = setup()
    notifier.onAssistants(agents('hi', 1))
    clock.idle = 601
    notifier.onAssistants(agents('while away', 2))
    expect(shown).toHaveLength(0)
    expect(notifier.skipped().map((s) => s.reason)).toEqual(['away', 'away'])
    clock.idle = 2
    notifier.onAssistants(agents('back', 3))
    expect(shown).toHaveLength(2)
  })

  it('stays quiet for the chat in front of a focused window only', () => {
    const { notifier, shown, clock } = setup()
    notifier.onAssistants(agents('hi', 1))
    clock.focused = true
    notifier.setVisible(['assistant:nova'])
    notifier.onAssistants(agents('done', 2))
    expect(shown.map((n) => n.title)).toEqual(['Astra'])
  })

  it('tells a chat waiting on Isaac once even when the chat list and the Working list both say it', () => {
    const { notifier, shown, opened } = setup()
    const row = {
      id: 'abc',
      file: '/s/nova.jsonl',
      title: 'Thread',
    }
    notifier.onChatList({ rows: [], prefs: {} as never, error: null }, [
      { ...row, kind: 'needs-approval', body: 'Needs your approval' },
    ])
    notifier.onActivity([
      {
        id: 'session:abc:ask',
        kind: 'session',
        owner: 'assistant:nova',
        title: 'Nova',
        status: 'waiting',
        intent: 'Merge?',
        startedAt: 1_000_000,
        updatedAt: 1_000_000,
        open: { to: 'chat', thread: 'assistant:nova' },
      },
    ])
    expect(shown).toHaveLength(1)
    expect(notifier.skipped()).toEqual([{ key: 'waiting:assistant:nova', reason: 'repeat' }])
    shown[0]!.click()
    expect(opened).toEqual([{ chat: '/s/nova.jsonl' }])
  })

  it('tells the same thing again after the repeat window', () => {
    const { notifier, shown, clock } = setup()
    const alert = {
      id: 'x',
      file: '/s/x.jsonl',
      kind: 'has-question' as const,
      title: 'T',
      body: 'B',
    }
    const empty = { rows: [], prefs: {} as never, error: null }
    notifier.onChatList(empty, [alert])
    notifier.onChatList(empty, [alert])
    clock.now += REPEAT_MS
    notifier.onChatList(empty, [alert])
    expect(shown).toHaveLength(2)
  })

  it('announces an update once per build, across restarts', () => {
    const { notifier, shown, config } = setup()
    const state = { pending: true, build: 'abc123', summary: 'Notifications.' }
    notifier.onUpdate(state)
    notifier.onUpdate(state)
    expect(shown.map((n) => [n.groupId, n.title])).toEqual([['update', 'Relay update ready']])
    expect(config.readJson(STATE_FILE, null)).toEqual({ updateBuild: 'abc123' })
    // Relaunched on the same config folder: the build was told already.
    const again = setup(config)
    again.notifier.onUpdate(state)
    expect(again.shown).toHaveLength(0)
  })

  it('test() shows past every rule', () => {
    const { notifier, shown, clock, opened } = setup()
    clock.idle = 99_999
    notifier.setPrefs({ enabled: false })
    expect(notifier.test()).toBe(true)
    expect(shown).toHaveLength(1)
    shown[0]!.click()
    expect(opened).toEqual([{ link: 'relay://open/settings/notifications' }])
  })
})
