// Slack in the Reviews page, driven by Astra rather than a token in the app (Isaac, 2026-10-30).
// Reading: Eva's existing read-only Slack path, the claude.ai Slack connector through headless
// `claude -p` with only the connector's read tools allowed (the same policy as
// .omp/tools/mt-autoname.ts). Answers are kept in the config dir, so the page shows the last read at
// once and refreshes on open. Sending: never from the app. A confirmed reply goes to Astra as one
// structured line (eva-thread.ts), and she posts it from the Slack desktop app.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import {
  SlackQueueSchema,
  SlackThreadSchema,
  type SlackQueue,
  type SlackRow,
  type SlackThread,
} from '@evaos/contract'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { handle } from '../ipc/handle'
import { REVIEWS_MEDIA_DIR } from './review-media'
import { slackImage } from './slack-media'

const CACHE_FILE = 'reviews-slack.json'
const KEEP_THREADS = 40
/** Files worth fetching as images (Slack's thread read names them, no type). */
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i
const READ_TIMEOUT_MS = 240_000
const WORKSPACE = 'https://ecardplatform.slack.com'

/** The connector's read tools; nothing that posts, reacts or marks read is allowed. */
export const SLACK_READ_TOOLS = [
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__claude_ai_Slack__slack_read_thread',
  'mcp__claude_ai_Slack__slack_read_channel',
  'mcp__claude_ai_Slack__slack_search_users',
]
const DENIED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'Workflow',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'PushNotification',
  'SendMessage',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ScheduleWakeup',
]

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** Slack's `1793368143.899439` as epoch ms. */
export const tsMs = (ts: string): number => Math.round(Number(ts) * 1000) || 0

/** A stable link to the thread (or DM): the row's identity for Done, and where "open" goes. */
export function slackLink(host: string, channel: string, threadTs: string | null): string {
  return threadTs
    ? `${host}/archives/${channel}/p${threadTs.replace('.', '')}`
    : `${host}/archives/${channel}`
}

export function queuePrompt(days: number, now = new Date()): string {
  const after = new Date(now.getTime() - (days + 1) * 86_400_000).toISOString().slice(0, 10)
  return `Read-only Slack lookup. Change nothing: never post, react, or mark anything read.

Find the Slack conversations from the last ${days} days that are waiting on a reply from me:
1. Find my own user id (call it ME).
2. Run these searches (newest first, read every page of results):
   a. "<@ME> after:${after}": messages that @mention me.
   b. "is:dm after:${after}": my DMs and group DMs.
   c. "from:<@ME> after:${after}": my own messages; each one in a thread is a thread I am in.
3. Read each candidate thread (or, for a DM without a thread, its recent messages). Keep it ONLY when the newest message from someone else there is newer than my newest message there. Someone else replying after a mention does not answer it for me. Ignore bots and integrations.

Reply with ONLY this JSON, no prose and no code fence:
{"me":"<my user id>","items":[{"kind":"mention|reply|dm","channel":"<channel id>","channel_name":"<#name, or the person's name for a DM, or group DM members>","thread_ts":"<thread ts, or null for a DM message outside a thread>","ts":"<ts of the newest message from someone else>","author":"<that person's display name>","text":"<that message, plain text, up to 160 characters, mentions as @Name>","permalink":"<permalink>"}]}
kind: mention when that message or the thread's parent @mentions me, dm when it is a DM or group DM, reply otherwise. Newest first. Nothing waiting: an empty items array.`
}

export function threadPrompt(channel: string, threadTs: string | null): string {
  const what = threadTs
    ? `read the thread with ts ${threadTs} in conversation ${channel} (every message, the parent first)`
    : `read the 30 most recent messages in conversation ${channel}`
  return `Read-only Slack lookup. Change nothing: never post, react, or mark anything read.

Find my own user id, then ${what}.

Reply with ONLY this JSON, no prose and no code fence:
{"me":"<my user id>","channel_name":"<#name, the person's name for a DM, or the group DM members>","messages":[{"ts":"<ts>","author":"<display name>","author_id":"<user id>","text":"<the full message as Markdown: mentions as @Name, links as [text](url), code as backticks or fenced blocks>","mentions_me":true,"reactions":[{"emoji":"<unicode emoji, or :name:>","count":1}],"files":[{"name":"<file name>","id":"<Slack file id, F...>"}]}]}
Oldest first. Never shorten a message.`
}

/** The JSON object in a model answer (it may wrap it in prose or a fence). */
function jsonIn(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw fail('slack-unreadable', 'Slack read answered no JSON')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    throw fail('slack-unreadable', 'Slack read answered broken JSON')
  }
}

const Ts = z.string().regex(/^\d+\.\d+$/)
const QueueAnswer = z.object({
  items: z.array(
    z
      .object({
        kind: z.enum(['mention', 'dm', 'reply']).catch('reply'),
        channel: z.string().regex(/^[CDG][A-Z0-9]+$/),
        channel_name: z.string().catch(''),
        thread_ts: Ts.nullable().catch(null),
        ts: Ts,
        author: z.string().catch(''),
        text: z.string().catch(''),
        permalink: z.string().catch(''),
      })
      .nullable()
      .catch(null),
  ),
})

/** The answer as rows: one per thread or DM, newest first; malformed items are dropped. */
export function toRows(answer: string): SlackRow[] {
  const parsed = QueueAnswer.safeParse(jsonIn(answer))
  if (!parsed.success) throw fail('slack-unreadable', 'Slack read answered in the wrong shape')
  const rows = new Map<string, SlackRow>()
  for (const i of parsed.data.items) {
    if (!i) continue
    const host = /^https:\/\/[\w-]+\.slack\.com/.exec(i.permalink)?.[0] ?? WORKSPACE
    const url = slackLink(host, i.channel, i.thread_ts)
    const prev = rows.get(url)
    if (prev && prev.updatedAt >= tsMs(i.ts)) continue
    rows.set(url, {
      kind: i.kind,
      channel: i.channel,
      channelName: i.channel_name || i.channel,
      threadTs: i.thread_ts,
      ts: i.ts,
      author: i.author,
      text: i.text,
      url,
      updatedAt: tsMs(i.ts),
    })
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

const ThreadAnswer = z.object({
  me: z.string().catch(''),
  channel_name: z.string().catch(''),
  messages: z.array(
    z
      .object({
        ts: Ts,
        author: z.string().catch(''),
        author_id: z.string().catch(''),
        text: z.string().catch(''),
        mentions_me: z.boolean().catch(false),
        reactions: z.array(z.object({ emoji: z.string(), count: z.number() })).catch([]),
        files: z.array(z.object({ name: z.string(), id: z.string().catch('') })).catch([]),
      })
      .nullable()
      .catch(null),
  ),
})

export function toThread(answer: string, channel: string, threadTs: string | null): SlackThread {
  const parsed = ThreadAnswer.safeParse(jsonIn(answer))
  if (!parsed.success) throw fail('slack-unreadable', 'Slack read answered in the wrong shape')
  const { me, channel_name, messages } = parsed.data
  return {
    channel,
    channelName: channel_name || channel,
    threadTs,
    messages: messages
      .flatMap((m) => (m ? [m] : []))
      .sort((a, b) => tsMs(a.ts) - tsMs(b.ts))
      .map((m) => ({
        ts: m.ts,
        author: m.author || m.author_id,
        mine: me !== '' && m.author_id === me,
        text: m.text,
        mentionsMe: m.mentions_me,
        reactions: m.reactions,
        files: m.files.map((f) => ({ name: f.name, id: f.id, image: null })),
        at: tsMs(m.ts),
      })),
    fetchedAt: Date.now(),
  }
}

/** The line Astra acts on: she posts `text` exactly, from the Slack desktop app. */
export function sendLine(channel: string, threadTs: string | null, text: string): string {
  return `Slack send request: channel=${channel} thread_ts=${threadTs ?? 'none'} text=${text}`
}

const Cache = z.object({
  queue: SlackQueueSchema.nullable().catch(null),
  threads: z.record(z.string(), SlackThreadSchema).catch({}),
})
type CacheData = z.infer<typeof Cache>

export function registerSlackInbox(
  ctx: MainContext,
  opts: {
    reads: boolean
    tellAstra: (line: string) => Promise<{ status: 'sent' | 'dry-run'; command: string }>
  },
): void {
  const home = os.homedir()
  let pathEnv: Promise<string> | null = null

  /** One headless connector read; throws with a short reason. */
  const read = async (prompt: string): Promise<string> => {
    if (!opts.reads) {
      throw fail('slack-off', 'Slack is off in this instance (EVAOS_REVIEWS_GH=1 turns it on)')
    }
    pathEnv ??= childPathFor(ctx.env.live, home)
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-slack-'))
    try {
      const cmd = buildCommand(
        ctx.env.claudeBin,
        [
          '-p',
          prompt,
          '--model',
          'sonnet',
          '--permission-mode',
          'dontAsk',
          '--allowedTools',
          'ToolSearch',
          ...SLACK_READ_TOOLS,
          '--disallowedTools',
          ...DENIED_TOOLS,
          '--output-format',
          'json',
          '--no-session-persistence',
        ],
        {
          pathEnv: await pathEnv,
          homedir: home,
          execPath: process.execPath,
          // The Habit Gate's Claude Code hook must not block an unattended read.
          baseEnv: { ...process.env, EVA_GATE_OFF: '1' },
        },
      )
      const res = await runCapture(cmd, cwd, READ_TIMEOUT_MS)
      if (res.timedOut) throw fail('slack-timeout', 'Reading Slack took too long')
      let out: unknown
      try {
        out = JSON.parse(res.stdout)
      } catch {
        throw fail('slack-failed', `claude exited ${res.code ?? 'by a signal'}`)
      }
      const reply = z
        .object({ result: z.string(), is_error: z.boolean().optional() })
        .safeParse(out)
      if (res.code !== 0 || !reply.success || reply.data.is_error) {
        throw fail(
          'slack-failed',
          reply.success ? reply.data.result.slice(0, 200) : 'No answer from the Slack connector',
        )
      }
      return reply.data.result
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }

  const mediaDir = path.join(ctx.config.dir, REVIEWS_MEDIA_DIR)

  const load = (): CacheData => {
    const c = Cache.safeParse(ctx.config.readJson<unknown>(CACHE_FILE, {}))
    return c.success ? c.data : { queue: null, threads: {} }
  }
  const save = (change: (c: CacheData) => CacheData): void => {
    const next = change(load())
    const threads = Object.entries(next.threads)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, KEEP_THREADS)
    ctx.config.writeJson(CACHE_FILE, { queue: next.queue, threads: Object.fromEntries(threads) })
  }

  // One read at a time per thing: a second open joins the read already running.
  const running = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const busy = running.get(key)
    if (busy) return busy as Promise<T>
    const p = job().finally(() => running.delete(key))
    running.set(key, p)
    return p
  }

  handle(ctx, 'reviews.slackQueue', async ({ refresh }): Promise<SlackQueue | null> => {
    if (!refresh) return load().queue
    return once('queue', async () => {
      const queue = { rows: toRows(await read(queuePrompt(7))), fetchedAt: Date.now() }
      save((c) => ({ ...c, queue }))
      return queue
    })
  })

  /** The thread with its image files fetched through Slack's app (kept files at once). */
  const withImages = async (thread: SlackThread): Promise<SlackThread> => ({
    ...thread,
    messages: await Promise.all(
      thread.messages.map(async (m) => ({
        ...m,
        files: await Promise.all(
          m.files.map(async (f) => {
            if (f.image || !f.id || !IMAGE_NAME.test(f.name)) return f
            const r = await slackImage(f.id, mediaDir)
            return 'image' in r ? { ...f, image: r.image } : f
          }),
        ),
      })),
    ),
  })

  handle(ctx, 'reviews.slackThread', async ({ channel, threadTs, refresh }) => {
    const key = `${channel}:${threadTs ?? 'dm'}`
    if (!refresh) {
      const kept = load().threads[key]
      return kept ? withImages(kept) : null
    }
    return once(key, async () => {
      const thread = await withImages(
        toThread(await read(threadPrompt(channel, threadTs)), channel, threadTs),
      )
      save((c) => ({ ...c, threads: { ...c.threads, [key]: thread } }))
      return thread
    })
  })

  handle(ctx, 'reviews.slackSend', ({ channel, threadTs, text }) =>
    opts.tellAstra(sendLine(channel, threadTs, text)),
  )
}
