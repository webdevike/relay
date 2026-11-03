import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfigStore } from '../config-store'
import type { RelaySession, RelayStatus } from '../relay/feed'
import { ChatListService, LIST_ERROR } from './chat-list'
import { readFrom } from './session-scan'

const dirs: string[] = []
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlist-'))
  dirs.push(root)
  const sessionsDir = path.join(root, 'agent/sessions/-x')
  const configDir = path.join(root, 'config')
  fs.mkdirSync(sessionsDir, { recursive: true })
  const config = createConfigStore(configDir)
  const agentDir = path.join(root, 'agent')
  return {
    root,
    sessionsDir,
    sessionsDirs: [sessionsDir],
    agentDir,
    evaRoot: root,
    config,
    configDir,
  }
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const NOW = 10_000_000_000
const rec = (o: unknown): string => JSON.stringify(o)
function session(dir: string, id: string, lines: unknown[], ageMs = 3_600_000 * 5): string {
  const file = path.join(dir, `2026-10-05T10-00-00-000Z_${id}.jsonl`)
  fs.writeFileSync(file, lines.map(rec).join('\n') + '\n')
  const t = (NOW - ageMs) / 1000
  fs.utimesSync(file, t, t)
  return file
}
const user = (text: string | null, images = 0) => ({
  type: 'message',
  id: 'u1',
  parentId: null,
  message: {
    role: 'user',
    content: [
      ...(text === null ? [] : [{ type: 'text', text }]),
      ...Array.from({ length: images }, () => ({
        type: 'image',
        mimeType: 'image/png',
        data: 'AAAA',
      })),
    ],
  },
})

describe('ChatListService', () => {
  it('lists every session with no 50 cap, newest first', () => {
    const s = setup()
    for (let i = 0; i < 60; i++) {
      session(s.sessionsDir, `id${i}`, [{ type: 'title', title: `T${i}` }], 1_000_000 * (i + 1))
    }
    const svc = new ChatListService({ ...s, now: () => NOW })
    const out = svc.list()
    expect(out.error).toBeNull()
    expect(out.rows).toHaveLength(60)
    expect(out.rows[0].title).toBe('T0')
    expect(out.rows[59].title).toBe('T59')
    expect(out.rows[0].id).toBe('id0')
  })

  it('titles: header, then first prompt one-lined to 80, then Image', () => {
    const s = setup()
    session(s.sessionsDir, 'h', [{ type: 'title', title: 'Header title' }])
    session(s.sessionsDir, 'sess', [{ type: 'session', id: 'sess', title: 'Session title' }])
    session(s.sessionsDir, 'p', [{ type: 'session', id: 'p' }, user('a\n\n' + 'word '.repeat(40))])
    session(s.sessionsDir, 'img', [{ type: 'session', id: 'img' }, user(null, 1)])
    const rows = new ChatListService({ ...s, now: () => NOW }).list().rows
    const by = Object.fromEntries(rows.map((r) => [r.id, r.title]))
    expect(by.h).toBe('Header title')
    expect(by.sess).toBe('Session title')
    expect(by.p.length).toBeLessThanOrEqual(80)
    expect(by.p.startsWith('a word word')).toBe(true)
    expect(by.img).toBe('Image')
  })

  it('a title record appended at the end of a large file wins over the header', () => {
    const s = setup()
    const filler = Array.from({ length: 2000 }, (_, i) => ({
      type: 'message',
      id: `m${i}`,
      parentId: i === 0 ? null : `m${i - 1}`,
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(80) }] },
    }))
    session(s.sessionsDir, 'r', [
      { type: 'title', title: 'Old name' },
      { type: 'session', id: 'r' },
      ...filler,
      { type: 'title', title: 'Renamed' },
    ])
    expect(
      fs.statSync(path.join(s.sessionsDir, fs.readdirSync(s.sessionsDir)[0])).size,
    ).toBeGreaterThan(64 * 1024)
    const rows = new ChatListService({ ...s, now: () => NOW }).list().rows
    expect(rows[0].title).toBe('Renamed')
  })

  it('setTitle shows a title until the file changes', () => {
    const s = setup()
    const a = session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
    const svc = new ChatListService({ ...s, now: () => NOW })
    svc.list()
    svc.setTitle(a, 'Override')
    expect(svc.list().rows[0].title).toBe('Override')
    fs.appendFileSync(a, rec({ type: 'title', title: 'From file' }) + '\n')
    expect(svc.list().rows[0].title).toBe('From file')
  })

  it('a repeat list reads no unchanged file, and a changed file is read again', () => {
    const s = setup()
    const a = session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
    session(s.sessionsDir, 'b', [{ type: 'title', title: 'B' }])
    const reads: Array<[string, number]> = []
    const spy = vi.fn((file: string, from: number, length: number) => {
      reads.push([path.basename(file), from])
      return readFrom(file, from, length)
    })
    const svc = new ChatListService({ ...s, now: () => NOW, readFrom: spy })
    svc.list()
    expect(spy).toHaveBeenCalledTimes(2)
    svc.list()
    expect(spy).toHaveBeenCalledTimes(2)
    const before = fs.statSync(a).size
    fs.appendFileSync(a, rec({ type: 'title', title: 'A2' }) + '\n')
    const rows = svc.list().rows
    // The header again (omp rewrites its title in place), then only the appended bytes.
    expect(reads.slice(2)).toEqual([
      [path.basename(a), 0],
      [path.basename(a), before],
    ])
    expect(rows.find((r) => r.id === 'a')?.title).toBe('A2')
  })

  it('pins come from session-pins.json; a missing or invalid file reads as empty', () => {
    const s = setup()
    session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
    session(s.sessionsDir, 'b', [{ type: 'title', title: 'B' }])
    const svc = new ChatListService({ ...s, now: () => NOW })
    expect(svc.list().rows.some((r) => r.pinned)).toBe(false)
    fs.writeFileSync(path.join(s.agentDir, 'session-pins.json'), '{not json')
    expect(svc.list().rows.some((r) => r.pinned)).toBe(false)
    fs.writeFileSync(path.join(s.agentDir, 'session-pins.json'), JSON.stringify(['b', 7]))
    expect(
      svc
        .list()
        .rows.filter((r) => r.pinned)
        .map((r) => r.id),
    ).toEqual(['b'])
  })

  it('archived and prefs come from chat.json with defaults and dropped non-strings', () => {
    const s = setup()
    session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
    const svc = new ChatListService({ ...s, now: () => NOW })
    expect(svc.list().prefs).toEqual({
      chat_categories: [],
      chat_group_order: [],
      chat_assignments: {},
      collapsed_groups: [],
      chat_agent: 'Eva',
    })
    fs.writeFileSync(
      path.join(s.configDir, 'chat.json'),
      JSON.stringify({
        archived_chats: ['a', 3],
        chat_categories: ['Mine', 1],
        chat_group_order: ['Mine'],
        chat_assignments: {
          a: 'Mine',
          b: 9,
          'bad id/x': 'Mine',
          long: 'x'.repeat(121),
        },
        collapsed_groups: ['Other', null],
        chat_agent: 'Elysia',
      }),
    )
    const out = svc.list()
    expect(out.rows[0].archived).toBe(true)
    expect(out.prefs).toEqual({
      chat_categories: ['Mine'],
      chat_group_order: ['Mine'],
      chat_assignments: { a: 'Mine' },
      collapsed_groups: ['Other'],
      chat_agent: 'Elysia',
    })
  })

  it('running means live in this app or written within ten minutes', () => {
    const s = setup()
    const live = session(s.sessionsDir, 'live', [{ type: 'title', title: 'L' }])
    session(s.sessionsDir, 'fresh', [{ type: 'title', title: 'F' }], 60_000)
    session(s.sessionsDir, 'old', [{ type: 'title', title: 'O' }])
    const svc = new ChatListService({ ...s, now: () => NOW, liveFiles: () => new Set([live]) })
    const run = Object.fromEntries(svc.list().rows.map((r) => [r.id, r.running]))
    expect(run).toEqual({ live: true, fresh: true, old: false })
  })

  it('lists only .jsonl files directly in the sessions dir', () => {
    const s = setup()
    session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
    fs.mkdirSync(path.join(s.sessionsDir, '2026-10-05T10-00-00-000Z_a'))
    fs.writeFileSync(path.join(s.sessionsDir, '2026-10-05T10-00-00-000Z_a', 'sub.jsonl'), '{}\n')
    fs.writeFileSync(path.join(s.sessionsDir, 'notes.txt'), 'x')
    expect(new ChatListService({ ...s, now: () => NOW }).list().rows).toHaveLength(1)
  })

  it('an unreadable sessions dir gives no rows and the list error', () => {
    const s = setup()
    const svc = new ChatListService({
      ...s,
      sessionsDirs: [path.join(s.root, 'missing')],
      now: () => NOW,
    })
    const out = svc.list()
    expect(out.rows).toEqual([])
    expect(out.error).toBe(LIST_ERROR)
  })

  describe('live status', () => {
    const bgCall = (id: string) => ({
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'bash',
        content: [{ type: 'text', text: `Started ${id}` }],
        details: { async: { state: 'running', jobId: id, type: 'bash' } },
      },
    })

    it('maps working, dialog and open through rowStatus', () => {
      const s = setup()
      const a = session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
      const b = session(s.sessionsDir, 'b', [{ type: 'title', title: 'B' }])
      const c = session(s.sessionsDir, 'c', [{ type: 'title', title: 'C' }])
      session(s.sessionsDir, 'd', [{ type: 'title', title: 'D' }])
      const live: Record<string, { working: boolean; dialog: 'confirm' | 'other' | null }> = {
        [a]: { working: true, dialog: null },
        [b]: { working: false, dialog: 'confirm' },
        [c]: { working: false, dialog: null },
      }
      const svc = new ChatListService({ ...s, now: () => NOW, liveStatus: (f) => live[f] ?? null })
      const by = Object.fromEntries(svc.list().rows.map((r) => [r.title, r.status]))
      expect(by).toEqual({ A: 'working', B: 'needs-approval', C: 'open', D: null })
    })

    it('shows job for an unowned file with an unfinished background job, parsed once per mtime+size', () => {
      const s = setup()
      session(s.sessionsDir, 'j', [{ type: 'title', title: 'J' }, bgCall('bg_1')])
      let reads = 0
      const svc = new ChatListService({
        ...s,
        now: () => NOW,
        readFrom: (f, from, length) => {
          reads++
          return readFrom(f, from, length)
        },
      })
      expect(svc.list().rows[0].status).toBe('job')
      expect(svc.list().rows[0].status).toBe('job')
      expect(reads).toBe(1)
    })
  })
})

describe('ChatListService rows like native', () => {
  const said = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'message',
    message: { role, content, ...extra },
  })
  const call = (args: unknown, extra: Record<string, unknown> = {}) =>
    said('assistant', [{ type: 'toolCall', id: 't', name: 'read', arguments: args }], {
      stopReason: 'toolUse',
      ...extra,
    })

  it('spans every sessions dir, one row per session id (the newest copy), erroring only when none is readable', () => {
    const s = setup()
    const other = path.join(s.root, 'profile/sessions/-x')
    fs.mkdirSync(other, { recursive: true })
    session(s.sessionsDir, 'a', [{ type: 'title', title: 'A old' }], 3_600_000 * 9)
    session(other, 'a', [{ type: 'title', title: 'A new' }], 3_600_000 * 2)
    session(other, 'b', [{ type: 'title', title: 'B' }])
    const dirs = [path.join(s.root, 'missing'), s.sessionsDir, other]
    const out = new ChatListService({ ...s, sessionsDirs: dirs, now: () => NOW }).list()
    expect(out.error).toBeNull()
    expect(out.rows.map((r) => [r.id, r.title])).toEqual([
      ['a', 'A new'],
      ['b', 'B'],
    ])
  })

  it('leaves out a chat with no title and no prompt yet unless this app runs it', () => {
    const s = setup()
    const draft = session(s.sessionsDir, 'draft', [{ type: 'session', id: 'draft', cwd: '/e' }])
    session(s.sessionsDir, 'empty', [{ type: 'session', id: 'empty', cwd: '/e' }])
    const rows = new ChatListService({
      ...s,
      now: () => NOW,
      liveFiles: () => new Set([draft]),
    }).list().rows
    expect(rows.map((r) => [r.id, r.title])).toEqual([['draft', 'draft']])
  })

  it('classifies the agent, where the chat worked, its model and a failed last reply', () => {
    const s = setup()
    session(s.sessionsDir, 'eren', [
      { type: 'session', id: 'eren', cwd: s.root },
      { type: 'model_change', model: 'anthropic/claude-sonnet-4-6' },
      said('user', [{ type: 'text', text: "You are Eren, Eva's housekeeping assistant" }]),
      call({ path: 'work/relay/README.md' }),
      said('assistant', [{ type: 'text', text: 'apps/evaos is next' }], { stopReason: 'stop' }),
    ])
    session(s.sessionsDir, 'eva', [
      { type: 'session', id: 'eva', cwd: s.root },
      said('user', [{ type: 'text', text: 'Tidy the garage' }]),
      said('assistant', [{ type: 'text', text: 'oops' }], {
        provider: 'openai-codex',
        model: 'gpt-6.1-sol',
        stopReason: 'error',
      }),
    ])
    const by = Object.fromEntries(
      new ChatListService({ ...s, now: () => NOW }).list().rows.map((r) => [r.id, r]),
    )
    expect([by.eren.agent, by.eren.workedIn, by.eren.model, by.eren.failed]).toEqual([
      'Eren',
      'Relay',
      'anthropic/claude-sonnet-4-6',
      false,
    ])
    expect([by.eva.agent, by.eva.workedIn, by.eva.model, by.eva.failed, by.eva.title]).toEqual([
      'Eva',
      null,
      'openai-codex/gpt-6.1-sol',
      true,
      'Tidy the garage',
    ])
  })

  it('follows appended lines: the worktree, the model and a new prompt clearing a failure', () => {
    const s = setup()
    const f = session(s.sessionsDir, 'grow', [
      { type: 'title', title: 'Grow' },
      { type: 'session', id: 'grow', cwd: s.root },
      said('assistant', [{ type: 'text', text: 'x' }], { stopReason: 'aborted' }),
    ])
    const svc = new ChatListService({ ...s, now: () => NOW })
    expect(svc.list().rows[0].failed).toBe(true)
    fs.appendFileSync(
      f,
      [
        { type: 'model_change', model: 'anthropic/claude-opus-5-5' },
        said('user', [{ type: 'text', text: 'again' }]),
      ]
        .map(rec)
        .join('\n') + '\n',
    )
    const row = svc.list().rows[0]
    expect([row.failed, row.model]).toEqual([false, 'anthropic/claude-opus-5-5'])
  })

  it('resolves the work line from work/items ledgers and .git HEADs, with no git CLI', () => {
    const s = setup()
    const root = s.root
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
    fs.mkdirSync(path.join(root, 'work/items'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'work/items/ENG-7.md'),
      '---\nkey: ENG-7\nworktree: work/wt-ENG-7\npr: https://github.com/a/b/pull/225\n---\n',
    )
    const wt = path.join(root, 'work/wt-ENG-7')
    fs.mkdirSync(path.join(root, '.git/worktrees/wt'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git/worktrees/wt/HEAD'), 'ref: refs/heads/feat/ENG-7-x\n')
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, '.git/worktrees/wt')}\n`)
    session(s.sessionsDir, 'wt', [
      { type: 'title', title: 'Plain chat' },
      { type: 'session', id: 'wt', cwd: root },
      call({ cwd: 'work/wt-ENG-7', command: 'ls' }),
    ])
    session(s.sessionsDir, 'root', [
      { type: 'title', title: 'Plain at the root' },
      { type: 'session', id: 'root', cwd: root },
    ])
    session(s.sessionsDir, 'key', [
      { type: 'title', title: 'Check ENG-7 status' },
      { type: 'session', id: 'key', cwd: root },
    ])
    const by = Object.fromEntries(
      new ChatListService({ ...s, now: () => NOW }).list().rows.map((r) => [r.id, r.work]),
    )
    expect(by.wt).toEqual({ key: 'ENG-7', branch: 'feat/ENG-7-x', pr: 225 })
    // The Eva checkout on main says nothing; a ticket key in the title finds its ledger.
    expect(by.root).toBeNull()
    expect(by.key).toEqual({ key: 'ENG-7', branch: null, pr: 225 })
  })

  describe('order', () => {
    it('returns at the file time first, then on finishing a run, with the run start while working', () => {
      const s = setup()
      const a = session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
      const mtime = fs.statSync(a).mtimeMs
      let now = NOW
      let state: { working: boolean; dialog: 'confirm' | 'other' | null } | null = null
      const svc = new ChatListService({ ...s, now: () => now, liveStatus: () => state })
      expect(svc.list().rows[0]).toMatchObject({
        returnedMs: mtime,
        startedMs: null,
        openedMs: null,
      })
      state = { working: false, dialog: null }
      svc.list()
      state = { working: true, dialog: null }
      now = NOW + 1000
      expect(svc.list().rows[0]).toMatchObject({
        status: 'working',
        startedMs: NOW + 1000,
        returnedMs: mtime,
      })
      state = { working: false, dialog: null }
      now = NOW + 5000
      expect(svc.list().rows[0]).toMatchObject({ startedMs: null, returnedMs: NOW + 5000 })
      expect(svc.markRead('a')).toBe(true)
      expect(svc.list().rows[0].openedMs).toBe(NOW + 5000)
      const doc = s.config.readJson<Record<string, Record<string, number>>>('chat-order.json', {})
      expect(doc.returned.a).toBe(NOW + 5000)
      expect(doc.opened.a).toBe(NOW + 5000)
    })

    it('an unowned chat written in the last ten minutes with an open turn is working', () => {
      const s = setup()
      session(
        s.sessionsDir,
        'term',
        [
          { type: 'title', title: 'T' },
          said('user', [{ type: 'text', text: 'go' }], {}),
          call({ path: 'x' }),
        ],
        30_000,
      )
      session(
        s.sessionsDir,
        'done',
        [
          { type: 'title', title: 'D' },
          said('assistant', [{ type: 'text', text: 'ok' }], { stopReason: 'stop' }),
        ],
        30_000,
      )
      const by = Object.fromEntries(
        new ChatListService({ ...s, now: () => NOW }).list().rows.map((r) => [r.id, r]),
      )
      expect([by.term.status, by.term.startedMs]).toEqual(['working', NOW])
      expect([by.done.status, by.done.startedMs, by.done.running]).toEqual([null, null, true])
    })

    it('snoozes, refuses a chat waiting on Isaac, and records kept on unsettle', () => {
      const s = setup()
      const b = session(s.sessionsDir, 'b', [{ type: 'title', title: 'B' }])
      session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
      const svc = new ChatListService({
        ...s,
        now: () => NOW,
        liveStatus: (f) => (f === b ? { working: false, dialog: 'confirm' } : null),
      })
      svc.list()
      svc.snooze('a', NOW + 60_000)
      expect(() => svc.snooze('b', NOW + 60_000)).toThrowError(/waiting on you/)
      svc.keep('a')
      const a = svc.list().rows.find((r) => r.id === 'a')!
      expect([a.snoozedUntilMs, a.keptMs]).toEqual([NOW + 60_000, NOW])
      svc.snooze('a', null)
      expect(svc.list().rows.find((r) => r.id === 'a')!.snoozedUntilMs).toBeNull()
    })

    it('auto-settles chats idle for the days into archived_chats, never a pinned one', () => {
      const s = setup()
      const day = 24 * 3_600_000
      session(s.sessionsDir, 'old', [{ type: 'title', title: 'Old' }], 4 * day)
      session(s.sessionsDir, 'pin', [{ type: 'title', title: 'Pinned' }], 4 * day)
      session(s.sessionsDir, 'new', [{ type: 'title', title: 'New' }], day)
      fs.mkdirSync(s.agentDir, { recursive: true })
      fs.writeFileSync(path.join(s.agentDir, 'session-pins.json'), '["pin"]')
      fs.writeFileSync(path.join(s.configDir, 'chat.json'), JSON.stringify({ harness: 'omp' }))
      // Off unless configured (fixtures and e2e).
      expect(
        new ChatListService({ ...s, now: () => NOW }).list().rows.some((r) => r.archived),
      ).toBe(false)
      const rows = new ChatListService({ ...s, now: () => NOW, autoSettleDays: 3 }).list().rows
      expect(rows.filter((r) => r.archived).map((r) => r.id)).toEqual(['old'])
      expect(s.config.readJson('chat.json', {})).toEqual({
        harness: 'omp',
        archived_chats: ['old'],
      })
    })
  })

  describe('Relay', () => {
    const relaySession = (
      id: string,
      status: RelayStatus,
      extra: Partial<RelaySession> = {},
    ): RelaySession => ({
      id,
      status,
      detail: null,
      canRespond: true,
      kind: 'manual',
      title: id,
      assistant: null,
      activity: null,
      activityAt: null,
      ...extra,
    })
    const connected = (...list: RelaySession[]) => new Map(list.map((x) => [x.id, x]))
    const titled = (dir: string, id: string) =>
      session(dir, id, [{ type: 'title', title: id.toUpperCase() }])

    it('while connected, Relay alone says which chats outside this app run, and how', () => {
      const s = setup()
      // Written seconds ago with an open turn, but Relay does not list it: not running.
      session(
        s.sessionsDir,
        'term',
        [{ type: 'title', title: 'T' }, said('user', [{ type: 'text', text: 'go' }]), call({})],
        30_000,
      )
      for (const id of ['rep', 'perm', 'asked', 'asking', 'job', 'gone']) titled(s.sessionsDir, id)
      const mine = titled(s.sessionsDir, 'mine')
      const relay = connected(
        relaySession('rep', 'working', { detail: 'bash' }),
        relaySession('perm', 'needs_permission', { detail: 'bash' }),
        relaySession('asked', 'waiting'),
        relaySession('asking', 'working', { detail: 'ask' }),
        relaySession('job', 'idle', { kind: 'job' }),
        relaySession('gone', 'ended'),
        relaySession('mine', 'working'),
      )
      const svc = new ChatListService({
        ...s,
        now: () => NOW,
        relay: () => relay,
        liveStatus: (f) => (f === mine ? { working: false, dialog: null } : null),
      })
      const by = Object.fromEntries(svc.list().rows.map((r) => [r.id, r]))
      const look = (id: string) => [by[id]!.status, by[id]!.running, by[id]!.startedMs !== null]
      expect(look('term')).toEqual([null, false, false])
      expect(look('rep')).toEqual(['working', true, true])
      expect(look('perm')).toEqual(['needs-approval', true, false])
      expect(look('asked')).toEqual(['has-question', true, false])
      // omp's ask tool: the row says Working, the order sees it blocked (no run clock).
      expect(look('asking')).toEqual(['working', true, false])
      expect(look('job')).toEqual(['job', true, false])
      expect(look('gone')).toEqual([null, false, false])
      // This app's own process wins over Relay.
      expect(look('mine')).toEqual(['open', true, false])
      // Only an approval or a question refuses a snooze.
      expect(() => svc.snooze('perm', NOW + 1)).toThrowError(/waiting on you/)
      expect(() => svc.snooze('asked', NOW + 1)).toThrowError(/waiting on you/)
      svc.snooze('asking', NOW + 1)
    })

    it('falls back to the file heuristic while Relay is unreachable', () => {
      const s = setup()
      session(
        s.sessionsDir,
        'term',
        [{ type: 'title', title: 'T' }, said('user', [{ type: 'text', text: 'go' }]), call({})],
        30_000,
      )
      const svc = new ChatListService({ ...s, now: () => NOW, relay: () => null })
      expect(svc.list().rows[0]).toMatchObject({ status: 'working', running: true, startedMs: NOW })
    })

    it('hides assistant threads (Astra, Nova) from the list, even after Relay drops', () => {
      const s = setup()
      titled(s.sessionsDir, 'astra')
      titled(s.sessionsDir, 'chat')
      let relay: Map<string, RelaySession> | null = connected(
        relaySession('astra', 'idle', { kind: 'assistant', assistant: 'astra' }),
        relaySession('chat', 'working'),
      )
      const svc = new ChatListService({ ...s, now: () => NOW, relay: () => relay })
      expect(svc.list().rows.map((r) => r.id)).toEqual(['chat'])
      relay = null
      expect(svc.list().rows.map((r) => r.id)).toEqual(['chat'])
    })

    it('a chat Relay stops listing mid-run returns then, but not when Relay dropped', () => {
      const s = setup()
      const mtime = fs.statSync(titled(s.sessionsDir, 'a')).mtimeMs
      titled(s.sessionsDir, 'b')
      let now = NOW
      let relay: Map<string, RelaySession> | null = connected(
        relaySession('a', 'working'),
        relaySession('b', 'needs_permission'),
      )
      const svc = new ChatListService({ ...s, now: () => now, relay: () => relay })
      const returned = () => Object.fromEntries(svc.list().rows.map((r) => [r.id, r.returnedMs]))
      // A blocked chat first seen catches up to its file; a working one keeps it.
      expect(returned()).toEqual({ a: mtime, b: mtime })
      now = NOW + 5000
      relay = connected(relaySession('b', 'ended'))
      expect(returned()).toEqual({ a: NOW + 5000, b: NOW + 5000 })

      relay = connected(relaySession('a', 'working'))
      now = NOW + 9000
      returned()
      relay = null
      now = NOW + 20_000
      expect(returned().a).toBe(NOW + 5000)
    })
  })
})
