import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import type { Frame } from './desktop'

/**
 * Relay Assist as `@computer`'s presentation layer for `live` and `walk` (SPEC.md): the bundled
 * Assist binary in `--present` mode draws the assistant's cursor, outline, caption, click mark and
 * step badge, and speaks in her `liveVoice`. JSON lines in on stdin, events out on stdout.
 */
export interface Shown {
  /** The cursor got there. */
  landed: Promise<void>
  /** Her line finished (at once when nothing is said). */
  spoken: Promise<void>
}

export interface Presenter {
  assistant(id: string): void
  point(rect: Frame, caption: string, opts?: { speak?: string; step?: number; of?: number }): Shown
  click(x: number, y: number, caption: string): Shown
  caption(text: string, speak?: boolean): Shown
  hide(): void
  /** Esc on the overlay. */
  onEsc(cb: () => void): void
  close(): void
}

/** The Assist executable: `RELAY_ASSIST_BIN`, else the one inside this Relay.app; null when absent. */
export function assistBinary(resourcesPath: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.RELAY_ASSIST_BIN,
    resourcesPath
      ? path.join(resourcesPath, '..', 'Helpers', 'Relay Assist.app', 'Contents', 'MacOS', 'RelayBuddy')
      : undefined,
  ]
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null
}

const EventSchema = z.object({
  ev: z.string(),
  id: z.number().optional(),
  message: z.string().optional(),
})

const READY_MS = 8000

/** Starts `--present` and resolves once it said ready; rejects when it never does. */
export async function startPresenter(bin: string, log: (line: string) => void): Promise<Presenter> {
  const proc: ChildProcessWithoutNullStreams = spawn(bin, ['--present'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const ready = Promise.withResolvers<void>()
  const landed = new Map<number, () => void>()
  const spoken = new Map<number, () => void>()
  const esc = new Set<() => void>()
  let nextId = 1
  let alive = true
  const settleAll = (): void => {
    alive = false
    for (const f of [...landed.values(), ...spoken.values()]) f()
    landed.clear()
    spoken.clear()
  }
  const decoder = new StringDecoder('utf8')
  let buf = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      let e: z.infer<typeof EventSchema>
      try {
        e = EventSchema.parse(JSON.parse(line))
      } catch {
        continue
      }
      if (e.ev === 'ready') ready.resolve()
      else if (e.ev === 'landed' && e.id !== undefined) {
        landed.get(e.id)?.()
        landed.delete(e.id)
      } else if (e.ev === 'spoken' && e.id !== undefined) {
        spoken.get(e.id)?.()
        spoken.delete(e.id)
      } else if (e.ev === 'esc') for (const cb of esc) cb()
      else if (e.ev === 'error') log(`presenter: ${e.message ?? 'error'}`)
    }
  })
  proc.stderr.resume()
  proc.on('exit', (code) => {
    settleAll()
    ready.reject(new Error(`Assist --present exited (${String(code)})`))
  })
  proc.on('error', (e) => {
    settleAll()
    ready.reject(e)
  })
  const timer = setTimeout(() => ready.reject(new Error('Assist --present did not start')), READY_MS)
  try {
    await ready.promise
  } catch (e) {
    proc.kill()
    throw e
  } finally {
    clearTimeout(timer)
  }

  const send = (op: Record<string, unknown>, speaks: boolean): Shown => {
    const id = nextId++
    const l = Promise.withResolvers<void>()
    const s = Promise.withResolvers<void>()
    if (!alive) {
      l.resolve()
      s.resolve()
      return { landed: l.promise, spoken: s.promise }
    }
    landed.set(id, l.resolve)
    if (speaks) spoken.set(id, s.resolve)
    else s.resolve()
    proc.stdin.write(`${JSON.stringify({ ...op, id })}\n`)
    return { landed: l.promise, spoken: s.promise }
  }

  return {
    assistant(id) {
      if (alive) proc.stdin.write(`${JSON.stringify({ op: 'assistant', id })}\n`)
    },
    point(rect, caption, opts = {}) {
      return send(
        {
          op: 'point',
          rect,
          caption,
          ...(opts.speak ? { speak: opts.speak } : {}),
          ...(opts.step !== undefined ? { step: opts.step, of: opts.of } : {}),
        },
        !!opts.speak,
      )
    },
    click(x, y, caption) {
      return send({ op: 'click', x, y, caption }, false)
    },
    caption(text, speak = false) {
      return send({ op: 'caption', text, speak }, speak)
    },
    hide() {
      if (alive) proc.stdin.write('{"op":"hide"}\n')
    },
    onEsc(cb) {
      esc.add(cb)
    },
    close() {
      if (!alive) return
      proc.stdin.write('{"op":"quit"}\n')
      proc.stdin.end()
      setTimeout(() => {
        if (alive) proc.kill()
      }, 3000)
    },
  }
}
