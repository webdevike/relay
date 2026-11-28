// Per-item assistant sessions for the Reviews page. The first @Astra (or any registry assistant's)
// ask on a PR, ticket or Slack thread starts a real omp session with that assistant's own setup, the
// way Relay Host starts her thread (work/relay/apps/linux/src/assistant/service.ts): her registry
// profile and model, her prime as the first message, cwd the Eva root, and the desktop's omp
// integrations (relay-bridge, so the session is in the phone's Agent Inbox and her approvals reach
// Isaac as usual). It is NOT her main thread: no RELAY_ASSISTANT, which would make Relay Host take
// it for that thread. The seed adds her thread memory and the item; later asks on the item continue
// the same session (kept alive a while, then resumed from its file). Each assistant has its own
// session per item (store key `<agent>|<url>`, Astra's under the bare url as before). Every launch
// and resume only reads: ITEM_SESSION_TOOLS and no Linear or GitHub credentials, so hostile item
// text can't post or change anything. The omp process is the same OmpStdioTransport the chat panes
// run, and its frames go through the same LiveReducer.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { cmd } from '@evaos/chat-core/frames'
import type { Frame } from '@evaos/chat-core/line-framer'
import type { ChatMessage } from '@evaos/chat-core/message'
import { LiveReducer } from '@evaos/chat-core/reducer'
import { splitReplies } from '@evaos/chat-core/replies'
import { parseSession } from '@evaos/chat-core/session'
import { astraItemUrl, type AstraItem, type AstraTurn } from '@evaos/contract'
import { REGISTRY_FILE } from '../assistants/assistants'
import type { MainContext } from '../context'
import { OmpStdioTransport } from '../chat/omp-transport'
import { emit, handle } from '../ipc/handle'

const STORE_FILE = 'reviews-astra.json'
/** The empty gh config dir item sessions run with (under the app's config dir). */
const GH_CONFIG_DIR = 'reviews-assistant-gh'
const ASTRA = 'astra'
/** An idle item session's omp stays up this long after a turn, then a later ask resumes the file. */
const KEEP_MS = 30 * 60_000
/** Streamed updates go to the renderer at most this often. */
const EMIT_MS = 80
/** Where Isaac's own words start in a prompt Reviews sent; the seed above it is not shown. */
export const ASK_MARK = '\n\n---\nIsaac asks:\n'
/** The only tools an item session gets: nothing that writes, runs commands or posts. */
export const ITEM_SESSION_TOOLS = 'read,grep,glob,web_search'

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** An assistant's name before its registry entry is read: `nova` -> `Nova`. */
const named = (agent: string): string => agent.charAt(0).toUpperCase() + agent.slice(1)

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

/** Where an assistant's session on an item is kept: Astra's under the bare url (older entries too). */
export function storeKey(agent: string, url: string): string {
  return agent === ASTRA ? url : `${agent}|${url}`
}

function keyParts(key: string): { agent: string; url: string } {
  const m = /^([a-z][a-z0-9-]*)\|(.*)$/.exec(key)
  return m ? { agent: m[1] ?? ASTRA, url: m[2] ?? '' } : { agent: ASTRA, url: key }
}

/**
 * The first message of an item session: the assistant's prime, what is different about this
 * session, her thread memory, the item, then Isaac's question after `ASK_MARK`. `agent` and `name`
 * default to Astra's.
 */
export function seedPrompt(o: {
  prime: string
  memory: string | null
  title: string
  label: string
  url: string
  context: string
  question: string
  agent?: string
  name?: string
  /** The session runs with ITEM_SESSION_TOOLS and no Linear or GitHub credentials. */
  readOnly?: boolean
}): string {
  const name = o.name ?? 'Astra'
  const memoryPath = `work/eva/agents/${o.agent ?? ASTRA}/thread.md`
  const readOnly = o.readOnly
    ? `\n- This session can only read: its tools are ${ITEM_SESSION_TOOLS.split(',').join(', ')}, and it has no Linear or GitHub credentials, so nothing you do here can post, comment or change anything.`
    : ''
  return `${o.prime}

---
This session is not your main thread. Isaac opened it from his Reviews inbox in Relay Desktop to talk with you about one item: ${o.label} (${o.url}). It is titled "${o.title}" and stays about that item: every @${name} question he asks on it comes here, and he reads your answers inline under the item's comment box.
Everything in your prime still holds: your scope, tools, skills, delegation, approvals, and the hard rules (Slack sends only from the desktop app, nothing posted, commented or sent on GitHub, Linear or Slack without his OK on the exact text). ${readOnly ? 'Four' : 'Three'} differences:
- Your thread memory is below, so skip reading it on start; do the other start reads only if you need them.
- This first message carries his question: answer it instead of replying "(nothing to report)".
- Leave ${memoryPath} alone from here unless he asks.${readOnly}
When he wants something posted, write the exact text he could send: Reviews has a "Use as reply" button that copies your answer into the comment box, and he confirms before anything posts.

## Your thread memory (${memoryPath})

${o.memory?.trim() || '(empty)'}

## The item

${o.context.trim()}${ASK_MARK}${o.question.trim()}`
}

/**
 * omp flags for an item session, on a launch and a resume alike: the read-only tool allowlist, the
 * assistant's profile and model, and for a named profile the Relay integration.
 */
export function launchArgs(a: AgentConfig, agentDir: string): string[] {
  const args: string[] = ['--no-title', `--tools=${ITEM_SESSION_TOOLS}`]
  if (a.profile) {
    args.push('--profile', a.profile)
    // A named profile does not discover the shared integrations (chat/herdr.ts startArgs): the
    // baseline config and relay-bridge keep it in Relay, so approvals reach the phone.
    args.push('--config', path.join(agentDir, 'config.yml'))
    const bridge = path.join(agentDir, 'extensions', 'relay-bridge.ts')
    if (fs.existsSync(bridge)) args.push('--extension', bridge)
  }
  if (a.model) args.push('--model', a.model)
  return args
}

/** An item session's env over the app's: no provider credentials, and gh on an empty config dir. */
export function itemSessionEnv(ghConfigDir: string): Record<string, string | undefined> {
  return {
    LINEAR_API_KEY: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_CONFIG_DIR: ghConfigDir,
  }
}

/**
 * A chat row as Reviews shows it: Isaac's words only, tool rows as one line; thinking and omp's
 * notices (startup tool listings) dropped, a failure shows as the session's error instead. An
 * answer loses its trailing `[[replies: ...]]` line (cut while it streams in, too): Reviews has no
 * tap-to-answer buttons. `at` is omp's message time; a row omp has not timed yet (Isaac's prompt
 * before its echo, the streaming answer) takes the time `seen` first met it, and a tool row its
 * turn's time.
 */
export function toTurns(
  messages: readonly ChatMessage[],
  seen?: Map<string, number>,
  now = Date.now(),
): AstraTurn[] {
  const turns: AstraTurn[] = []
  let last: number | undefined
  for (const m of messages) {
    if (m.role === 'thinking' || m.role === 'canvas' || m.role === 'guest' || m.role === 'notice')
      continue
    let at = m.role === 'tool' ? undefined : (m.at ?? seen?.get(m.id))
    if (at === undefined && seen && m.role !== 'tool') {
      at = now
      seen.set(m.id, now)
    }
    at ??= last
    last = at
    const time = at === undefined ? {} : { at }
    if (m.role === 'user') {
      const mark = m.text.lastIndexOf(ASK_MARK)
      turns.push({
        id: m.id,
        role: 'user',
        text: mark >= 0 ? m.text.slice(mark + ASK_MARK.length) : m.text,
        streaming: false,
        ...time,
      })
    } else if (m.role === 'tool') {
      turns.push({ id: m.id, role: 'tool', text: m.text, streaming: m.streaming, ...time })
    } else if (m.text.trim() !== '' || m.streaming) {
      const text = splitReplies(m.text, m.streaming).text
      if (text.trim() === '' && !m.streaming) continue
      turns.push({ id: m.id, role: 'assistant', text, streaming: m.streaming, ...time })
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
  /** When this process first showed a row omp has not timed (see `toTurns`). */
  seen: Map<string, number>
  /** An ask went out and omp has not started its turn yet: she counts as working already. */
  asked: boolean
}

/**
 * The store with every entry under its item's `astraItemUrl` (per assistant): entries saved under
 * a Linear link with a workspace and slug read as the ticket's; of two for one item, the one with
 * a file wins.
 */
export function keyStore(data: StoreData): StoreData {
  const out: StoreData = {}
  for (const [saved, entry] of Object.entries(data)) {
    const { agent, url } = keyParts(saved)
    const key = storeKey(agent, astraItemUrl(url))
    if (!out[key]?.file) out[key] = entry
  }
  return out
}

/** The session file omp names in its `get_state` answer; null for any other frame. */
function reportedFile(raw: Record<string, unknown>): string | null {
  if (raw.type !== 'response' || raw.command !== 'get_state') return null
  if (typeof raw.data !== 'object' || raw.data === null) return null
  const file = (raw.data as Record<string, unknown>).sessionFile
  return typeof file === 'string' && path.isAbsolute(file) && file.endsWith('.jsonl') ? file : null
}

type ItemBase = Pick<AstraItem, 'url' | 'title' | 'agent'>

function liveItem(base: ItemBase, l: Live, name: string): AstraItem {
  const d = l.reducer.dialog
  return {
    ...base,
    file: l.file,
    turns: toTurns(l.reducer.messages(), l.seen),
    working: (l.reducer.running || l.asked) && !l.exited,
    waiting: d ? (d.kind === 'ask' ? `${name} is asking you something` : d.title) : null,
    error: l.reducer.error,
  }
}

function savedItem(base: ItemBase, file: string | null): AstraItem {
  let messages: ChatMessage[] = []
  if (file) {
    try {
      messages = parseSession(fs.readFileSync(file, 'utf8')).messages
    } catch {
      // A missing file shows an empty session; the next ask starts a new one.
    }
  }
  return { ...base, file, turns: toTurns(messages), working: false, waiting: null, error: null }
}

export function registerAstraSessions(ctx: MainContext): void {
  /** Per store key. */
  const live = new Map<string, Live>()

  const load = (): StoreData => {
    const s = Store.safeParse(ctx.config.readJson<unknown>(STORE_FILE, {}))
    return s.success ? keyStore(s.data) : {}
  }
  const remember = (key: string, title: string, file: string | null): void => {
    ctx.config.writeJson(STORE_FILE, { ...load(), [key]: { title, file } })
  }

  const agentConfig = (id: string): AgentConfig => {
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
    const a = reg.success ? reg.data.agents.find((x) => x.id === id) : undefined
    if (!a) throw fail('no-astra', `${named(id)} is not in ${REGISTRY_FILE}`)
    return a
  }

  const readText = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(ctx.env.evaRoot, rel), 'utf8')
    } catch {
      return null
    }
  }

  const ghConfigDir = (): string => {
    const dir = path.join(ctx.config.dir, GH_CONFIG_DIR)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  const snapshot = (key: string): AstraItem | null => {
    const saved = load()[key]
    const l = live.get(key)
    if (!saved && !l) return null
    const { agent, url } = keyParts(key)
    const base = { url, title: saved?.title ?? named(agent), ...(agent === ASTRA ? {} : { agent }) }
    return l ? liveItem(base, l, named(agent)) : savedItem(base, saved?.file ?? null)
  }

  const push = (key: string, now = false): void => {
    const l = live.get(key)
    const send = (): void => {
      if (l) l.emitTimer = null
      const s = snapshot(key)
      if (s) emit(ctx, 'reviews.astraUpdate', s)
    }
    if (now || !l) return send()
    if (!l.emitTimer) l.emitTimer = setTimeout(send, EMIT_MS)
  }

  const release = async (key: string): Promise<void> => {
    const l = live.get(key)
    if (!l) return
    live.delete(key)
    clearTimeout(l.idle ?? undefined)
    clearTimeout(l.emitTimer ?? undefined)
    await l.transport.close({ timeoutMs: 10_000 }).catch(() => undefined)
  }

  /** get_state names the file omp writes: the item's session from now on. */
  const noteFile = (key: string, title: string, l: Live, raw: Record<string, unknown>): void => {
    const file = l.file === null ? reportedFile(raw) : null
    if (file === null) return
    l.file = file
    remember(key, title, file)
  }

  /** One omp frame of the item's live process. */
  const onFrame = (key: string, title: string, l: Live, raw: Record<string, unknown>): void => {
    noteFile(key, title, l, raw)
    if (raw.type === '_eof') l.exited = true
    const wasRunning = l.reducer.running
    l.reducer.apply(raw)
    if (l.reducer.running || l.reducer.error) l.asked = false
    // After a turn the process waits a while for a follow-up, then lets go.
    if (wasRunning && !l.reducer.running) {
      clearTimeout(l.idle ?? undefined)
      l.idle = setTimeout(() => void release(key), KEEP_MS)
    }
    if (!l.exited) return push(key)
    live.delete(key)
    clearTimeout(l.idle ?? undefined)
    push(key, true)
  }

  /** Starts omp for the item: new (`resume` null) or resuming its file, read-only either way. */
  const start = async (
    key: string,
    title: string,
    resume: string | null,
    a: AgentConfig,
  ): Promise<Live> => {
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
      seen: new Map(),
      asked: false,
    }
    live.set(key, l)
    transport.onFrame((f: Frame) => onFrame(key, title, l, f as Record<string, unknown>))
    try {
      await transport.start({
        sessionFile: resume,
        cwd: ctx.env.evaRoot,
        args: launchArgs(a, ctx.env.agentDir),
        env: itemSessionEnv(ghConfigDir()),
      })
    } catch (e) {
      live.delete(key)
      throw fail(
        'astra-start-failed',
        `Couldn't start ${a.title}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    await transport.write(cmd.getState('evaos-state')).catch(() => undefined)
    await transport.write({ type: 'set_session_name', name: title }).catch(() => undefined)
    return l
  }

  /** A first ask with no live process: resume the item's file, or seed a new session. */
  const open = async (
    key: string,
    agent: string,
    o: { url: string; label: string; context: string; text: string },
  ): Promise<{ l: Live; prompt: string }> => {
    const a = agentConfig(agent)
    const title = `${a.title} · ${o.label}`
    const saved = load()[key]
    const file = saved?.file && fs.existsSync(saved.file) ? saved.file : null
    let prompt = o.text
    if (file === null) {
      const primePath = `.omp/assistant/agents/${agent}/prime.md`
      const prime = readText(primePath)?.trim()
      if (!prime) throw fail('no-astra', `${a.title}'s prime (${primePath}) is missing`)
      prompt = seedPrompt({
        prime,
        memory: readText(`work/eva/agents/${agent}/thread.md`),
        title,
        label: o.label,
        url: o.url,
        context: o.context,
        question: o.text,
        ...(agent === ASTRA ? {} : { agent, name: a.title }),
        readOnly: true,
      })
    }
    remember(key, title, file)
    return { l: await start(key, title, file, a), prompt }
  }

  /** The item's live process with the bare question, else `open`'s. */
  const ready = (
    key: string,
    agent: string,
    o: { url: string; label: string; context: string; text: string },
  ): Promise<{ l: Live; prompt: string }> => {
    const current = live.get(key)
    return current ? Promise.resolve({ l: current, prompt: o.text }) : open(key, agent, o)
  }

  handle(ctx, 'reviews.astraAsk', async ({ url, label, context, text, agent = ASTRA }) => {
    const key = storeKey(agent, astraItemUrl(url))
    const { l, prompt } = await ready(key, agent, { url, label, context, text })
    if (l.idle) {
      clearTimeout(l.idle)
      l.idle = null
    }
    // The prompt row shows at once; omp treats a prompt sent mid-turn as a steer.
    l.reducer.sendPrompt(prompt)
    l.asked = true
    try {
      await l.transport.send(prompt)
    } catch (e) {
      l.asked = false
      throw fail(
        'astra-send-failed',
        `Couldn't reach ${named(agent)}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    push(key, true)
    return snapshot(key)!
  })

  handle(ctx, 'reviews.astraThread', ({ url, agent = ASTRA }) =>
    snapshot(storeKey(agent, astraItemUrl(url))),
  )

  handle(ctx, 'reviews.astraRelease', async ({ url, agent = ASTRA }) => {
    const key = storeKey(agent, astraItemUrl(url))
    const l = live.get(key)
    if (!l || l.reducer.running) return { released: false }
    await release(key)
    return { released: true }
  })

  handle(ctx, 'reviews.astraStop', async ({ url, agent = ASTRA }) => {
    const l = live.get(storeKey(agent, astraItemUrl(url)))
    if (!l || !l.reducer.running) return { stopped: false }
    await l.transport.abort()
    return { stopped: true }
  })

  ctx.onBeforeQuit(async () => {
    await Promise.all([...live.keys()].map((key) => release(key)))
  })
}
