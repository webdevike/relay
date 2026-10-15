import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfigStore } from '../config-store'
import { ChatListService, LIST_ERROR, type FileSample } from './chat-list'

const dirs: string[] = []
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlist-'))
  dirs.push(root)
  const sessionsDir = path.join(root, 'agent/sessions/-x')
  const configDir = path.join(root, 'config')
  fs.mkdirSync(sessionsDir, { recursive: true })
  const config = createConfigStore(configDir)
  const agentDir = path.join(root, 'agent')
  return { root, sessionsDir, agentDir, config, configDir }
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

  it('a repeat list reads no unchanged file, and a changed file is read again', () => {
    const s = setup()
    const a = session(s.sessionsDir, 'a', [{ type: 'title', title: 'A' }])
    session(s.sessionsDir, 'b', [{ type: 'title', title: 'B' }])
    const readFile = vi.fn((file: string): FileSample => {
      const text = fs.readFileSync(file, 'utf8')
      return { head: text, tail: text, full: () => text }
    })
    const svc = new ChatListService({ ...s, now: () => NOW, readFile })
    svc.list()
    expect(readFile).toHaveBeenCalledTimes(2)
    svc.list()
    expect(readFile).toHaveBeenCalledTimes(2)
    fs.appendFileSync(a, rec({ type: 'title', title: 'A2' }) + '\n')
    const rows = svc.list().rows
    expect(readFile).toHaveBeenCalledTimes(3)
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
    })
    fs.writeFileSync(
      path.join(s.configDir, 'chat.json'),
      JSON.stringify({
        archived_chats: ['a', 3],
        chat_categories: ['Mine', 1],
        chat_group_order: ['Mine'],
        chat_assignments: { a: 'Mine', b: 9 },
        collapsed_groups: ['Other', null],
      }),
    )
    const out = svc.list()
    expect(out.rows[0].archived).toBe(true)
    expect(out.prefs).toEqual({
      chat_categories: ['Mine'],
      chat_group_order: ['Mine'],
      chat_assignments: { a: 'Mine' },
      collapsed_groups: ['Other'],
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
      sessionsDir: path.join(s.root, 'missing'),
      now: () => NOW,
    })
    const out = svc.list()
    expect(out.rows).toEqual([])
    expect(out.error).toBe(LIST_ERROR)
  })
})
