import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
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
import { abortError, imageMime, StderrTail, stopChild } from './seat-util'

/** How long Claude Code may take to answer `initialize` before the seat counts as not started. */
export const CLAUDE_READY_MS = 30_000

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A Claude Code tool call in the words omp seats use: "reading src/x.ts", "grep foo". */
function claudeDetail(name: string, input: unknown): string {
  const a = isObj(input) ? input : {}
  switch (name) {
    case 'Read':
      return toolDetail('read', { path: a.file_path })
    case 'Grep':
      return toolDetail('grep', { pattern: a.pattern })
    case 'Glob':
      return toolDetail('glob', { pattern: a.pattern })
    case 'WebSearch':
      return toolDetail('web_search', { query: a.query })
    case 'WebFetch':
      return toolDetail('fetch', { url: a.url })
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return toolDetail(name.toLowerCase(), { path: a.file_path })
    default:
      return toolDetail(name.toLowerCase(), a)
  }
}

/** One stream-json user message: the text, then each image as a base64 block. */
function userMessage(prompt: string, images: readonly string[] | undefined): string {
  const content: unknown[] = [{ type: 'text', text: prompt }]
  for (const p of images ?? []) {
    try {
      const data = fs.readFileSync(p).toString('base64')
      content.push({ type: 'image', source: { type: 'base64', media_type: imageMime(p), data } })
    } catch {
      content.push({ type: 'text', text: `(image ${p} could not be read)` })
    }
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

export interface ClaudeSeatOptions {
  claudeBin: string
  guard: GuardInstall
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

/**
 * One long-lived `claude -p` in stream-json mode per seat, in its worktree with every tool and
 * permissions bypassed. Isaac's own settings, hooks, MCP servers, CLAUDE.md files and memory
 * stay out; the guard comes in as a PreToolUse hook. Rejects when the binary is missing or does
 * not answer `initialize` (the launcher then falls back to omp).
 */
export async function startClaudeSeat(spec: SeatSpec, o: ClaudeSeatOptions): Promise<SeatHandle> {
  const model = COUNCIL_MODELS[spec.model]
  const resumeId = spec.resume?.harness === 'claude-code' ? spec.resume.id : null
  /** Claude Code keeps the id across `--resume`; the init frame says so, and that wins. */
  let sessionId = resumeId ?? randomUUID()
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    model.native,
    // Claude Code takes medium | high | xhigh | max as is.
    '--effort',
    spec.thinking,
    ...(resumeId ? ['--resume', resumeId] : ['--session-id', sessionId]),
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--settings',
    o.guard.claudeSettings,
    '--append-system-prompt',
    spec.systemPrompt,
    ...(spec.readDirs.length > 0 ? ['--add-dir', ...spec.readDirs] : []),
    ...(spec.budgetUsd !== undefined ? ['--max-budget-usd', spec.budgetUsd.toFixed(2)] : []),
  ]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...o.env,
    ...o.guard.env,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(o.claudeBin, args, {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  const stderr = new StderrTail()
  child.stderr.on('data', (c: Buffer) => stderr.push(c))
  child.stdin.on('error', () => {
    /* EPIPE after exit: the close handler reports it */
  })

  let exited: Error | null = null
  let stopping = false
  let exitCb: ((err?: Error) => void) | null = null
  const ready = Promise.withResolvers<void>()
  ready.promise.catch(() => undefined)
  /** Results still owed by interrupted turns; they must not end the next turn. */
  let staleResults = 0
  let turn: {
    resolve: (r: SeatTurnResult) => void
    reject: (e: Error) => void
    input: SeatTurnInput
    /** The text of the assistant message streaming now, and of the last finished one. */
    text: string
    presence: string
    toolCalls: number
    t0: number
  } | null = null

  const finish = (r: SeatTurnResult | Error): void => {
    const done = turn
    turn = null
    if (!done) return
    if (r instanceof Error) done.reject(r)
    else done.resolve(r)
  }
  const show = (p: SeatPresence): void => {
    if (!turn) return
    const key = JSON.stringify(p)
    if (key === turn.presence) return
    turn.presence = key
    turn.input.onPresence?.(p)
  }

  const onFrame = (f: Frame): void => {
    switch (f.type) {
      case 'system': {
        if (f.subtype === 'init' && typeof f.session_id === 'string' && f.session_id !== '')
          sessionId = f.session_id
        return
      }
      case 'control_response': {
        const r = f.response
        if (isObj(r) && r.request_id === 'init') {
          if (r.subtype === 'success') ready.resolve()
          else ready.reject(new Error(typeof r.error === 'string' ? r.error : 'initialize failed'))
        }
        return
      }
      case 'stream_event': {
        if (!turn) return
        const ev = f.event
        if (!isObj(ev)) return
        if (ev.type === 'message_start') {
          turn.text = ''
          return
        }
        if (ev.type === 'content_block_start' && isObj(ev.content_block)) {
          const kind = ev.content_block.type
          if (kind === 'thinking' || kind === 'redacted_thinking' || kind === 'tool_use')
            show({ state: 'thinking' })
          else if (kind === 'text') show({ state: 'typing' })
          return
        }
        if (
          ev.type === 'content_block_delta' &&
          isObj(ev.delta) &&
          ev.delta.type === 'text_delta'
        ) {
          turn.text += typeof ev.delta.text === 'string' ? ev.delta.text : ''
          show({ state: 'typing' })
          turn.input.onPartial?.(turn.text)
        }
        return
      }
      case 'assistant': {
        if (!turn || !isObj(f.message) || !Array.isArray(f.message.content)) return
        // The whole message once it is done: tool calls carry their input here.
        const blocks = f.message.content.filter(isObj)
        const text = blocks
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('')
        if (text !== '') turn.text = text
        for (const b of blocks) {
          if (b.type !== 'tool_use') continue
          turn.toolCalls++
          show({ state: 'reading', detail: claudeDetail(String(b.name ?? 'tool'), b.input) })
        }
        return
      }
      case 'user': {
        // Tool results: the model thinks again next.
        if (turn) show({ state: 'thinking' })
        return
      }
      case 'result': {
        if (staleResults > 0) {
          staleResults--
          return
        }
        if (!turn) return
        const u = isObj(f.usage) ? f.usage : {}
        const usage: SeatUsage = {
          input: num(u.input_tokens) + num(u.cache_creation_input_tokens),
          cached: num(u.cache_read_input_tokens),
          output: num(u.output_tokens),
        }
        const text = typeof f.result === 'string' && f.result !== '' ? f.result : turn.text
        if (f.is_error === true || (typeof f.subtype === 'string' && f.subtype !== 'success')) {
          const e = new Error(text || String(f.subtype ?? 'turn failed')) as Error & {
            usage?: SeatUsage
          }
          e.usage = usage
          finish(e)
          return
        }
        finish({ text, usage, images: [], toolCalls: turn.toolCalls, ms: Date.now() - turn.t0 })
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
  child.once('close', (code, signal) => {
    framer.end()
    exited = new Error(stderr.text(`Claude Code ended (${signal ?? `exit ${code}`})`))
    ready.reject(exited)
    finish(exited)
    if (!stopping) exitCb?.(exited)
  })
  // ENOENT and friends: `error` comes before `close`, so the spawn failure is what start() throws.
  child.once('error', (e) => ready.reject(e))
  child.stdin.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'init',
      request: { subtype: 'initialize' },
    }) + '\n',
  )
  const timer = setTimeout(
    () => ready.reject(new Error('Claude Code did not answer within 30 s')),
    CLAUDE_READY_MS,
  )
  try {
    await ready.promise
  } catch (e) {
    stopping = true
    await stopChild(child, { eof: true })
    throw e
  } finally {
    clearTimeout(timer)
  }

  return {
    harness: 'claude-code',
    resumed: resumeId !== null,
    session: () => ({ harness: 'claude-code', id: sessionId }),
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
      turn = { resolve, reject, input, text: '', presence: '', toolCalls: 0, t0: Date.now() }
      const mine = turn
      input.signal?.addEventListener(
        'abort',
        () => {
          if (turn !== mine) return
          finish(abortError(input.signal?.reason))
          staleResults++
          // The turn's own `result` still comes; with no turn waiting it is dropped.
          child.stdin.write(
            JSON.stringify({
              type: 'control_request',
              request_id: `interrupt-${Date.now()}`,
              request: { subtype: 'interrupt' },
            }) + '\n',
          )
        },
        { once: true },
      )
      child.stdin.write(userMessage(input.prompt, input.images), (e) => {
        if (e && turn === mine) finish(e)
      })
      return promise
    },
    stop: async () => {
      stopping = true
      finish(abortError('seat stopped'))
      await stopChild(child, { eof: true })
    },
    onExit: (cb) => {
      exitCb = cb
    },
  }
}
