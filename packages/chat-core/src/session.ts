import { imageSize } from './image-size'
import { makeMessage, type ChatImage, type ChatMessage, type SessionMeta } from './message'

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** `text` without a leading `<surface>...</surface>` tag from any client. */
export function untagged(text: string): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('<surface>')) return text
  const end = trimmed.indexOf('</surface>')
  if (end < 0) return text
  return trimmed.slice(end + '</surface>'.length).replace(/^[\r\n]+/, '')
}

/** `text` on one line, cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const line = text.split(/\s+/).filter(Boolean).join(' ')
  const chars = Array.from(line)
  if (chars.length <= max) return line
  return chars.slice(0, max - 1).join('') + '…'
}

function toolSummary(args: unknown): string {
  if (!isObj(args)) return ''
  for (const key of ['i', 'path', 'command', 'pattern', 'url', 'query', 'title']) {
    const v = str(args[key])
    if (v) return oneLine(v, 120)
  }
  return ''
}

/** A tool's input as the expanded row shows it: the command or code it carries, else its arguments without intent and path. */
function toolInput(args: unknown): string {
  if (!isObj(args)) return ''
  const command = str(args.command)
  if (command) return command
  const code = str(args.code)
  if (code) return code
  const rest: Json = {}
  for (const [k, v] of Object.entries(args)) if (k !== 'i' && k !== 'path') rest[k] = v
  return Object.keys(rest).length === 0 ? '' : JSON.stringify(rest, null, 2)
}

function contextTokens(message: Json): number | null {
  const snap = message.contextSnapshot
  if (isObj(snap) && typeof snap.promptTokens === 'number') return snap.promptTokens
  const usage = message.usage
  if (isObj(usage) && typeof usage.input === 'number') {
    const cr = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0
    const cw = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0
    return usage.input + cr + cw
  }
  return null
}

const BLOB_TOKEN = /^blob:sha256:[a-f0-9]{64}$/
const HEADER_B64_CHARS = 87_380 // ~64 KB decoded, a multiple of 4

/** The renderable shape of one `image` content part. Only png, jpeg, gif and webp ever get a `src`. */
export function imageFrom(part: Json, n: number): ChatImage {
  const label = `Image ${n + 1}`
  const data = str(part.data)
  if (data === undefined) return { label }
  if (BLOB_TOKEN.test(data)) {
    const mimeType = str(part.mimeType)
    return { label, src: data, ...(mimeType !== undefined ? { mimeType } : {}) }
  }
  try {
    const head = data.slice(0, HEADER_B64_CHARS)
    const size = imageSize(Uint8Array.from(atob(head), (c) => c.charCodeAt(0)))
    if (size === null) return { label }
    return {
      label,
      src: `data:${size.mime};base64,${data}`,
      mimeType: size.mime,
      width: size.width,
      height: size.height,
    }
  } catch {
    return { label }
  }
}

const imagesOf = (content: unknown): ChatImage[] =>
  arr(content)
    .filter(isObj)
    .filter((p) => p.type === 'image')
    .map((p, n) => imageFrom(p, n))

/**
 * A prompt Isaac wrote, without decoding its images: the untagged text parts joined and how many
 * images it carries. Null for agent-authored and empty prompts.
 */
export function promptText(message: Json): { text: string; images: number } | null {
  if (message.role !== 'user') return null
  if ((str(message.attribution) ?? 'user') !== 'user') return null
  const content = message.content
  let text: string
  let images = 0
  if (typeof content === 'string') {
    text = content
  } else {
    const parts = arr(content).filter(isObj)
    text = parts
      .filter((p) => p.type === 'text')
      .map((p) => str(p.text))
      .filter((t): t is string => t !== undefined)
      .join('\n\n')
    images = parts.filter((p) => p.type === 'image').length
  }
  text = untagged(text)
  return text.trim() !== '' || images > 0 ? { text, images } : null
}

/** A prompt Isaac wrote: its text parts joined. Null for agent-authored and empty prompts. */
function promptParts(message: Json): { text: string; images: ChatImage[] } | null {
  const prompt = promptText(message)
  if (prompt === null) return null
  return { text: prompt.text, images: prompt.images > 0 ? imagesOf(message.content) : [] }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  const pieces: string[] = []
  for (const part of arr(content)) {
    if (!isObj(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text)
    else if (part.type === 'image') pieces.push('[image]')
  }
  return pieces.join('\n\n')
}

/** omp's timestamp of a message (epoch ms), when it has one. */
function stampOf(message: Json): { at?: number } {
  const at = message.timestamp
  return typeof at === 'number' && Number.isFinite(at) ? { at } : {}
}

export function messagesFrom(message: Json, id: string): ChatMessage[] {
  if (message.role === 'user') {
    const prompt = promptParts(message)
    if (!prompt) return []
    return [makeMessage(id, 'user', prompt.text, { images: prompt.images, ...stampOf(message) })]
  }
  if (message.role !== 'assistant') return []
  const out: ChatMessage[] = []
  const parts = arr(message.content).filter(isObj)
  const thinking = parts
    .filter((p) => p.type === 'thinking')
    .map((p) => str(p.thinking)?.trim() ?? '')
    .filter((t) => t !== '')
  if (thinking.length > 0)
    out.push(makeMessage(`${id}-thinking`, 'thinking', thinking.join('\n\n')))
  const text = textOf(message.content)
  if (text.trim() !== '') out.push(makeMessage(id, 'assistant', text, stampOf(message)))
  parts
    .filter((p) => p.type === 'toolCall')
    .forEach((call, n) => {
      const name = str(call.name) ?? 'tool'
      out.push(
        makeMessage(`${id}-tool${n}`, 'tool', name, {
          detail: toolSummary(call.arguments),
          tool: {
            call: str(call.id) ?? '',
            input: toolInput(call.arguments),
            result: null,
            isError: false,
            status: 'running',
          },
        }),
      )
    })
  const error = str(message.errorMessage)
  if (message.stopReason === 'error' && error !== undefined) {
    out.push(makeMessage(`${id}-error`, 'notice', `Error: ${oneLine(error, 240)}`))
  }
  return out
}

/** Puts a `toolResult` message's output on the tool row it answers. False when it is not one, or no row shows its call. */
export function attachResult(messages: ChatMessage[], message: Json): boolean {
  if (message.role !== 'toolResult') return false
  const call = str(message.toolCallId)
  if (call === undefined) return false
  const row = [...messages].reverse().find((m) => m.tool?.call === call)
  if (!row?.tool) return false
  const content = message.content
  const text =
    typeof content === 'string'
      ? [content]
      : arr(content)
          .filter(isObj)
          .filter((p) => p.type === 'text')
          .map((p) => str(p.text))
          .filter((t): t is string => t !== undefined)
  const isError = message.isError === true
  const images = imagesOf(content)
  if (images.length > 0) row.images = images
  row.tool = {
    ...row.tool,
    result: text.join('\n\n'),
    isError,
    status: isError ? 'failed' : 'done',
  }
  return true
}

export interface ParsedSession {
  messages: ChatMessage[]
  meta: SessionMeta
  title: string
  /** omp's name for the session: the last `title` record (a rename appends one), else null. */
  named: string | null
}

/** Port of Rust `session()` for omp session files: the active branch only. */
export function parseSession(text: string): ParsedSession {
  const records: Json[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (isObj(v)) records.push(v)
    } catch {
      // malformed line: skipped
    }
  }
  const entries = records.filter((r) => typeof r.id === 'string')
  const byId = new Map<string, Json>()
  for (const e of entries) byId.set(e.id as string, e)

  const branch: Json[] = []
  const seen = new Set<Json>()
  let next: Json | undefined = entries[entries.length - 1]
  while (next && !seen.has(next)) {
    seen.add(next)
    branch.push(next)
    const parent = str(next.parentId)
    next = parent !== undefined ? byId.get(parent) : undefined
  }
  branch.reverse()

  const meta: SessionMeta = { model: null, thinking: null, contextTokens: null }
  for (const entry of branch) {
    if (entry.type === 'model_change') {
      const model = str(entry.model)
      const slash = model?.indexOf('/') ?? -1
      if (model !== undefined && slash > 0)
        meta.model = [model.slice(0, slash), model.slice(slash + 1)]
    } else if (entry.type === 'thinking_level_change') {
      meta.thinking = str(entry.thinkingLevel) ?? null
    } else if (
      entry.type === 'message' &&
      isObj(entry.message) &&
      entry.message.role === 'assistant'
    ) {
      const m = entry.message
      const provider = str(m.provider)
      const id = str(m.model)
      if (provider !== undefined && id !== undefined) meta.model = [provider, id]
      const tokens = contextTokens(m)
      if (tokens !== null) meta.contextTokens = tokens
    }
  }

  const messages: ChatMessage[] = []
  for (const entry of branch) {
    if (entry.type !== 'message' || !isObj(entry.message)) continue
    if (!attachResult(messages, entry.message)) {
      messages.push(...messagesFrom(entry.message, str(entry.id) ?? ''))
    }
  }

  // A rename appends a title record, so the last one is the session's name now.
  const named = records.findLast((r) => r.type === 'title' && str(r.title))?.title
  let title = typeof named === 'string' ? named : ''
  for (const r of title === '' ? records.slice(0, 4) : []) {
    if (r.type === 'session') {
      const t = str(r.title)
      if (t) {
        title = t
        break
      }
    }
  }
  if (title === '') {
    const first = messages.find((m) => m.role === 'user')
    if (first) title = Array.from(first.text.trim()).slice(0, 60).join('')
  }
  return { messages, meta, title, named: typeof named === 'string' ? named : null }
}
