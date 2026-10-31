// Per-item Astra sessions for the Reviews page. The first @Astra ask on a PR, ticket or Slack thread
// starts a real omp session with Astra's own setup, the way Relay Host starts her thread
// (work/relay/apps/linux/src/assistant/service.ts): her registry profile and model, her prime as
// the first message, cwd the Eva root, and the desktop's omp integrations (relay-bridge, so the
// session is in the phone's Agent Inbox and her approvals reach Isaac as usual). It is NOT her main
// thread: no RELAY_ASSISTANT, which would make Relay Host take it for that thread. The seed adds
// her thread memory and the item; later asks on the item continue the same session (kept alive a
// while, then resumed from its file). The omp process is the same OmpStdioTransport the chat panes
// run, and its frames go through the same LiveReducer.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { cmd } from '@evaos/chat-core/frames'
import type { Frame } from '@evaos/chat-core/line-framer'
import type { ChatMessage } from '@evaos/chat-core/message'
import { LiveReducer } from '@evaos/chat-core/reducer'
import { parseSession } from '@evaos/chat-core/session'
import type { AstraItem, AstraTurn } from '@evaos/contract'
import { REGISTRY_FILE } from '../assistants/assistants'
import type { MainContext } from '../context'
import { OmpStdioTransport } from '../chat/omp-transport'
import { emit, handle } from '../ipc/handle'

const STORE_FILE = 'reviews-astra.json'
const AGENT = 'astra'
/** An idle item session's omp stays up this long after a turn, then a later ask resumes the file. */
const KEEP_MS = 30 * 60_000
/** Streamed updates go to the renderer at most this often. */
const EMIT_MS = 80
/** Where Isaac's own words start in a prompt Reviews sent; the seed above it is not shown. */
export const ASK_MARK = '\n\n---\nIsaac asks:\n'

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

const Registry = z.object({
  agents: z.array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        profile: z.enum(['personal', 'work']).optional().catch(undefined),
        model: z.string().optional().catch(undefined),
      })
      .passthrough(),
  ),
})
type AgentConfig = z.infer<typeof Registry>['agents'][number]

const Store = z.record(z.string(), z.object({ title: z.string(), file: z.string().nullable() }))
type StoreData = z.infer<typeof Store>

/**
 * The first message of an item session: Astra's prime, what is different about this session, her
 * thread memory, the item, then Isaac's question after `ASK_MARK`.
 */
export function seedPrompt(o: {
  prime: string
  memory: string | null
  title: string
  label: string
  url: string
  context: string
  question: string
}): string {
  return `${o.prime}

---
This session is not your main thread. Isaac opened it from his Reviews inbox in Relay Desktop to talk with you about one item: ${o.label} (${o.url}). It is titled "${o.title}" and stays about that item: every @Astra question he asks on it comes here, and he reads your answers inline under the item's comment box.
Everything in your prime still holds: your scope, tools, skills, delegation, approvals, and the hard rules (Slack sends only from the desktop app, nothing posted, commented or sent on GitHub, Linear or Slack without his OK on the exact text). Three differences:
- Your thread memory is below, so skip reading it on start; do the other start reads only if you need them.
- This first message carries his question: answer it instead of replying "(nothing to report)".
- Leave work/eva/agents/astra/thread.md alone from here unless he asks.
When he wants something posted, write the exact text he could send: Reviews has a "Use as reply" button that copies your answer into the comment box, and he confirms before anything posts.

## Your thread memory (work/eva/agents/astra/thread.md)

${o.memory?.trim() || '(empty)'}

## The item

${o.context.trim()}${ASK_MARK}${o.question.trim()}`
}

/**
 * A chat row as Reviews shows it: Isaac's words only, tool rows as one line; thinking and omp's
 * notices (startup tool listings) dropped, a failure shows as the session's error instead.
 */
export function toTurns(messages: readonly ChatMessage[]): AstraTurn[] {
  const turns: AstraTurn[] = []
  for (const m of messages) {
    if (m.role === 'thinking' || m.role === 'canvas' || m.role === 'notice') continue
    if (m.role === 'user') {
      const at = m.text.lastIndexOf(ASK_MARK)
      turns.push({
        id: m.id,
        role: 'user',
        text: at >= 0 ? m.text.slice(at + ASK_MARK.length) : m.text,
        streaming: false,
      })
    } else if (m.role === 'tool') {
      turns.push({ id: m.id, role: 'tool', text: m.text, streaming: m.streaming })
    } else if (m.text.trim() !== '' || m.streaming) {
      turns.push({ id: m.id, role: 'assistant', text: m.text, streaming: m.streaming })
    }
  }
  return turns
}

interface Live {
  transport: OmpStdioTransport
  reducer: LiveReducer
  file: string | null
  idle: ReturnType<typeof setTimeout> | null
  emitTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

export function registerAstraSessions(ctx: MainContext): void {
  const live = new Map<string, Live>()

  const load = (): StoreData => {
    const s = Store.safeParse(ctx.config.readJson<unknown>(STORE_FILE, {}))
    return s.success ? s.data : {}
  }
  const remember = (url: string, title: string, file: string | null): void => {
    ctx.config.writeJson(STORE_FILE, { ...load(), [url]: { title, file } })
  }

  const agent = (): AgentConfig => {
    let text = ''
    try {
      text = fs.readFileSync(path.join(ctx.env.evaRoot, REGISTRY_FILE), 'utf8')
    } catch {
      // Reported below.
    }
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      // Reported below.
    }
    const reg = Registry.safeParse(json)
    const a = reg.success ? reg.data.agents.find((x) => x.id === AGENT) : undefined
    if (!a) throw fail('no-astra', `Astra is not in ${REGISTRY_FILE}`)
    return a
  }

  const readText = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(ctx.env.evaRoot, rel), 'utf8')
    } catch {
      return null
    }
  }

  /** omp flags for Astra: her profile and model, and for a named profile the Relay integration. */
  const launchArgs = (a: AgentConfig): string[] => {
    const args: string[] = ['--no-title']
    if (a.profile) {
      args.push('--profile', a.profile)
      // A named profile does not discover the shared integrations (chat/herdr.ts startArgs): the
      // baseline config and relay-bridge keep it in Relay, so approvals reach the phone.
      args.push('--config', path.join(ctx.env.agentDir, 'config.yml'))
      const bridge = path.join(ctx.env.agentDir, 'extensions', 'relay-bridge.ts')
      if (fs.existsSync(bridge)) args.push('--extension', bridge)
    }
    if (a.model) args.push('--model', a.model)
    return args
  }

  const snapshot = (url: string): AstraItem | null => {
    const saved = load()[url]
    const l = live.get(url)
    if (!saved && !l) return null
    const title = saved?.title ?? 'Astra'
    if (l) {
      const d = l.reducer.dialog
      return {
        url,
        title,
        file: l.file,
        turns: toTurns(l.reducer.messages()),
        working: l.reducer.running && !l.exited,
        waiting: d ? (d.kind === 'ask' ? 'Astra is asking you something' : d.title) : null,
        error: l.reducer.error,
      }
    }
    let messages: ChatMessage[] = []
    if (saved?.file) {
      try {
        messages = parseSession(fs.readFileSync(saved.file, 'utf8')).messages
      } catch {
        // A missing file shows an empty session; the next ask starts a new one.
      }
    }
    return {
      url,
      title,
      file: saved?.file ?? null,
      turns: toTurns(messages),
      working: false,
      waiting: null,
      error: null,
    }
  }

  const push = (url: string, now = false): void => {
    const l = live.get(url)
    const send = (): void => {
      if (l) l.emitTimer = null
      const s = snapshot(url)
      if (s) emit(ctx, 'reviews.astraUpdate', s)
    }
    if (now || !l) return send()
    if (!l.emitTimer) l.emitTimer = setTimeout(send, EMIT_MS)
  }

  const release = async (url: string): Promise<void> => {
    const l = live.get(url)
    if (!l) return
    live.delete(url)
    clearTimeout(l.idle ?? undefined)
    clearTimeout(l.emitTimer ?? undefined)
    await l.transport.close({ timeoutMs: 10_000 }).catch(() => undefined)
  }

  /** Starts omp for the item: new (`resume` null) or resuming its file. */
  const start = async (url: string, title: string, resume: string | null): Promise<Live> => {
    const a = agent()
    const transport = new OmpStdioTransport({ ompBin: ctx.env.ompBin, live: ctx.env.live })
    let history: ChatMessage[] = []
    if (resume) {
      try {
        history = parseSession(fs.readFileSync(resume, 'utf8')).messages
      } catch {
        // Its turns come back from omp as it goes.
      }
    }
    const l: Live = {
      transport,
      reducer: new LiveReducer(history, { model: null, thinking: null, contextTokens: null }),
      file: resume,
      idle: null,
      emitTimer: null,
      exited: false,
    }
    live.set(url, l)
    transport.onFrame((f: Frame) => {
      const raw = f as Record<string, unknown> & { type?: unknown }
      // get_state names the file omp writes: the item's session from now on.
      if (
        l.file === null &&
        raw.type === 'response' &&
        raw.command === 'get_state' &&
        typeof raw.data === 'object' &&
        raw.data !== null
      ) {
        const file = (raw.data as Record<string, unknown>).sessionFile
        if (typeof file === 'string' && path.isAbsolute(file) && file.endsWith('.jsonl')) {
          l.file = file
          remember(url, title, file)
        }
      }
      if (raw.type === '_eof') l.exited = true
      const wasRunning = l.reducer.running
      l.reducer.apply(raw)
      // After a turn the process waits a while for a follow-up, then lets go.
      if (wasRunning && !l.reducer.running) {
        clearTimeout(l.idle ?? undefined)
        l.idle = setTimeout(() => void release(url), KEEP_MS)
      }
      if (l.exited) {
        live.delete(url)
        clearTimeout(l.idle ?? undefined)
        push(url, true)
        return
      }
      push(url)
    })
    try {
      await transport.start({ sessionFile: resume, cwd: ctx.env.evaRoot, args: launchArgs(a) })
    } catch (e) {
      live.delete(url)
      throw fail(
        'astra-start-failed',
        `Couldn't start Astra: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    await transport.write(cmd.getState('evaos-state')).catch(() => undefined)
    await transport.write({ type: 'set_session_name', name: title }).catch(() => undefined)
    return l
  }

  handle(ctx, 'reviews.astraAsk', async ({ url, label, context, text }) => {
    const title = `Astra · ${label}`
    const saved = load()[url]
    let l = live.get(url)
    let prompt = text
    if (!l) {
      const file = saved?.file && fs.existsSync(saved.file) ? saved.file : null
      if (file === null) {
        const prime = readText(`.omp/assistant/agents/${AGENT}/prime.md`)?.trim()
        if (!prime)
          throw fail('no-astra', "Astra's prime (.omp/assistant/agents/astra/prime.md) is missing")
        prompt = seedPrompt({
          prime,
          memory: readText(`work/eva/agents/${AGENT}/thread.md`),
          title,
          label,
          url,
          context,
          question: text,
        })
      }
      remember(url, title, file)
      l = await start(url, title, file)
    }
    if (l.idle) {
      clearTimeout(l.idle)
      l.idle = null
    }
    // The prompt row shows at once; omp treats a prompt sent mid-turn as a steer.
    l.reducer.sendPrompt(prompt)
    try {
      await l.transport.send(prompt)
    } catch (e) {
      throw fail(
        'astra-send-failed',
        `Couldn't reach Astra: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    push(url, true)
    return snapshot(url)!
  })

  handle(ctx, 'reviews.astraThread', ({ url }) => snapshot(url))

  handle(ctx, 'reviews.astraRelease', async ({ url }) => {
    const l = live.get(url)
    if (!l || l.reducer.running) return { released: false }
    await release(url)
    return { released: true }
  })

  ctx.onBeforeQuit(async () => {
    await Promise.all([...live.keys()].map((url) => release(url)))
  })
}
