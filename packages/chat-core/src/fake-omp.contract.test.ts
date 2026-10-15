import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE = join(here, '../../../fixtures/fake-omp/fake-omp.mjs')
const REC = join(here, '../../../fixtures/fake-omp/recordings')

/* eslint-disable @typescript-eslint/no-explicit-any */
type F = Record<string, any> & { type: string }
/* eslint-enable @typescript-eslint/no-explicit-any */

class Harness {
  child: ChildProcessWithoutNullStreams
  frames: F[] = []
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private carry = ''
  private waiters: Array<() => void> = []
  constructor(env: Record<string, string>, args: string[]) {
    this.child = spawn(process.execPath, [FAKE, ...args], {
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
  const h = new Harness({ FAKE_OMP_DELAY_MS: '1', FAKE_OMP_LOG: join(dir, 'life.log'), ...env }, [
    '--mode',
    'rpc-ui',
    '--resume',
    resume,
  ])
  live.push(h)
  return { h, dir, resume, logPath: join(dir, 'life.log') }
}
const startRaw = (args: string[], env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-omp-test-'))
  const h = new Harness(
    { FAKE_OMP_DELAY_MS: '1', FAKE_OMP_LOG: join(dir, 'life.log'), ...env },
    args,
  )
  live.push(h)
  return { h, dir, logPath: join(dir, 'life.log') }
}
const readLog = (p: string) =>
  readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose fake-omp wire JSON in a contract test
    .map((l) => JSON.parse(l) as { event: string; detail: any })

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

  describe('phase 4 scenarios', () => {
    it('new chat plans its file and creates it on the first prompt', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fake-omp-new-'))
      const { h } = startRaw(['--mode', 'rpc-ui'], { FAKE_OMP_SESSIONS_DIR: dir })
      h.send({ type: 'get_state', id: 's' })
      await h.until((f) => f.some((x) => x.id === 's'))
      const file = h.frames.find((x) => x.id === 's')?.data.sessionFile as string
      expect(file.startsWith(dir)).toBe(true)
      expect(file).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl$/)
      expect(existsSync(file)).toBe(false)
      h.send({ type: 'prompt', id: 'p', message: 'hello new' })
      await h.until((f) => f.some((x) => x.type === 'session_settled'))
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      expect(lines[0].type).toBe('session')
      expect(lines[1].message.content).toBe('hello new')
    })

    it('sessionFile is null for a new chat without FAKE_OMP_SESSIONS_DIR', async () => {
      const { h } = startRaw(['--mode', 'rpc-ui'])
      h.send({ type: 'get_state', id: 's' })
      await h.until((f) => f.some((x) => x.id === 's'))
      expect(h.frames.find((x) => x.id === 's')?.data.sessionFile).toBeNull()
    })

    it('rpc mode set_session_name rewrites the title and exits 0', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fake-omp-ren-'))
      const f = join(dir, 'a.jsonl')
      writeFileSync(
        f,
        '{"type":"title","v":1,"title":"Old"}\n{"type":"session","id":"a","cwd":"/x"}\n',
      )
      const { h } = startRaw(['--mode', 'rpc', '--resume', f])
      h.send({ type: 'set_session_name', id: 'evaos-rename', name: 'New name' })
      await h.until((fr) => fr.some((x) => x.id === 'evaos-rename'))
      expect(h.frames.find((x) => x.id === 'evaos-rename')).toMatchObject({
        type: 'response',
        command: 'set_session_name',
        success: true,
      })
      const first = JSON.parse(readFileSync(f, 'utf8').split('\n')[0])
      expect(first).toMatchObject({ type: 'title', title: 'New name' })
      h.child.stdin.end()
      expect(await h.exit).toEqual({ code: 0, signal: null })
    })

    it('rpc mode no-session lists four models', async () => {
      const { h } = startRaw(['--mode', 'rpc', '--no-session'])
      h.send({ type: 'get_available_models', id: 'm' })
      await h.until((f) => f.some((x) => x.id === 'm'))
      const models = h.frames.find((x) => x.id === 'm')?.data.models
      expect(models).toHaveLength(4)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose fake-omp wire JSON in a contract test
      expect(models.some((m: any) => !m.input.includes('image'))).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose fake-omp wire JSON in a contract test
      expect(models.some((m: any) => m.contextWindow === null)).toBe(true)
      expect(models[0].contextWindow).toBe(200000)
    })

    it('set_model, set_thinking_level and set_fast_mode update get_state; contextUsage has a window', async () => {
      const { h } = start()
      h.send({ type: 'set_model', id: 'a', provider: 'fake', modelId: 'text-only' })
      h.send({ type: 'set_thinking_level', id: 'b', level: 'high' })
      h.send({ type: 'set_fast_mode', id: 'c', enabled: true })
      h.send({ type: 'set_session_name', id: 'd', name: 'Live name' })
      h.send({ type: 'get_state', id: 's' })
      await h.until((f) => f.some((x) => x.id === 's'))
      for (const id of ['a', 'b', 'c', 'd'])
        expect(h.frames.find((x) => x.id === id)?.success).toBe(true)
      const d = h.frames.find((x) => x.id === 's')?.data
      expect(d.model.id).toBe('text-only')
      expect(d.thinkingLevel).toBe('high')
      expect(d.fastModeEnabled).toBe(true)
      expect(d.contextUsage).toEqual({ tokens: 42000, contextWindow: 32000 })
    })

    it('prompt images are logged and answered', async () => {
      const { h, logPath } = start()
      h.send({
        type: 'prompt',
        id: 'p',
        message: 'look',
        images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      })
      await h.until((f) => f.some((x) => x.type === 'session_settled'))
      const end = h.frames
        .filter((x) => x.type === 'message_end' && x.message.role === 'assistant')
        .at(-1)
      expect(end?.message.content[0].text).toBe('Got 1 image(s)')
      expect(readLog(logPath).find((e) => e.event === 'prompt-images')?.detail).toEqual({
        count: 1,
        mimeTypes: ['image/png'],
      })
    })

    it('ignores launch switches and keeps unsupported modes failing', async () => {
      const { h } = startRaw([
        '--mode',
        'rpc-ui',
        '--approval-mode',
        'x',
        '--profile',
        'p',
        '--model',
        'm',
        '--thinking',
        'low',
      ])
      h.send({ type: 'get_state', id: 's' })
      await h.until((f) => f.some((x) => x.id === 's'))
      const bad = startRaw(['--mode', 'print'])
      expect((await bad.h.exit).code).toBe(2)
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose fake-omp wire JSON in a contract test
    const dialogs: Array<[string, string, (r: any) => void]> = [
      ['[select]', 'select', (r) => expect(r.options).toHaveLength(5)],
      ['[confirm]', 'confirm', () => {}],
      ['[input]', 'input', () => {}],
      ['[editor]', 'editor', () => {}],
      [
        '[ask]',
        'ask',
        (r) => {
          expect(r.questions).toHaveLength(1)
          expect(r.questions[0].options).toHaveLength(4)
          expect(r.questions[0].recommended).toBe(1)
        },
      ],
      [
        '[ask-multi]',
        'ask',
        (r) => {
          expect(r.questions).toHaveLength(2)
          expect(r.questions[1].multi).toBe(true)
        },
      ],
      ['[ask-bad]', 'ask', (r) => expect(typeof r.questions).toBe('string')],
    ]
    for (const [kw, method, check] of dialogs) {
      it(`${kw} emits ${method}, waits, logs the response and continues`, async () => {
        const { h, logPath } = start()
        h.send({ type: 'prompt', id: 'p', message: `${kw} go` })
        await h.until((f) =>
          f.some((x) => x.type === 'extension_ui_request' && x.method === method),
        )
        const req = h.frames.find((x) => x.type === 'extension_ui_request')!
        expect(req.id).toMatch(/^ui-\d+$/)
        check(req)
        await new Promise((r) => setTimeout(r, 100))
        expect(h.frames.some((x) => x.type === 'session_settled')).toBe(false)
        h.send({ type: 'extension_ui_response', id: req.id, value: 'Beta' })
        await h.until((f) => f.some((x) => x.type === 'session_settled'))
        const end = h.frames
          .filter((x) => x.type === 'message_end' && x.message.role === 'assistant')
          .at(-1)
        expect(end?.message.content[0].text).toBe('Answer received: {"value":"Beta"}')
        expect(readLog(logPath).find((e) => e.event === 'ui-response')?.detail).toMatchObject({
          id: req.id,
          value: 'Beta',
        })
      })
    }

    it('a cancelled response ends the turn with cancelled', async () => {
      const { h } = start()
      h.send({ type: 'prompt', id: 'p', message: '[confirm]' })
      await h.until((f) => f.some((x) => x.type === 'extension_ui_request'))
      h.send({
        type: 'extension_ui_response',
        id: h.frames.find((x) => x.type === 'extension_ui_request')!.id,
        cancelled: true,
      })
      await h.until((f) => f.some((x) => x.type === 'session_settled'))
      const end = h.frames
        .filter((x) => x.type === 'message_end' && x.message.role === 'assistant')
        .at(-1)
      expect(end?.message.content[0].text).toBe('Answer received: cancelled')
    })

    it('closing stdin while a dialog waits exits 0 within 1s', async () => {
      const { h } = start()
      h.send({ type: 'prompt', id: 'p', message: '[select]' })
      await h.until((f) => f.some((x) => x.type === 'extension_ui_request'))
      const t0 = Date.now()
      h.child.stdin.end()
      expect(await h.exit).toEqual({ code: 0, signal: null })
      expect(Date.now() - t0).toBeLessThan(1000)
    })

    it('[slow] plays the reply with a 400 ms frame delay', async () => {
      const { h } = start()
      const t0 = Date.now()
      h.send({ type: 'prompt', id: 'p', message: '[slow] race me' })
      await h.until((f) => f.some((x) => x.type === 'session_settled'), 15000)
      expect(Date.now() - t0).toBeGreaterThan(2000)
    }, 20000)
  })
})
