// Relay Meetings (apps/meetings-capture) ships inside the packaged app as `Relay.app/Contents/
// Helpers/Relay Meetings.app` and runs as Relay's child, like Assist (assist.ts), so the System
// Audio Recording and Microphone grants are Relay's. It is a separate helper from Assist: a hang in
// one cannot take the other down, and capture never shares a process with Assist's voice engine.
//
// The helper detects calls (a meeting app's process running the mic) and records; this side owns
// the decisions: a meeting app's call is recorded at once, a browser call (Meet, Teams on the web)
// only after Isaac taps Record on a notification. Every recording streams to the Relay Host this
// Mac is connected to (the Mini) over a ticketed socket: `meeting.ingest.open {id, ...}` on the
// Relay connection answers `meeting.ingest.ticket {id, ticket}`, and the helper opens
// `/meetings/ingest?ticket=`. The helper spools both tracks to disk, so a host that is away gets
// the whole call when it comes back; tickets are asked again until it does.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { MAX_QUICK_CRASHES, RESTART_MS, SHORT_RUN_MS } from './assist'
import type { RelayFrames } from './relay/client'

/** Tickets for recordings the host has not got are asked again this often. */
export const RETRY_MS = 5_000
/** A ticket asked for and not answered within this long is asked again. */
export const TICKET_WAIT_MS = 15_000

/** The helper executable in a packaged Relay.app, from its `Contents/Resources`. */
export function meetingsExecutable(resourcesPath: string): string {
  return path.join(
    resourcesPath,
    '..',
    'Helpers',
    'Relay Meetings.app',
    'Contents',
    'MacOS',
    'RelayMeetingCapture',
  )
}

const HelperEvent = z.discriminatedUnion('ev', [
  z.object({ ev: z.literal('ready') }),
  z.object({
    ev: z.literal('call.start'),
    app: z.string(),
    browser: z.boolean(),
    title: z.string().optional(),
  }),
  z.object({ ev: z.literal('call.end'), app: z.string() }),
  z.object({
    ev: z.enum(['recording', 'pending']),
    id: z.string(),
    app: z.string(),
    title: z.string().optional(),
    startedAt: z.number(),
  }),
  z.object({ ev: z.literal('connected'), id: z.string() }),
  z.object({ ev: z.literal('disconnected'), id: z.string(), error: z.string().optional() }),
  z.object({ ev: z.literal('health'), id: z.string(), state: z.string(), detail: z.string() }),
  z.object({ ev: z.literal('stopped'), id: z.string() }),
  z.object({ ev: z.literal('uploaded'), id: z.string() }),
  z.object({ ev: z.literal('stop.requested'), id: z.string() }),
  z.object({ ev: z.literal('warning'), message: z.string(), id: z.string().optional() }),
  z.object({ ev: z.literal('error'), message: z.string() }),
])
export type HelperEvent = z.infer<typeof HelperEvent>

/** One helper stdout line, or null when it is not an event this side knows. */
export function parseHelperEvent(line: string): HelperEvent | null {
  try {
    const r = HelperEvent.safeParse(JSON.parse(line))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** `ws(s)://<host>/meetings/ingest?ticket=<ticket>` from the host's http(s) origin. */
export function ingestUrl(origin: string, ticket: string): string {
  const u = new URL('/meetings/ingest', origin)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.searchParams.set('ticket', ticket)
  return u.toString()
}

export interface CaptureNotice {
  title: string
  body: string
  /** Button labels; the answer is the index tapped, `-1` for a click on the notification itself. */
  actions: string[]
}

export interface MeetingsCaptureDeps {
  executable: string
  /** Where the helper spools recordings until the host has them. */
  spoolDir: string
  frames: RelayFrames
  /** The connected host's http origin, or null while there is none. */
  origin: () => string | null
  /** Shows a desktop notification; `onAnswer` gets the action index (or -1 for a click). */
  notify: (notice: CaptureNotice, onAnswer: (action: number) => void) => void
  /** Opens the meeting's page (a notification click). */
  openMeeting: (id: string) => void
  log: (msg: string) => void
  /** Extra helper arguments (e2e: `--replay <dir> --no-detect`). */
  args?: string[]
  spawn?: (cmd: string, args: string[]) => ChildProcess
  setTimer?: (fn: () => void, ms: number) => { cancel(): void }
  now?: () => number
}

interface Upload {
  readonly id: string
  readonly app: string
  readonly title?: string
  readonly startedAt: number
  connected: boolean
  /** When the last ticket was asked for (0: not waiting for one). */
  askedAt: number
}

export interface MeetingsCapture {
  /** Asks the helper to record now (a browser call Isaac chose to record, or a test). */
  record(app: string, title?: string): void
  /** Stops recording `id`. */
  stop(id: string): void
  /** Recordings the host does not have yet. */
  pending(): string[]
  /** Ends the helper (SIGTERM; it marks its spools ended) within 3 s. */
  close(): Promise<void>
}

/**
 * Keeps the helper running while Relay runs (assist.ts's restart rules) and moves its recordings
 * to the host. Null when this build carries no helper.
 */
export function startMeetingsCapture(deps: MeetingsCaptureDeps): MeetingsCapture | null {
  if (!existsSync(deps.executable)) return null
  mkdirSync(deps.spoolDir, { recursive: true })
  const spawn =
    deps.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] }))
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(t) }
    })
  const now = deps.now ?? Date.now
  const uploads = new Map<string, Upload>()
  let child: ChildProcess | null = null
  let stopped = false
  let quickCrashes = 0
  let restart: { cancel(): void } | null = null
  let retry: { cancel(): void } | null = null

  const send = (cmd: Record<string, unknown>): void => {
    child?.stdin?.write(`${JSON.stringify(cmd)}\n`)
  }

  const askTicket = (u: Upload): void => {
    if (u.connected || (u.askedAt > 0 && now() - u.askedAt < TICKET_WAIT_MS)) return
    const frame: Record<string, unknown> = {
      t: 'meeting.ingest.open',
      id: u.id,
      app: u.app,
      startedAt: u.startedAt,
    }
    if (u.title !== undefined) frame.title = u.title
    if (deps.frames.sendFrame(frame)) u.askedAt = now()
  }

  const tick = (): void => {
    retry = null
    if (stopped) return
    for (const u of uploads.values()) askTicket(u)
    if (uploads.size > 0) retry = setTimer(tick, RETRY_MS)
  }
  const scheduleRetry = (): void => {
    if (!retry && !stopped) retry = setTimer(tick, RETRY_MS)
  }

  const offFrames = deps.frames.onFrame((f) => {
    if (f.t === 'welcome') {
      // A fresh connection (maybe another host): every upload asks again.
      for (const u of uploads.values()) u.askedAt = 0
      tick()
      return
    }
    if (
      f.t === 'meeting.ingest.ticket' &&
      typeof f.id === 'string' &&
      typeof f.ticket === 'string'
    ) {
      const u = uploads.get(f.id)
      const origin = deps.origin()
      if (!u || origin === null) return
      u.askedAt = now()
      send({ cmd: 'connect', id: u.id, url: ingestUrl(origin, f.ticket) })
      return
    }
    if (f.t === 'meeting.ingest.refused' && typeof f.id === 'string') {
      const u = uploads.get(f.id)
      if (!u) return
      deps.log(
        `meetings: host refused ${f.id}: ${typeof f.reason === 'string' ? f.reason : 'no reason'}`,
      )
      // Asked again after the retry interval (the host may come back with meetings on).
      u.askedAt = now()
      scheduleRetry()
    }
  })

  const heard = (ev: HelperEvent): void => {
    switch (ev.ev) {
      case 'call.start':
        if (!ev.browser) {
          send({
            cmd: 'record',
            app: ev.app,
            ...(ev.title === undefined ? {} : { title: ev.title }),
          })
          return
        }
        deps.notify(
          { title: 'Record this call?', body: `${ev.app} is using your mic.`, actions: ['Record'] },
          (action) => {
            if (action === 0)
              send({
                cmd: 'record',
                app: ev.app,
                ...(ev.title === undefined ? {} : { title: ev.title }),
              })
          },
        )
        return
      case 'recording':
      case 'pending': {
        const u: Upload = {
          id: ev.id,
          app: ev.app,
          startedAt: ev.startedAt,
          connected: false,
          askedAt: 0,
          ...(ev.title === undefined ? {} : { title: ev.title }),
        }
        uploads.set(ev.id, u)
        if (ev.ev === 'recording') {
          deps.notify(
            {
              title: `Recording ${ev.title ?? `a ${ev.app} call`}`,
              body: 'Relay is transcribing this call.',
              actions: ['Stop'],
            },
            (action) => {
              if (action === 0) send({ cmd: 'stop', id: ev.id })
              else deps.openMeeting(ev.id)
            },
          )
        }
        askTicket(u)
        scheduleRetry()
        return
      }
      case 'connected': {
        const u = uploads.get(ev.id)
        if (u) u.connected = true
        return
      }
      case 'disconnected': {
        const u = uploads.get(ev.id)
        if (!u) return
        u.connected = false
        u.askedAt = 0
        if (ev.error !== undefined) deps.log(`meetings: upload of ${ev.id} dropped: ${ev.error}`)
        scheduleRetry()
        return
      }
      case 'health':
        if (ev.state !== 'ok')
          deps.notify({ title: 'Meeting recording problem', body: ev.detail, actions: [] }, () =>
            deps.openMeeting(ev.id),
          )
        return
      case 'uploaded':
        uploads.delete(ev.id)
        return
      case 'warning':
        deps.log(`meetings: ${ev.id === undefined ? '' : `${ev.id}: `}${ev.message}`)
        return
      case 'error':
        deps.log(`meetings: ${ev.message}`)
        return
      default:
        return
    }
  }

  const launch = (): void => {
    const started = now()
    const c = spawn(deps.executable, ['serve', '--spool', deps.spoolDir, ...(deps.args ?? [])])
    child = c
    let buf = ''
    c.stdout?.setEncoding('utf8')
    c.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const ev = parseHelperEvent(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (ev) heard(ev)
        nl = buf.indexOf('\n')
      }
    })
    c.on('error', (e) => deps.log(`meetings: ${e.message}`))
    c.on('exit', (code, signal) => {
      child = null
      // Its connections died with it; the next run reports its spools as pending again.
      uploads.clear()
      if (stopped) return
      if (code === 0) {
        deps.log('meetings helper exited cleanly; not restarting')
        return
      }
      quickCrashes = now() - started < SHORT_RUN_MS ? quickCrashes + 1 : 1
      if (quickCrashes >= MAX_QUICK_CRASHES) {
        deps.log(
          `meetings helper crashed ${quickCrashes} times in a row (last ${signal ?? code}); leaving it down`,
        )
        return
      }
      deps.log(`meetings helper ended (${signal ?? code}); restarting in ${RESTART_MS / 1000} s`)
      restart = setTimer(launch, RESTART_MS)
    })
  }
  launch()

  return {
    record(app, title) {
      send({ cmd: 'record', app, ...(title === undefined ? {} : { title }) })
    },
    stop(id) {
      send({ cmd: 'stop', id })
    },
    pending() {
      return [...uploads.keys()]
    },
    close() {
      stopped = true
      offFrames()
      restart?.cancel()
      retry?.cancel()
      const c = child
      if (!c) return Promise.resolve()
      const { promise, resolve } = Promise.withResolvers<void>()
      const cap = setTimeout(resolve, 3_000)
      c.once('exit', () => {
        clearTimeout(cap)
        resolve()
      })
      c.kill('SIGTERM')
      return promise
    },
  }
}
