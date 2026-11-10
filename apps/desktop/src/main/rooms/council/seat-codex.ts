import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { LineFramer, type Frame } from '@evaos/chat-core/line-framer'
import { COUNCIL_MODELS } from '@relay/protocol'
import { toolDetail } from '../runner'
import type { GuardInstall } from './guard'
import type {
  SeatHandle,
  SeatPresence,
  SeatSpec,
  SeatTurnInput,
  SeatTurnResult,
  SeatUsage,
} from './seat'
import { abortError, isImagePath, keepGenerated, StderrTail, stopChild } from './seat-util'

/** How long after codex exits its pipes may stay open before the turn settles anyway. */
const EXIT_GRACE_MS = 2000

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Item types that are tool calls (counted, and shown as presence). */
const TOOL_ITEMS: Record<string, true> = {
  command_execution: true,
  file_change: true,
  mcp_tool_call: true,
  web_search: true,
  image_generation: true,
}

/** Presence for a Codex item as it starts or updates. */
function itemPresence(item: Record<string, unknown>): SeatPresence | undefined {
  switch (item.type) {
    case 'reasoning':
      return { state: 'thinking' }
    case 'agent_message':
      return { state: 'typing' }
    case 'command_execution':
      return { state: 'reading', detail: toolDetail('bash', { command: item.command }) }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObj) : []
      return { state: 'reading', detail: toolDetail('edit', { path: changes[0]?.path }) }
    }
    case 'web_search':
      return { state: 'reading', detail: toolDetail('web_search', { query: item.query }) }
    case 'mcp_tool_call':
      return { state: 'reading', detail: toolDetail(String(item.tool ?? 'tool'), item.arguments) }
    case 'image_generation':
      return { state: 'reading', detail: 'generating an image' }
    default:
      return undefined
  }
}

/** Image files in a dir, by name. */
function imagesIn(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).filter(isImagePath))
  } catch {
    return new Set()
  }
}

/** `codex --version` answers: the binary is there and runs. */
export function probeCodex(codexBin: string, env: NodeJS.ProcessEnv): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  execFile(codexBin, ['--version'], { env, timeout: 15_000, killSignal: 'SIGKILL' }, (e) =>
    e ? reject(e) : resolve(),
  )
  return promise
}

export interface CodexSeatOptions {
  codexBin: string
  guard: GuardInstall
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

/**
 * A Codex seat: one `codex exec --json` per turn in the seat's worktree, no sandbox and no
 * approvals (the guard hook and shims ask for outward actions instead), Isaac's config.toml
 * left out. The first turn starts a thread; later turns `codex exec resume <thread>`.
 * The system prompt goes in once, as the thread's developer instructions.
 */
export async function startCodexSeat(spec: SeatSpec, o: CodexSeatOptions): Promise<SeatHandle> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...o.env, ...o.guard.env }
  delete env.ELECTRON_RUN_AS_NODE
  await probeCodex(o.codexBin, env)
  const codexHome = env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  const model = COUNCIL_MODELS[spec.model]
  let threadId: string | null = null
  let running: ChildProcess | null = null
  let busy = false
  /**
   * `turn.completed` carries the thread's running totals, and `exec resume` loads the earlier
   * turns' tokens with the thread (measured on codex 0.167), so a turn's usage is the difference.
   */
  let totals = { input: 0, cached: 0, output: 0 }
  let stopped = false

  /** Flags both `exec` and `exec resume` take. */
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    model.native,
    // gpt-6.1-sol and gpt-6-astra take low..max (and `ultra`, which is max plus automatic
    // delegation to sub-agents, not more reasoning): the dial's levels map one to one.
    '-c',
    `model_reasoning_effort="${spec.thinking}"`,
    // Commands inherit this PATH (guard shims first) instead of the login shell's.
    '-c',
    'allow_login_shell=false',
    ...o.guard.codexArgs,
  ]

  const runTurn = (input: SeatTurnInput): Promise<SeatTurnResult> => {
    const images = (input.images ?? []).flatMap((p) => ['-i', p])
    const args =
      threadId === null
        ? [
            'exec',
            ...common,
            '-C',
            spec.cwd,
            '-c',
            `developer_instructions=${JSON.stringify(spec.systemPrompt)}`,
            ...images,
            '-',
          ]
        : ['exec', 'resume', ...common, ...images, threadId, '-']
    const t0 = Date.now()
    const generatedDir = (): string | null =>
      threadId === null ? null : path.join(codexHome, 'generated_images', threadId)
    const before = imagesIn(generatedDir() ?? '')
    const usage: SeatUsage = { input: 0, output: 0, cached: 0 }
    let text = ''
    let toolCalls = 0
    let presence = ''
    let failure: string | null = null
    const named = new Set<string>()
    const show = (p: SeatPresence | undefined): void => {
      if (!p) return
      const key = JSON.stringify(p)
      if (key === presence) return
      presence = key
      input.onPresence?.(p)
    }

    const child = spawn(o.codexBin, args, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    running = child
    const stderr = new StderrTail()
    child.stderr.on('data', (c: Buffer) => stderr.push(c))
    child.stdin.on('error', () => {
      /* EPIPE: the close handler reports it */
    })
    child.stdin.end(input.prompt)

    const onFrame = (f: Frame): void => {
      switch (f.type) {
        case 'thread.started':
          if (typeof f.thread_id === 'string' && threadId === null) threadId = f.thread_id
          return
        case 'turn.started':
          show({ state: 'thinking' })
          return
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = f.item
          if (!isObj(item)) return
          show(itemPresence(item))
          if (item.type === 'agent_message' && typeof item.text === 'string' && item.text !== '') {
            text = item.text
            input.onPartial?.(text)
          }
          if (f.type !== 'item.completed') return
          if (typeof item.type === 'string' && TOOL_ITEMS[item.type]) toolCalls++
          for (const k of ['saved_path', 'path', 'file']) {
            const p = item[k]
            if (typeof p === 'string' && path.isAbsolute(p) && isImagePath(p)) named.add(p)
          }
          return
        }
        case 'turn.completed': {
          const u = isObj(f.usage) ? f.usage : {}
          const now = {
            input: num(u.input_tokens),
            cached: num(u.cached_input_tokens),
            output: num(u.output_tokens),
          }
          const cached = Math.max(0, now.cached - totals.cached)
          usage.input = Math.max(0, now.input - totals.input - cached)
          usage.cached = cached
          usage.output = Math.max(0, now.output - totals.output)
          totals = now
          return
        }
        case 'turn.failed': {
          const e = f.error
          failure = isObj(e) && typeof e.message === 'string' ? e.message : 'turn failed'
          return
        }
        default:
          return
      }
    }
    const framer = new LineFramer(onFrame, () => {
      /* a bad line never drops its neighbours */
    })
    child.stdout.on('data', (c: Buffer) => framer.push(c))

    const { promise, resolve, reject } = Promise.withResolvers<SeatTurnResult>()
    let aborted: Error | null = null
    const onAbort = (): void => {
      aborted = abortError(input.signal?.reason)
      void stopChild(child, { eof: false })
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (e) => {
      input.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    let ended = false
    const end = (code: number | null, signal: NodeJS.Signals | null, via: string): void => {
      if (ended) return
      ended = true
      try {
        framer.end()
        input.signal?.removeEventListener('abort', onAbort)
        if (running === child) running = null
        o.log?.(`codex seat ${spec.seatId}: turn ended on ${via} (${signal ?? `exit ${code}`})`)
        if (aborted) return reject(aborted)
        if (stopped) return reject(abortError('seat stopped'))
        if (failure !== null) return reject(new Error(failure))
        if (code !== 0)
          return reject(new Error(stderr.text(`Codex ended (${signal ?? `exit ${code}`})`)))
        const dir = generatedDir()
        const fresh =
          dir === null
            ? []
            : [...imagesIn(dir)].filter((n) => !before.has(n)).map((n) => path.join(dir, n))
        resolve({
          text,
          usage,
          images: keepGenerated([...new Set([...named, ...fresh])], spec.cwd),
          toolCalls,
          ms: Date.now() - t0,
        })
      } catch (e) {
        o.log?.(`codex seat ${spec.seatId}: ending the turn failed: ${String(e)}`)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    child.once('close', (code, signal) => end(code, signal, 'close'))
    // A process codex left behind can hold stdout open after codex exits, and then 'close'
    // never comes: settle from 'exit' once the pipes have had a moment to drain.
    child.once('exit', (code, signal) => {
      setTimeout(() => end(code, signal, 'exit'), EXIT_GRACE_MS).unref()
    })
    return promise
  }

  return {
    harness: 'codex',
    turn: async (input) => {
      if (stopped) throw new Error('seat stopped')
      if (busy) throw new Error('a turn is already running')
      if (input.signal?.aborted) throw abortError(input.signal.reason)
      busy = true
      try {
        return await runTurn(input)
      } finally {
        busy = false
      }
    },
    stop: async () => {
      stopped = true
      if (running) await stopChild(running, { eof: false })
    },
    // A process per turn: nothing outlives a turn, so there is no unexpected exit to report.
    onExit: () => undefined,
  }
}
