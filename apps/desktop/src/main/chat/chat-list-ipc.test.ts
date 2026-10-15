import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  ipcMain: {},
  BaseWindow: class {},
  WebContentsView: class {},
}))

import { createConfigStore, type ConfigStore } from '../config-store'
import { saveSettings } from '../settings-ipc'
import { createWriteQueue } from '../write-queue'
import {
  deleteChat,
  renameChat,
  saveArchived,
  saveCollapsed,
  savePin,
  type ChatOpsDeps,
} from './chat-list-ipc'

let dir: string
let config: ConfigStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-cl-'))
  config = createConfigStore(dir)
})
const read = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'))

describe('chat.setCollapsed', () => {
  it('writes collapsed_groups and keeps every other key', () => {
    fs.writeFileSync(
      path.join(dir, 'chat.json'),
      JSON.stringify({ show_thinking: true, harness: 'claude', zoom: 2 }),
    )
    expect(saveCollapsed(config, ['Other', 'Relay'])).toEqual({ saved: true })
    expect(read()).toEqual({
      show_thinking: true,
      harness: 'claude',
      zoom: 2,
      collapsed_groups: ['Other', 'Relay'],
    })
  })

  it('de-duplicates names and creates the file when missing', () => {
    saveCollapsed(config, ['Other', 'Other', 'Eva'])
    expect(read().collapsed_groups).toEqual(['Other', 'Eva'])
  })

  it('runs through the queue in order alongside settings writes', async () => {
    const q = createWriteQueue()
    await Promise.all([
      q.enqueue(() => saveCollapsed(config, ['Other'])),
      q.enqueue(() => saveSettings(config, { show_thinking: true })),
      q.enqueue(() => saveCollapsed(config, ['Other', 'Eva'])),
    ])
    expect(read()).toMatchObject({ collapsed_groups: ['Other', 'Eva'], show_thinking: true })
  })
})

describe('chat actions', () => {
  const NOW = 2_000_000_000_000
  const OLD = (NOW - 3_600_000) / 1000
  const calls = {
    owned: [] as string[],
    resume: [] as string[],
    titles: [] as string[],
    invalidated: [] as string[],
    emitted: 0,
  }
  let sessions: string
  let agent: string
  const mk = (owner: string | null = null): ChatOpsDeps => {
    for (const k of ['owned', 'resume', 'titles', 'invalidated'] as const) calls[k] = []
    calls.emitted = 0
    return {
      sessionsDir: sessions,
      agentDir: agent,
      config,
      now: () => NOW,
      service: {
        invalidate: (f?: string) => void calls.invalidated.push(f ?? '*'),
        setTitle: (f: string, t: string) => void calls.titles.push(`${f}=${t}`),
      },
      manager: {
        ownerOf: () => owner,
        renameOwned: async (_f: string, n: string) => {
          calls.owned.push(n)
          return true
        },
      },
      resume: async (_f: string, n: string) => void calls.resume.push(n),
      emitList: () => void calls.emitted++,
    }
  }
  const session = (name: string, ageSec = OLD): string => {
    const f = path.join(sessions, name)
    fs.writeFileSync(f, '{}\n')
    fs.utimesSync(f, ageSec, ageSec)
    return f
  }
  beforeEach(() => {
    sessions = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-ops-')))
    agent = path.join(sessions, '..')
  })

  it('renames an owned chat over rpc and never short-resumes it', async () => {
    const f = session('2026_aaa.jsonl')
    const d = mk('pane-1')
    expect(await renameChat(d, f, 'Hello')).toEqual({ title: 'Hello', via: 'rpc' })
    expect(calls.owned).toEqual(['Hello'])
    expect(calls.resume).toEqual([])
    expect(calls.titles).toEqual([`${f}=Hello`])
    expect(calls.emitted).toBe(1)
  })

  it('refuses a recently active unowned chat with maybe-running and no spawn', async () => {
    const f = session('2026_bbb.jsonl', NOW / 1000 - 30)
    await expect(renameChat(mk(), f, 'x')).rejects.toMatchObject({ code: 'maybe-running' })
    expect(calls.resume).toEqual([])
  })

  it('short-resumes an idle chat', async () => {
    const f = session('2026_ccc.jsonl')
    expect(await renameChat(mk(), f, 'Idle')).toEqual({ title: 'Idle', via: 'resume' })
    expect(calls.resume).toEqual(['Idle'])
    expect(calls.invalidated).toEqual([f])
  })

  it('refuses a file outside the sessions dir', async () => {
    const outside = path.join(os.tmpdir(), `evaos-outside-${process.pid}.jsonl`)
    fs.writeFileSync(outside, '{}\n')
    try {
      await expect(renameChat(mk(), outside, 'x')).rejects.toMatchObject({
        code: 'outside-sessions-dir',
      })
      expect(() => deleteChat(mk(), outside)).toThrowError(/outside/)
      expect(fs.existsSync(outside)).toBe(true)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('delete refuses owned and recently active chats', () => {
    const f = session('2026_ddd.jsonl')
    expect(() => deleteChat(mk('pane'), f)).toThrowError(/Close this chat/)
    const g = session('2026_eee.jsonl', NOW / 1000 - 10)
    expect(() => deleteChat(mk(), g)).toThrowError(/Close this chat/)
    expect(fs.existsSync(f) && fs.existsSync(g)).toBe(true)
  })

  it('delete removes the chat, its pin and its archive mark', () => {
    const f = session('2026_fff.jsonl')
    fs.writeFileSync(path.join(agent, 'session-pins.json'), '["fff","keep"]')
    saveArchived(config, 'fff', true)
    expect(deleteChat(mk(), f)).toEqual({ deleted: true })
    expect(fs.existsSync(f)).toBe(false)
    expect(readPinsFile()).toEqual(['keep'])
    expect(read().archived_chats).toEqual([])
    expect(calls.emitted).toBe(1)
  })

  it('pin keeps other ids and unpin removes one', () => {
    fs.writeFileSync(path.join(agent, 'session-pins.json'), '["b"]')
    expect(savePin(agent, 'a', true)).toEqual({ pins: ['a', 'b'] })
    expect(savePin(agent, 'b', false)).toEqual({ pins: ['a'] })
    expect(readPinsFile()).toEqual(['a'])
  })

  it('archive preserves other chat.json keys and sorts', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ harness: 'claude' }))
    saveArchived(config, 'z', true)
    expect(saveArchived(config, 'a', true)).toEqual({ archived: ['a', 'z'] })
    expect(read()).toMatchObject({ harness: 'claude', archived_chats: ['a', 'z'] })
    expect(saveArchived(config, 'a', false)).toEqual({ archived: ['z'] })
  })

  it('serialises archive writes through the queue', async () => {
    const q = createWriteQueue()
    await Promise.all(['c', 'a', 'b'].map((id) => q.enqueue(() => saveArchived(config, id, true))))
    expect(read().archived_chats).toEqual(['a', 'b', 'c'])
  })

  const readPinsFile = (): string[] =>
    JSON.parse(fs.readFileSync(path.join(agent, 'session-pins.json'), 'utf8')) as string[]
})
