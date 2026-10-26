import type { Frame } from '@evaos/chat-core/line-framer'
import type { RoomAgent, RoomPresence } from '@evaos/contract'
import { OmpStdioTransport } from '../chat/omp-transport'

/** What a turn is doing right now, without the clock; null is idle. */
export type Presence = Omit<RoomPresence, 'since'> | null

/**
 * One throwaway omp process holding one persona's conversation. `send` is one turn: the prompt
 * in, the reply out, `onPartial` fed with the reply so far while it streams and `onPresence`
 * with what the model is doing.
 */
export interface AgentHandle {
  send(
    text: string,
    hooks?: { onPartial?: (text: string) => void; onPresence?: (p: Presence) => void },
  ): Promise<string>
  /** Fires once if the process ends on its own (not through `stop`). */
  onExit(cb: (reason: string) => void): void
  stop(): Promise<void>
}

export interface AgentStart {
  systemPrompt: string
  model: string
  tools: RoomAgent['tools']
  /** omp `--thinking`: seats run high, the judge medium. */
  thinking: 'medium' | 'high'
}

export interface AgentRunner {
  start(opts: AgentStart): Promise<AgentHandle>
}

export interface OmpAgentRunnerOptions {
  ompBin: string
  live: boolean
  /** Where tool-less processes run. */
  cwd: string
  /** Where read-only seats run, so `read`/`grep`/`glob` see real code. */
  toolsCwd: string
}

/** The omp tools a read-only seat gets (names from `omp --help` Available Tools). */
export const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'web_search'] as const

/**
 * The tool flags for a seat. `--no-tools` only covers omp's built-ins: extensions and skills
 * bring their own tools (computer_state and friends), so every seat loads neither; a read-only
 * seat then enables just the read set, auto-approved.
 */
export function toolArgs(tools: RoomAgent['tools']): string[] {
  const base = ['--no-extensions', '--no-skills']
  return tools === 'read-only'
    ? [...base, '--tools', READ_ONLY_TOOLS.join(','), '--approval-mode', 'yolo']
    : [...base, '--no-tools']
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The text of an assistant message snapshot: a string, or its text blocks joined. */
export function messageText(message: unknown): string {
  if (!isObj(message)) return ''
  const c = message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .filter(isObj)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

const DETAIL_MAX = 40

/** `path` cut from the left so the file name survives; anything else cut from the right. */
function shortArg(v: string, keepTail: boolean): string {
  const chars = Array.from(v.replace(/\s+/g, ' ').trim())
  if (chars.length <= DETAIL_MAX) return chars.join('')
  return keepTail
    ? `…${chars.slice(chars.length - DETAIL_MAX + 1).join('')}`
    : `${chars.slice(0, DETAIL_MAX - 1).join('')}…`
}

/** "reading apps/desktop/src/main/index.ts", "grep SessionManager", "searching the web". */
export function toolDetail(toolName: string, args: unknown): string {
  const a = isObj(args) ? args : {}
  const str = (k: string): string | null => (typeof a[k] === 'string' ? (a[k] as string) : null)
  switch (toolName) {
    case 'read': {
      const p = str('path')
      return p ? `reading ${shortArg(p, true)}` : 'reading a file'
    }
    case 'grep': {
      const p = str('pattern')
      return p ? `grep ${shortArg(p, false)}` : 'grep'
    }
    case 'glob': {
      const p = str('pattern') ?? str('path')
      return p ? `glob ${shortArg(p, false)}` : 'listing files'
    }
    case 'web_search': {
      const q = str('query')
      return q ? `searching the web: ${shortArg(q, false)}` : 'searching the web'
    }
    default: {
      const p = str('path') ?? str('pattern') ?? str('query') ?? str('url')
      return p ? `using ${toolName} ${shortArg(p, false)}` : `using ${toolName}`
    }
  }
}

/**
 * Presence from one omp rpc-ui frame mid-turn, or undefined when the frame says nothing about
 * it. `message_update` carries `assistantMessageEvent` (thinking_* / toolcall_* / text_*);
 * `tool_execution_start` names the tool and its args; `agent_end` is idle.
 */
export function presenceOf(f: Frame): Presence | undefined {
  switch (f.type) {
    case 'message_start':
    case 'message_update': {
      const m = f.message
      if (!isObj(m) || m.role !== 'assistant') return undefined
      const ev = isObj(f.assistantMessageEvent) ? f.assistantMessageEvent.type : undefined
      if (typeof ev === 'string') {
        if (ev.startsWith('text_')) return { state: 'typing' }
        if (ev.startsWith('thinking_') || ev.startsWith('toolcall_')) return { state: 'thinking' }
        return undefined
      }
      // No event (message_start): the snapshot's blocks say which phase begins.
      const blocks = Array.isArray(m.content) ? m.content.filter(isObj) : []
      if (blocks.some((b) => b.type === 'text' && b.text !== '')) return { state: 'typing' }
      return { state: 'thinking' }
    }
    case 'tool_execution_start': {
      const name = typeof f.toolName === 'string' ? f.toolName : 'tool'
      return { state: 'reading', detail: toolDetail(name, f.args) }
    }
    case 'tool_execution_end':
      return { state: 'thinking' }
    case 'agent_end':
      return null
    default:
      return undefined
  }
}

const STDERR_KEEP = 8

/**
 * `omp --mode rpc-ui --no-session --no-extensions --no-skills --no-lsp --no-ui --model <id> --thinking <level> --system-prompt
 * <p>` plus `--no-tools`, or `--tools read,grep,glob,web_search --approval-mode yolo` for a
 * read-only seat (run in `toolsCwd`).
 */
export class OmpAgentRunner implements AgentRunner {
  constructor(private o: OmpAgentRunnerOptions) {}

  async start(opts: AgentStart): Promise<AgentHandle> {
    const t = new OmpStdioTransport({ ompBin: this.o.ompBin, live: this.o.live })
    const stderr: string[] = []
    let exited: string | null = null
    let onExit: ((reason: string) => void) | null = null
    let stopping = false
    // One turn at a time per process; the orchestrator never overlaps sends on one agent.
    let turn: {
      resolve: (text: string) => void
      reject: (e: Error) => void
      onPartial?: (text: string) => void
      onPresence?: (p: Presence) => void
      text: string
      presence: string
    } | null = null

    const die = (reason: string): void => {
      if (exited !== null) return
      exited = reason
      turn?.reject(new Error(reason))
      turn = null
      if (!stopping) onExit?.(reason)
    }

    t.onFrame((f: Frame) => {
      if (turn) {
        const p = presenceOf(f)
        if (p !== undefined) {
          const key = JSON.stringify(p)
          if (key !== turn.presence) {
            turn.presence = key
            turn.onPresence?.(p)
          }
        }
      }
      switch (f.type) {
        case '_stderr': {
          const line = String(f.line ?? '')
          stderr.push(line)
          if (stderr.length > STDERR_KEEP) stderr.shift()
          return
        }
        case '_eof': {
          const tail = stderr
            .filter((l) => l.trim() !== '')
            .slice(-3)
            .join(' | ')
          die(tail === '' ? 'process ended' : tail)
          return
        }
        case 'message_start':
        case 'message_update':
        case 'message_end': {
          if (!turn) return
          const m = f.message
          if (!isObj(m) || m.role !== 'assistant') return
          const text = messageText(m)
          if (text !== turn.text) {
            turn.text = text
            turn.onPartial?.(text)
          }
          return
        }
        case 'agent_end': {
          if (!turn) return
          if (f.yielded === false) return
          const done = turn
          turn = null
          done.resolve(done.text)
          return
        }
        case 'prompt_result': {
          if (!turn) return
          const status = f.status
          if (status === 'completed') return
          const e = f.error
          const msg =
            isObj(e) && typeof e.message === 'string'
              ? e.message
              : status === 'aborted'
                ? 'turn aborted'
                : 'turn failed'
          const done = turn
          turn = null
          done.reject(new Error(msg))
          return
        }
        case 'response': {
          if (!turn || f.success !== false) return
          const done = turn
          turn = null
          done.reject(new Error(typeof f.error === 'string' ? f.error : 'command failed'))
          return
        }
        default:
          return
      }
    })

    await t.start({
      sessionFile: null,
      cwd: opts.tools === 'read-only' ? this.o.toolsCwd : this.o.cwd,
      args: [
        '--no-session',
        ...toolArgs(opts.tools),
        '--no-lsp',
        '--no-ui',
        '--model',
        opts.model,
        '--thinking',
        opts.thinking,
        '--system-prompt',
        opts.systemPrompt,
      ],
    })

    return {
      send: (text, hooks) => {
        const { promise, resolve, reject } = Promise.withResolvers<string>()
        if (exited !== null) {
          reject(new Error(exited))
          return promise
        }
        if (turn) {
          reject(new Error('a turn is already running'))
          return promise
        }
        turn = { resolve, reject, text: '', presence: '', ...hooks }
        t.send(text).catch((e: unknown) => {
          turn = null
          reject(e instanceof Error ? e : new Error(String(e)))
        })
        return promise
      },
      onExit: (cb) => {
        onExit = cb
      },
      stop: async () => {
        stopping = true
        await t.close({ timeoutMs: 3000 })
      },
    }
  }
}
