import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
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
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  let now = 1_000
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
    log: () => undefined,
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
  })!
  const hear = (f: Frame) => {
    for (const cb of [...listeners]) cb(f)
  }
  const runTimers = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn()
  }
  return {
    capture,
    children,
    sent,
    hear,
    notices,
    opened,
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
})
