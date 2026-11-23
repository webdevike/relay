import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { SimulatedClock } from 'xstate'
import {
  ingestUrl,
  parseHelperEvent,
  startMeetingsCapture,
  type CaptureNotice,
} from './meetings-capture'

type Frame = Record<string, unknown>

/** A helper whose stdio is synchronous: what it says is heard at once, what it is told is kept. */
class FakeChild extends EventEmitter {
  written: Frame[] = []
  killed = false
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined })
  stdin = {
    write: (s: string): boolean => {
      for (const line of s.split('\n'))
        if (line.trim() !== '') this.written.push(JSON.parse(line) as Frame)
      return true
    },
  }
  say(ev: Frame): void {
    this.stdout.emit('data', `${JSON.stringify(ev)}\n`)
  }
  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function setup(up = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcap-'))
  dirs.push(dir)
  const exe = path.join(dir, 'RelayMeetingCapture')
  fs.writeFileSync(exe, '')
  const children: FakeChild[] = []
  const sent: Frame[] = []
  const listeners = new Set<(f: Frame) => void>()
  const notices: Array<{ notice: CaptureNotice; answer: (i: number) => void }> = []
  const opened: string[] = []
  const logs: string[] = []
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  let now = 1_000
  const clock = new SimulatedClock()
  const capture = startMeetingsCapture({
    executable: exe,
    spoolDir: path.join(dir, 'spool'),
    frames: {
      onFrame: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      sendFrame: (f) => {
        if (!up) return false
        sent.push(f)
        return true
      },
    },
    origin: () => 'http://mini.local:4100',
    notify: (notice, answer) => notices.push({ notice, answer }),
    openMeeting: (id) => opened.push(id),
    log: (m) => logs.push(m),
    spawn: () => {
      const c = new FakeChild()
      children.push(c)
      return c as unknown as ChildProcess
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true }
      timers.push(t)
      return { cancel: () => (t.live = false) }
    },
    now: () => now,
    snapshotChange: 6,
    clock,
  })!
  const hear = (f: Frame) => {
    for (const cb of [...listeners]) cb(f)
  }
  const runTimers = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn()
  }
  return {
    capture,
    clock,
    children,
    sent,
    hear,
    notices,
    opened,
    logs,
    runTimers,
    advance: (ms: number) => (now += ms),
    setUp: (v: boolean) => (up = v),
  }
}

describe('meetings capture', () => {
  it('parses helper events and builds the ingest url', () => {
    expect(parseHelperEvent('{"ev":"call.start","app":"Zoom","browser":false}')).toEqual({
      ev: 'call.start',
      app: 'Zoom',
      browser: false,
    })
    expect(parseHelperEvent('not json')).toBeNull()
    expect(parseHelperEvent('{"ev":"nope"}')).toBeNull()
    expect(ingestUrl('http://mini.local:4100', 'a b')).toBe(
      'ws://mini.local:4100/meetings/ingest?ticket=a+b',
    )
    expect(ingestUrl('https://x.ts.net', 't')).toBe('wss://x.ts.net/meetings/ingest?ticket=t')
  })

  it('records a meeting app at once and a browser call only after Record', () => {
    const s = setup()
    const helper = s.children[0]!
    helper.say({ ev: 'call.start', app: 'Microsoft Teams', browser: false, title: 'Standup' })
    expect(helper.written).toEqual([{ cmd: 'record', app: 'Microsoft Teams', title: 'Standup' }])
    helper.say({ ev: 'call.start', app: 'Google Chrome', browser: true })
    expect(helper.written).toHaveLength(1)
    expect(s.notices[0]!.notice).toMatchObject({ title: 'Record this call?', actions: ['Record'] })
    s.notices[0]!.answer(-1)
    expect(helper.written).toHaveLength(1)
    s.notices[0]!.answer(0)
    expect(helper.written[1]).toEqual({ cmd: 'record', app: 'Google Chrome' })
  })

  it('asks a ticket per recording and hands the helper the ingest url', () => {
    const s = setup()
    const helper = s.children[0]!
    helper.say({ ev: 'recording', id: 'm1', app: 'Zoom', title: 'Sync', startedAt: 5 })
    expect(s.sent).toEqual([
      { t: 'meeting.ingest.open', id: 'm1', app: 'Zoom', title: 'Sync', startedAt: 5 },
    ])
    expect(s.notices[0]!.notice.title).toBe('Recording Sync')
    s.hear({ t: 'meeting.ingest.ticket', id: 'm1', ticket: 'abc' })
    expect(helper.written).toEqual([
      { cmd: 'connect', id: 'm1', url: 'ws://mini.local:4100/meetings/ingest?ticket=abc' },
    ])
    // Stop from the notification; a click opens the meeting.
    s.notices[0]!.answer(0)
    s.notices[0]!.answer(-1)
    expect(helper.written[1]).toEqual({ cmd: 'stop', id: 'm1' })
    expect(s.opened).toEqual(['m1'])
    helper.say({ ev: 'connected', id: 'm1' })
    helper.say({ ev: 'uploaded', id: 'm1' })
    expect(s.capture.pending()).toEqual([])
  })

  it("tells Isaac once per problem that a call's other side is not being heard", () => {
    const s = setup()
    const helper = s.children[0]!
    helper.say({ ev: 'recording', id: 'm1', app: 'Microsoft Teams', startedAt: 5 })
    const problem = {
      ev: 'health',
      id: 'm1',
      state: 'mic-as-call',
      detail:
        "Relay isn't hearing the other side of this call (your AirPods mic is being recorded instead).",
    }
    helper.say(problem)
    expect(s.notices.at(-1)!.notice).toEqual({
      title: 'Meeting recording problem',
      body: problem.detail,
      actions: [],
    })
    // It comes and goes as Isaac talks: still one notice for it, a new one for another problem.
    helper.say({
      ev: 'health',
      id: 'm1',
      state: 'ok',
      detail: 'Hearing Microsoft Teams and your mic',
    })
    helper.say(problem)
    helper.say({
      ev: 'health',
      id: 'm1',
      state: 'no-mic',
      detail: 'Relay stopped hearing your mic.',
    })
    expect(s.notices.slice(1).map((n) => n.notice.body)).toEqual([
      problem.detail,
      'Relay stopped hearing your mic.',
    ])
    s.notices.at(-1)!.answer(-1)
    expect(s.opened).toEqual(['m1'])
    helper.say({ ev: 'stopped', id: 'm1', capture: 'other side missing: the call track is a mic' })
    expect(s.logs).toContain('meetings: m1: capture other side missing: the call track is a mic')
  })

  it('asks again after a drop, while the host is away, and on a new connection', () => {
    const s = setup(false)
    const helper = s.children[0]!
    helper.say({ ev: 'pending', id: 'm2', app: 'Slack', startedAt: 9 })
    expect(s.sent).toEqual([])
    s.setUp(true)
    s.runTimers()
    expect(s.sent).toHaveLength(1)
    // No answer yet: not asked twice within the wait.
    s.runTimers()
    expect(s.sent).toHaveLength(1)
    s.advance(20_000)
    s.runTimers()
    expect(s.sent).toHaveLength(2)
    helper.say({ ev: 'connected', id: 'm2' })
    s.advance(20_000)
    s.runTimers()
    expect(s.sent).toHaveLength(2)
    helper.say({ ev: 'disconnected', id: 'm2', error: 'reset' })
    s.runTimers()
    expect(s.sent).toHaveLength(3)
    s.hear({ t: 'welcome' })
    expect(s.sent).toHaveLength(4)
    expect(s.capture.pending()).toEqual(['m2'])
  })

  it('restarts a crashed helper and stops it on close', async () => {
    const s = setup()
    s.children[0]!.emit('exit', 1, null)
    s.runTimers()
    expect(s.children).toHaveLength(2)
    await s.capture.close()
    expect(s.children[1]!.killed).toBe(true)
    s.runTimers()
    expect(s.children).toHaveLength(2)
  })

  it('samples a shared screen of a live recording and saves what changed', () => {
    const s = setup()
    const helper = s.children[0]!
    const zeros = '0'.repeat(64)
    helper.say({ ev: 'recording', id: 'm1', app: 'Zoom', startedAt: 5 })
    helper.say({ ev: 'share', id: 'm1', state: 'on', permission: true })
    expect(s.sent.at(-1)).toEqual({ t: 'meeting.share', id: 'm1', state: 'sharing' })
    s.clock.increment(3_000)
    expect(helper.written).toEqual([{ cmd: 'share.sample', id: 'm1', seq: 1 }])
    helper.say({ ev: 'share.sampled', id: 'm1', seq: 1, hash: zeros })
    expect(helper.written.at(-1)).toEqual({ cmd: 'share.save', id: 'm1', seq: 1 })
    helper.say({ ev: 'share.saved', id: 'm1', seq: 1, n: 1 })
    // The same picture again is not saved; the setting going down to 1% still needs a change.
    s.capture.setSnapshotChange(1)
    s.clock.increment(3_000)
    helper.say({ ev: 'share.sampled', id: 'm1', seq: 2, hash: zeros })
    expect(helper.written).toHaveLength(3)
    s.clock.increment(3_000)
    helper.say({ ev: 'share.sampled', id: 'm1', seq: 3, hash: `f${zeros.slice(1)}` })
    expect(helper.written.at(-1)).toEqual({ cmd: 'share.save', id: 'm1', seq: 3 })
    helper.say({ ev: 'share', id: 'm1', state: 'on', permission: false })
    expect(s.sent.at(-1)).toEqual({ t: 'meeting.share', id: 'm1', state: 'no-permission' })
    // The stream to a host that came back is up: it hears the state again.
    const before = s.sent.length
    helper.say({ ev: 'connected', id: 'm1' })
    expect(s.sent.slice(before)).toEqual([{ t: 'meeting.share', id: 'm1', state: 'no-permission' }])
    helper.say({ ev: 'share', id: 'm1', state: 'off', permission: false })
    expect(s.sent.at(-1)).toEqual({ t: 'meeting.share', id: 'm1', state: 'none' })
    // A new relay connection hears that nobody shares any more (it may have missed the off).
    const ended = s.sent.length
    s.hear({ t: 'welcome' })
    expect(s.sent.slice(ended)).toContainEqual({ t: 'meeting.share', id: 'm1', state: 'none' })
    helper.say({ ev: 'share', id: 'm1', state: 'on', permission: true })
    helper.say({ ev: 'stopped', id: 'm1' })
    expect(s.sent.at(-1)).toEqual({ t: 'meeting.share', id: 'm1', state: 'none' })
    const asked = helper.written.length
    s.clock.increment(60_000)
    helper.say({ ev: 'share', id: 'm1', state: 'on', permission: true })
    s.clock.increment(60_000)
    expect(helper.written).toHaveLength(asked)
  })

  it('never samples a pending spool and ends every share when the helper exits', () => {
    const s = setup()
    const helper = s.children[0]!
    helper.say({ ev: 'pending', id: 'old', app: 'Zoom', startedAt: 1 })
    helper.say({ ev: 'share', id: 'old', state: 'on', permission: true })
    s.clock.increment(10_000)
    expect(helper.written).toEqual([])
    helper.say({ ev: 'recording', id: 'm1', app: 'Zoom', startedAt: 5 })
    helper.say({ ev: 'share', id: 'm1', state: 'on', permission: true })
    helper.emit('exit', 1, null)
    s.clock.increment(10_000)
    expect(helper.written).toEqual([])
    expect(s.sent.filter((f) => f.t === 'meeting.share').map((f) => f.state)).toEqual([
      'sharing',
      'none',
    ])
  })
})
