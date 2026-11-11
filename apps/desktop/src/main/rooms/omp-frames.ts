// What a seat's omp process is doing, read from its rpc-ui frames: the reply text of a message
// snapshot and the presence (thinking, reading, typing) it shows while a turn runs. Council seats
// (council/seat-*.ts) share these.
import type { Frame } from '@evaos/chat-core/line-framer'
import type { RoomPresence } from '@evaos/contract'

/** What a turn is doing right now, without the clock; null is idle. */
export type Presence = Omit<RoomPresence, 'since'> | null

/** How long each step of a seat's stop waits before escalating (stdin EOF, SIGTERM, SIGKILL). */
export const STOP_STEP_MS = 3000

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
