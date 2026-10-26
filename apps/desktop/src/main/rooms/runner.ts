import type { Frame } from '@evaos/chat-core/line-framer'
import { OmpStdioTransport } from '../chat/omp-transport'

/**
 * One throwaway omp process holding one persona's conversation. `send` is one turn: the prompt
 * in, the reply out, `onPartial` fed with the reply so far while it streams.
 */
export interface AgentHandle {
  send(text: string, onPartial?: (text: string) => void): Promise<string>
  /** Fires once if the process ends on its own (not through `stop`). */
  onExit(cb: (reason: string) => void): void
  stop(): Promise<void>
}

export interface AgentRunner {
  start(opts: { systemPrompt: string; model: string }): Promise<AgentHandle>
}

export interface OmpAgentRunnerOptions {
  ompBin: string
  live: boolean
  cwd: string
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

const STDERR_KEEP = 8

/** `omp --mode rpc-ui --no-session --no-tools --no-lsp --no-ui --model <id> --system-prompt <p>`. */
export class OmpAgentRunner implements AgentRunner {
  constructor(private o: OmpAgentRunnerOptions) {}

  async start(opts: { systemPrompt: string; model: string }): Promise<AgentHandle> {
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
      text: string
    } | null = null

    const die = (reason: string): void => {
      if (exited !== null) return
      exited = reason
      turn?.reject(new Error(reason))
      turn = null
      if (!stopping) onExit?.(reason)
    }

    t.onFrame((f: Frame) => {
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
      cwd: this.o.cwd,
      args: [
        '--no-session',
        '--no-tools',
        '--no-lsp',
        '--no-ui',
        '--model',
        opts.model,
        '--thinking',
        'low',
        '--system-prompt',
        opts.systemPrompt,
      ],
    })

    return {
      send: (text, onPartial) =>
        new Promise<string>((resolve, reject) => {
          if (exited !== null) {
            reject(new Error(exited))
            return
          }
          if (turn) {
            reject(new Error('a turn is already running'))
            return
          }
          turn = { resolve, reject, text: '', ...(onPartial ? { onPartial } : {}) }
          t.send(text).catch((e: unknown) => {
            turn = null
            reject(e instanceof Error ? e : new Error(String(e)))
          })
        }),
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
