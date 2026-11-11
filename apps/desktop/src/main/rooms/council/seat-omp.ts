import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PromptImage } from '@evaos/chat-core/transport'
import type { Frame } from '@evaos/chat-core/line-framer'
import { COUNCIL_MODELS } from '@relay/protocol'
import { OmpStdioTransport } from '../../chat/omp-transport'
import { messageText, presenceOf, STOP_STEP_MS } from '../omp-frames'
import type { GuardInstall } from './guard'
import type {
  SeatHandle,
  SeatPresence,
  SeatSpec,
  SeatTurnInput,
  SeatTurnResult,
  SeatUsage,
} from './seat'
import { abortError, imageMime, keepGenerated } from './seat-util'

/**
 * Context files omp would otherwise pick up by walking up from the seat's worktree: the Eva
 * root's AGENTS.md / CLAUDE.md would turn every seat into Eva. `--no-rules` does not cover them;
 * omp's `disabledExtensions` setting does (ids from its context-files capability).
 */
const OMP_SEAT_CONFIG = `disabledExtensions:
  - context-file:project:AGENTS.md
  - context-file:project:CLAUDE.md
  - context-file:user:AGENTS.md
  - context-file:user:CLAUDE.md
`

/** omp dialogs (the `ask` tool and friends): nobody answers them in a room, so they are cancelled. */
const DIALOG_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
  ask: true,
}

/** Inline images up to this much base64 per turn; omp's rpc-ui frames cap at 1 MiB. */
const INLINE_IMAGE_BYTES = 600_000

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Usage of one assistant message: `{input, output, cacheRead, cacheWrite}` in omp. */
function addUsage(total: SeatUsage, usage: unknown): void {
  if (!isObj(usage)) return
  total.input += num(usage.input) + num(usage.cacheWrite)
  total.cached += num(usage.cacheRead)
  total.output += num(usage.output)
}

/** Absolute image paths an image tool's result names that exist and are new this turn. */
function imagesIn(result: unknown, since: number): string[] {
  const text = JSON.stringify(result ?? '')
  const out = new Set<string>()
  for (const m of text.matchAll(/\/[^"'\s\\]+\.(?:png|jpe?g|webp|gif)/gi)) {
    try {
      if (fs.statSync(m[0]).mtimeMs >= since - 1000) out.add(m[0])
    } catch {
      /* not a file */
    }
  }
  return [...out]
}

/** The prompt plus the images: small ones inline, the rest named so the seat reads them. */
function attach(
  prompt: string,
  images: readonly string[] | undefined,
): { text: string; inline: PromptImage[] } {
  const inline: PromptImage[] = []
  const named: string[] = []
  let budget = INLINE_IMAGE_BYTES
  for (const p of images ?? []) {
    let data: string
    try {
      data = fs.readFileSync(p).toString('base64')
    } catch {
      named.push(p)
      continue
    }
    if (data.length <= budget) {
      budget -= data.length
      inline.push({ type: 'image', data, mimeType: imageMime(p) })
    } else named.push(p)
  }
  const text =
    named.length === 0
      ? prompt
      : `${prompt}\n\nImages for this turn (open them with the read tool):\n${named.map((p) => `- ${p}`).join('\n')}`
  return { text, inline }
}

export interface OmpSeatOptions {
  ompBin: string
  guard: GuardInstall
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /** omp `--model` for every seat (tests run a cheap model); default the seat's own. */
  model?: string
}

/** The newest session file omp wrote in `dir`, or null. */
function newestSession(dir: string): string | null {
  let best: { file: string; at: number } | null = null
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const n of names) {
    if (!n.endsWith('.jsonl') || n.startsWith('.')) continue
    const file = path.join(dir, n)
    const at = fs.statSync(file).mtimeMs
    if (!best || at > best.at) best = { file, at }
  }
  return best?.file ?? null
}

/**
 * One long-lived `omp --mode rpc-ui` per seat with omp's full built-in toolset, auto-approved,
 * in the seat's worktree. Eva's rules, skills, extensions and context files stay out.
 */
export async function startOmpSeat(
  spec: SeatSpec,
  o: OmpSeatOptions,
  fallback?: string,
): Promise<SeatHandle> {
  const configFile = path.join(o.guard.dir, 'omp-seat.yml')
  fs.writeFileSync(configFile, OMP_SEAT_CONFIG)
  const extraEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(o.env ?? {})) if (v !== undefined) extraEnv[k] = v
  Object.assign(extraEnv, o.guard.env)
  const t = new OmpStdioTransport({
    ompBin: o.ompBin,
    live: false,
    processGroup: true,
    takeExtraEnv: () => extraEnv,
  })

  const stderr: string[] = []
  let exited: Error | null = null
  let stopping = false
  let exitCb: ((err?: Error) => void) | null = null
  let turn: {
    resolve: (r: SeatTurnResult) => void
    reject: (e: Error) => void
    input: SeatTurnInput
    text: string
    presence: string
    usage: SeatUsage
    images: string[]
    toolCalls: number
    t0: number
  } | null = null

  const finish = (err: Error | null): void => {
    const done = turn
    turn = null
    if (!done) return
    if (err) {
      done.reject(err)
      return
    }
    done.resolve({
      text: done.text,
      usage: done.usage,
      images: keepGenerated(done.images, spec.cwd),
      toolCalls: done.toolCalls,
      ms: Date.now() - done.t0,
    })
  }

  t.onFrame((f: Frame) => {
    if (turn) {
      const p = presenceOf(f)
      if (p) {
        const key = JSON.stringify(p)
        if (key !== turn.presence) {
          turn.presence = key
          turn.input.onPresence?.(p as SeatPresence)
        }
      }
    }
    switch (f.type) {
      case '_stderr': {
        stderr.push(String(f.line ?? ''))
        if (stderr.length > 8) stderr.shift()
        return
      }
      case '_eof': {
        const tail = stderr
          .filter((l) => l.trim() !== '')
          .slice(-3)
          .join(' | ')
        exited = new Error(tail === '' ? 'omp ended' : tail)
        finish(exited)
        if (!stopping) exitCb?.(exited)
        return
      }
      case 'extension_ui_request': {
        const method = typeof f.method === 'string' ? f.method : ''
        if (DIALOG_METHODS[method] && typeof f.id === 'string') {
          void t
            .write({ type: 'extension_ui_response', id: f.id, cancelled: true })
            .catch(() => undefined)
        }
        return
      }
      case 'message_start':
      case 'message_update':
      case 'message_end': {
        if (!turn) return
        const m = f.message
        if (!isObj(m) || m.role !== 'assistant') return
        const text = messageText(m)
        if (text !== '' && text !== turn.text) {
          turn.text = text
          turn.input.onPartial?.(text)
        }
        if (f.type === 'message_end') addUsage(turn.usage, m.usage)
        return
      }
      case 'tool_execution_start': {
        if (turn) turn.toolCalls++
        return
      }
      case 'tool_execution_end': {
        if (!turn) return
        const name = typeof f.toolName === 'string' ? f.toolName : ''
        if (/image/i.test(name)) {
          turn.images.push(...imagesIn(f.result, turn.t0))
        }
        return
      }
      case 'agent_end': {
        if (turn && f.yielded !== false) finish(null)
        return
      }
      case 'prompt_result': {
        if (!turn || f.status === 'completed') return
        const e = f.error
        const msg =
          isObj(e) && typeof e.message === 'string'
            ? e.message
            : f.status === 'aborted'
              ? 'turn aborted'
              : 'turn failed'
        finish(f.status === 'aborted' ? abortError(msg) : new Error(msg))
        return
      }
      case 'response': {
        if (turn && f.success === false && f.command === 'prompt') {
          finish(new Error(typeof f.error === 'string' ? f.error : 'prompt failed'))
        }
        return
      }
      default:
        return
    }
  })

  const resumeFile =
    spec.resume?.harness === 'omp' && fs.existsSync(spec.resume.file) ? spec.resume.file : null
  await t.start({
    // `--resume <file>`: the seat's earlier turns come back and new ones append to the same file.
    sessionFile: resumeFile,
    cwd: spec.cwd,
    args: [
      '--session-dir',
      spec.sessionDir,
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-lsp',
      '--no-ui',
      '--no-title',
      '--approval-mode',
      'yolo',
      '--config',
      configFile,
      '--model',
      o.model ?? COUNCIL_MODELS[spec.model].omp,
      // omp takes medium | high | xhigh | max as is.
      '--thinking',
      spec.thinking,
      '--system-prompt',
      spec.systemPrompt,
      ...spec.readDirs.flatMap((d) => ['--add-dir', d]),
    ],
  })

  return {
    harness: 'omp',
    ...(fallback ? { fallback } : {}),
    resumed: resumeFile !== null,
    session: () => {
      const file = resumeFile ?? newestSession(spec.sessionDir)
      return file === null ? null : { harness: 'omp', file }
    },
    turn: (input) => {
      const { promise, resolve, reject } = Promise.withResolvers<SeatTurnResult>()
      if (exited) {
        reject(exited)
        return promise
      }
      if (turn) {
        reject(new Error('a turn is already running'))
        return promise
      }
      if (input.signal?.aborted) {
        reject(abortError(input.signal.reason))
        return promise
      }
      turn = {
        resolve,
        reject,
        input,
        text: '',
        presence: '',
        usage: { input: 0, output: 0, cached: 0 },
        images: [],
        toolCalls: 0,
        t0: Date.now(),
      }
      const mine = turn
      input.signal?.addEventListener(
        'abort',
        () => {
          if (turn !== mine) return
          finish(abortError(input.signal?.reason))
          if (!exited) void t.abort().catch(() => undefined)
        },
        { once: true },
      )
      const { text, inline } = attach(input.prompt, input.images)
      t.send(text, inline).catch((e: unknown) => {
        if (turn === mine) finish(e instanceof Error ? e : new Error(String(e)))
      })
      return promise
    },
    stop: async () => {
      stopping = true
      finish(abortError('seat stopped'))
      let r = await t.close({ timeoutMs: STOP_STEP_MS })
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (!r.timedOut) break
        if (t.pid !== null) {
          try {
            process.kill(-t.pid, signal)
          } catch {
            /* already exited */
          }
        }
        r = await t.close({ timeoutMs: STOP_STEP_MS })
      }
    },
    onExit: (cb) => {
      exitCb = cb
    },
  }
}
