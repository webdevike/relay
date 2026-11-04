import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createTerminalService,
  FLUSH_MS,
  MAX_TERMINALS,
  terminalEnv,
  type PtyLike,
  type PtySpawn,
} from './terminal-service'

class FakePty implements PtyLike {
  data: Array<(d: string) => void> = []
  exit: Array<(e: { exitCode: number }) => void> = []
  written: string[] = []
  size: [number, number] | null = null
  killed = false
  onData(cb: (d: string) => void) {
    this.data.push(cb)
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit.push(cb)
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.size = [c, r]
  }
  kill() {
    this.killed = true
    for (const cb of this.exit) cb({ exitCode: 0 })
  }
}

function setup(over: { herdrBin?: string | null; pane?: string | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-'))
  const work = path.join(root, 'work')
  fs.mkdirSync(work)
  const ptys: FakePty[] = []
  const spawned: PtySpawn[] = []
  const timers: Array<() => void> = []
  const events: string[] = []
  const svc = createTerminalService({
    evaRoot: root,
    homedir: os.homedir(),
    shell: '/bin/zsh',
    herdrBin: over.herdrBin === undefined ? '/bin/herdr' : over.herdrBin,
    placeOf: (file) => (file === '/chat.jsonl' ? ({ active: work, cwd: root } as never) : null),
    env: async () => ({ PATH: '/bin', HERDR_ENV: '1', ELECTRON_RUN_AS_NODE: '1' }),
    paneOf: async () => (over.pane === undefined ? 'w1:p1' : over.pane),
    spawn: (p) => {
      spawned.push(p)
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    },
    emitData: (id, d) => events.push(`data:${id}:${d}`),
    emitExit: (id, code) => events.push(`exit:${id}:${code}`),
    setTimer: (fn) => timers.push(fn),
  })
  return { svc, ptys, spawned, timers, events, root, work }
}

describe('terminal service', () => {
  it('starts the login shell in the chat worktree', async () => {
    const t = setup()
    const r = await t.svc.spawn({ file: '/chat.jsonl', mode: 'shell', cols: 100, rows: 30 })
    expect(r).toMatchObject({ id: 't1', cwd: t.work, title: 'zsh' })
    expect(t.spawned[0]).toMatchObject({ file: '/bin/zsh', argv: ['-l'], cwd: t.work, cols: 100 })
  })

  it('falls back to the Eva root without a chat or when the chat folder is gone', async () => {
    const t = setup()
    const a = await t.svc.spawn({ file: null, mode: 'shell', cols: 80, rows: 24 })
    expect(a.cwd).toBe(t.root)
    fs.rmSync(t.work, { recursive: true })
    const b = await t.svc.spawn({ file: '/chat.jsonl', mode: 'shell', cols: 80, rows: 24 })
    expect(b.cwd).toBe(t.root)
  })

  it('gives programs a terminal environment without electron or herdr pane markers', () => {
    const env = terminalEnv({
      PATH: '/x',
      ELECTRON_RUN_AS_NODE: '1',
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'p',
    })
    expect(env).toMatchObject({ PATH: '/x', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect(env['HERDR_ENV']).toBeUndefined()
    expect(env['HERDR_PANE_ID']).toBeUndefined()
  })

  it('batches output and flushes the rest on exit', async () => {
    const t = setup()
    const { id } = await t.svc.spawn({ file: null, mode: 'shell', cols: 80, rows: 24 })
    t.ptys[0]!.data[0]!('a')
    t.ptys[0]!.data[0]!('b')
    expect(t.events).toEqual([])
    expect(t.timers).toHaveLength(1)
    t.timers[0]!()
    expect(t.events).toEqual([`data:${id}:ab`])
    t.ptys[0]!.data[0]!('c')
    t.ptys[0]!.exit[0]!({ exitCode: 3 })
    expect(t.events.slice(1)).toEqual([`data:${id}:c`, `exit:${id}:3`])
    expect(t.svc.size()).toBe(0)
    expect(FLUSH_MS).toBeGreaterThan(0)
  })

  it('writes and resizes a live pty, and fails for one that ended', async () => {
    const t = setup()
    const { id } = await t.svc.spawn({ file: null, mode: 'shell', cols: 80, rows: 24 })
    t.svc.write(id, 'ls\r')
    t.svc.resize(id, 120, 40)
    expect(t.ptys[0]!.written).toEqual(['ls\r'])
    expect(t.ptys[0]!.size).toEqual([120, 40])
    t.svc.kill(id)
    expect(t.ptys[0]!.killed).toBe(true)
    expect(() => t.svc.write(id, 'x')).toThrow('ended')
    expect(() => t.svc.kill(id)).not.toThrow()
  })

  it('shows a harness pane view-only: attached without takeover, and every keystroke is dropped', async () => {
    const t = setup({ pane: null })
    const { id } = await t.svc.spawn({ file: null, mode: 'attach', cols: 80, rows: 24, watch: 'w1:p3' })
    expect(t.spawned[0]).toMatchObject({ file: '/bin/herdr', argv: ['agent', 'attach', 'w1:p3'] })
    t.svc.write(id, 'rm -rf /\r')
    expect(t.ptys[0]!.written).toEqual([])
    // Resizing still follows the panel, and a bare herdr is still refused.
    t.svc.resize(id, 100, 30)
    expect(t.ptys[0]!.size).toEqual([100, 30])
    const bare = setup({ herdrBin: null })
    await expect(
      bare.svc.spawn({ file: null, mode: 'attach', cols: 80, rows: 24, watch: 'w1:p3' }),
    ).rejects.toMatchObject({ code: 'no-herdr' })
  })

  it('attaches to the chat session through herdr, or says why not', async () => {
    const t = setup()
    const r = await t.svc.spawn({ file: '/chat.jsonl', mode: 'attach', cols: 80, rows: 24 })
    expect(r.title).toBe('herdr')
    expect(t.spawned[0]).toMatchObject({
      file: '/bin/herdr',
      argv: ['agent', 'attach', 'w1:p1', '--takeover'],
    })
    const none = setup({ pane: null })
    await expect(
      none.svc.spawn({ file: '/chat.jsonl', mode: 'attach', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'not-in-herdr' })
    const bare = setup({ herdrBin: null })
    await expect(
      bare.svc.spawn({ file: '/chat.jsonl', mode: 'attach', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'no-herdr' })
    expect(await bare.svc.attachable('/chat.jsonl')).toBeNull()
    expect(await t.svc.attachable(null)).toBeNull()
    expect(await t.svc.attachable('/chat.jsonl')).toBe('w1:p1')
  })

  it('caps open terminals and ends them all on close', async () => {
    const t = setup()
    for (let i = 0; i < MAX_TERMINALS; i++) {
      await t.svc.spawn({ file: null, mode: 'shell', cols: 80, rows: 24 })
    }
    await expect(
      t.svc.spawn({ file: null, mode: 'shell', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'too-many' })
    t.svc.close()
    expect(t.ptys.every((p) => p.killed)).toBe(true)
    expect(t.svc.size()).toBe(0)
  })
})
