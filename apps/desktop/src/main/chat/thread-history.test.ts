import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadHistory } from './thread-history'

const j = (o: unknown): string => JSON.stringify(o)

let dir: string
let relay: string
let sessions: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-history-'))
  relay = path.join(dir, 'relay')
  sessions = path.join(dir, 'sessions')
  fs.mkdirSync(path.join(relay, 'assistants'), { recursive: true })
  fs.mkdirSync(sessions)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A session file of user turns `texts` (ids `<name>-<n>`); answers its path. */
function session(name: string, texts: string[]): string {
  const file = path.join(sessions, `${name}.jsonl`)
  const lines = [j({ type: 'session', id: name, cwd: '/x' })]
  texts.forEach((text, i) =>
    lines.push(
      j({
        type: 'message',
        id: `${name}-${String(i)}`,
        parentId: i === 0 ? null : `${name}-${String(i - 1)}`,
        message: { role: 'user', content: text, attribution: 'user' },
      }),
    ),
  )
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function record(id: string, history: string[], sessionFile: string): void {
  fs.writeFileSync(path.join(relay, 'assistants', `${id}.json`), j({ history, sessionFile }))
}

const texts = (thread: ThreadHistory, file: string): string[] =>
  thread.read(file).messages.map((m) => m.text)

describe('ThreadHistory', () => {
  it("shows an assistant's earlier contexts, oldest first, above its live session", () => {
    const monday = session('monday', ['m1', 'm2'])
    const tuesday = session('tuesday', ['t1'])
    const live = session('live', ['now'])
    record('nova', [monday, tuesday], live)
    // The open asks beside the record are no thread.
    fs.writeFileSync(path.join(relay, 'assistants', 'nova.asks.json'), j({ asks: [] }))
    const thread = new ThreadHistory(relay)
    expect(texts(thread, live)).toEqual(['m1', 'm2', 't1', 'now'])
    // Any other chat, an earlier context opened on its own, or no host on this Mac: just the file.
    const other = session('other', ['hello'])
    expect(texts(thread, other)).toEqual(['hello'])
    expect(texts(thread, tuesday)).toEqual(['t1'])
    expect(texts(new ThreadHistory(null), live)).toEqual(['now'])
  })

  it('skips a context whose file is gone and the live file listed in history', () => {
    const gone = path.join(sessions, 'gone.jsonl')
    const before = session('before', ['b'])
    const live = session('live', ['now'])
    record('astra', [gone, before, live], live)
    expect(texts(new ThreadHistory(relay), live)).toEqual(['b', 'now'])
  })

  it('takes whole contexts, newest first, up to the row budget; the newest always shows', () => {
    const one = session('one', ['1a', '1b'])
    const two = session('two', ['2a', '2b'])
    const three = session('three', ['3a', '3b', '3c'])
    const live = session('live', ['now'])
    record('nova', [one, two, three], live)
    expect(texts(new ThreadHistory(relay, 5), live)).toEqual(['2a', '2b', '3a', '3b', '3c', 'now'])
    expect(texts(new ThreadHistory(relay, 1), live)).toEqual(['3a', '3b', '3c', 'now'])
  })

  it('answers the same earlier rows while the contexts are unchanged, and rereads a changed one', () => {
    const before = session('before', ['b'])
    const live = session('live', ['now'])
    record('nova', [before], live)
    const thread = new ThreadHistory(relay)
    const first = thread.earlier(live)
    expect(thread.earlier(live)).toBe(first)
    session('live', ['now', 'next'])
    expect(thread.earlier(live)).toBe(first)
    session('before', ['b', 'b2 written later'])
    expect(thread.earlier(live).map((m) => m.text)).toEqual(['b', 'b2 written later'])
  })

  it('follows a rollover: the new live session carries the old one', () => {
    const before = session('before', ['b'])
    const old = session('old', ['o'])
    record('nova', [before], old)
    const thread = new ThreadHistory(relay)
    expect(texts(thread, old)).toEqual(['b', 'o'])
    const fresh = session('fresh', ['f'])
    record('nova', [before, old], fresh)
    expect(texts(thread, fresh)).toEqual(['b', 'o', 'f'])
    expect(texts(thread, old)).toEqual(['o'])
  })

  it('keeps the live row when an earlier one has its id', () => {
    const before = session('same', ['earlier'])
    const live = path.join(sessions, 'live.jsonl')
    fs.writeFileSync(
      live,
      [
        j({ type: 'session', id: 'live', cwd: '/x' }),
        j({
          type: 'message',
          id: 'same-0',
          parentId: null,
          message: { role: 'user', content: 'live', attribution: 'user' },
        }),
      ].join('\n'),
    )
    record('nova', [before], live)
    expect(texts(new ThreadHistory(relay), live)).toEqual(['live'])
  })
})
