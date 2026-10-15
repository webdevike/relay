import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, '../../../fixtures/fake-omp/fake-omp.mjs')
const REC = join(here, '../../../fixtures/fake-omp/recordings')

type F = Record<string, any> & { type: string }

class Harness {
  child: ChildProcessWithoutNullStreams
  frames: F[] = []
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private carry = ''
  private waiters: Array<() => void> = []
  constructor(env: Record<string, string>, resume: string) {
    this.child = spawn(process.execPath, [FAKE, '--mode', 'rpc-ui', '--resume', resume], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (d: string) => {
      this.carry += d
      let i
      while ((i = this.carry.indexOf('\n')) >= 0) {
        const line = this.carry.slice(0, i)
        this.carry = this.carry.slice(i + 1)
        if (line.trim()) this.frames.push(JSON.parse(line))
      }
      this.waiters.splice(0).forEach((w) => w())
    })
    this.exit = new Promise((res) => this.child.on('exit', (code, signal) => res({ code, signal })))
  }
  send(o: object) {
    this.child.stdin.write(JSON.stringify(o) + '\n')
  }
  async until(pred: (frames: F[]) => boolean, ms = 8000) {
    const deadline = Date.now() + ms
    while (!pred(this.frames)) {
      if (Date.now() > deadline)
        throw new Error('timeout; frames: ' + this.frames.map((f) => f.type).join(','))
      await new Promise<void>((res) => {
        this.waiters.push(res)
        setTimeout(res, 50)
      })
    }
  }
}

const live: Harness[] = []
afterEach(() => {
  for (const h of live.splice(0)) h.child.stdin.end()
})
const start = (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-omp-test-'))
  const resume = join(dir, 'session.jsonl')
  writeFileSync(resume, '{"type":"session"}\n')
  const h = new Harness(
    { FAKE_OMP_DELAY_MS: '1', FAKE_OMP_LOG: join(dir, 'life.log'), ...env },
    resume,
  )
  live.push(h)
  return { h, dir, resume, logPath: join(dir, 'life.log') }
}

describe('fake omp contract', () => {
  it('emits ready first and answers set_ask_dialog and get_state', async () => {
    const { h, resume } = start()
    h.send({ type: 'set_ask_dialog', enabled: true, id: 'a' })
    h.send({ type: 'get_state', id: 'b' })
    await h.until((f) => f.some((x) => x.id === 'b'))
    expect(h.frames[0]).toMatchObject({
      type: 'ready',
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
    })
    expect(h.frames.find((x) => x.id === 'b')?.data.sessionFile).toBe(resume)
    expect(h.frames.find((x) => x.id === 'a')).toMatchObject({
      type: 'response',
      command: 'set_ask_dialog',
      success: true,
    })
  })

  it('replays a prompt in recorded frame order ending in session_settled', async () => {
    const { h } = start()
    h.send({ type: 'prompt', id: 'p1', message: 'hello', streamingBehavior: 'steer' })
    await h.until((f) => f.some((x) => x.type === 'session_settled'))
    const recorded = readFileSync(join(REC, 'turn.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).frame.type)
    const got = h.frames
      .slice(h.frames.findIndex((x) => x.type === 'agent_start'))
      .map((x) => x.type)
    expect(got).toEqual(recorded)
    const pr = h.frames.find((x) => x.type === 'prompt_result')
    expect(pr).toMatchObject({ id: 'p1', status: 'completed' })
    const user = h.frames.find((x) => x.type === 'message_end' && x.message.role === 'user')
    expect(user?.message.content[0].text).toBe('hello')
    expect(user?.messageId).toBe('msg-1')
    const assistantIds = new Set(
      h.frames
        .filter((x) => x.type.startsWith('message_') && x.message?.role === 'assistant')
        .map((x) => x.messageId),
    )
    expect([...assistantIds]).toEqual(['msg-2'])
  })

  it('abort mid-replay yields prompt_result aborted', async () => {
    const { h } = start({ FAKE_OMP_RECORDING: 'long-turn', FAKE_OMP_DELAY_MS: '5' })
    h.send({ type: 'prompt', id: 'p1', message: 'go' })
    await h.until((f) => f.filter((x) => x.type === 'message_update').length >= 3)
    h.send({ type: 'abort', id: 'ab' })
    await h.until((f) => f.some((x) => x.type === 'session_settled'))
    expect(h.frames.find((x) => x.type === 'prompt_result')).toMatchObject({
      id: 'p1',
      status: 'aborted',
    })
    expect(h.frames.find((x) => x.type === 'response' && x.command === 'abort')).toMatchObject({
      id: 'ab',
      success: true,
    })
    const endMsg = h.frames
      .filter((x) => x.type === 'message_end' && x.message.role === 'assistant')
      .at(-1)
    expect(endMsg?.message.stopReason).toBe('aborted')
    expect(h.frames.filter((x) => x.type === 'message_update').length).toBeLessThan(400)
  })

  it('queues a steer prompt with queue_update, then echoes it after the current turn', async () => {
    const { h } = start({ FAKE_OMP_DELAY_MS: '3' })
    h.send({ type: 'prompt', id: 'p1', message: 'first' })
    await h.until((f) => f.some((x) => x.type === 'message_update'))
    h.send({ type: 'prompt', id: 'p2', message: 'steer me', streamingBehavior: 'steer' })
    await h.until((f) => f.filter((x) => x.type === 'session_settled').length >= 2)
    const qi = h.frames.findIndex(
      (x) => x.type === 'queue_update' && x.steering?.[0] === 'steer me',
    )
    expect(qi).toBeGreaterThan(-1)
    const echo = h.frames.findIndex(
      (x, i) =>
        i > qi &&
        x.type === 'message_end' &&
        x.message.role === 'user' &&
        x.message.content[0].text === 'steer me',
    )
    expect(echo).toBeGreaterThan(qi)
    const firstSettled = h.frames.findIndex((x) => x.type === 'session_settled')
    expect(echo).toBeGreaterThan(firstSettled)
  })

  it('closing stdin exits 0 without a signal and never touches the resume file', async () => {
    const { h, resume, logPath } = start()
    const before = statSync(resume)
    h.send({ type: 'get_state', id: 'x' })
    await h.until((f) => f.some((x) => x.id === 'x'))
    h.child.stdin.end()
    const r = await h.exit
    expect(r).toEqual({ code: 0, signal: null })
    const events = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).event)
    expect(events.indexOf('stdin-end')).toBeGreaterThan(-1)
    expect(events.indexOf('exit')).toBeGreaterThan(events.indexOf('stdin-end'))
    expect(events).not.toContain('signal')
    const after = statSync(resume)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })

  it('answers unknown commands with success false', async () => {
    const { h } = start()
    h.send({ type: 'frobnicate', id: 'u' })
    await h.until((f) => f.some((x) => x.id === 'u'))
    expect(h.frames.find((x) => x.id === 'u')).toMatchObject({
      success: false,
      error: 'Unknown command: frobnicate',
    })
  })
})
