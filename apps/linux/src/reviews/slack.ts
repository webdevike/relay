// Slack in Reviews (evaos-electron slack-inbox.ts), read through Eva's read-only Slack path: the
// claude.ai Slack connector in headless `claude -p` with only the connector's read tools allowed
// (the policy of .omp/tools/mt-autoname.ts). Answers are kept in
// `$XDG_CONFIG_HOME/relay/reviews/slack.json`, so a device sees the last read at once. Sending is
// never done here: a confirmed reply goes to Astra's main thread as one `sendLine`, and she posts it
// from the Slack desktop app.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackThread, type ReviewItem } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson, type ToolRun } from "./exec";
import type { ReviewMedia } from "./linear";
import { slackImage } from "./media";

const KEEP_THREADS = 40;
const READ_TIMEOUT_MS = 240_000;
const WORKSPACE = "https://ecardplatform.slack.com";
/** Files worth fetching as images (Slack's thread read names them, no type). */
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;

/** The connector's read tools; nothing that posts, reacts or marks read is allowed. */
export const SLACK_READ_TOOLS = [
  "mcp__claude_ai_Slack__slack_search_public_and_private",
  "mcp__claude_ai_Slack__slack_read_thread",
  "mcp__claude_ai_Slack__slack_read_channel",
  "mcp__claude_ai_Slack__slack_search_users",
];
const DENIED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "Workflow",
  "Monitor",
  "CronCreate",
  "CronDelete",
  "RemoteTrigger",
  "PushNotification",
  "SendMessage",
  "EnterWorktree",
  "ExitWorktree",
  "DesignSync",
  "ScheduleWakeup",
];

/** Slack's `1793368143.899439` as epoch ms. */
export const tsMs = (ts: string): number => Math.round(Number(ts) * 1000) || 0;

/** A stable link to the thread (or DM): the row's identity for Done, and where "open" goes. */
export function slackLink(host: string, channel: string, threadTs: string | null): string {
  return threadTs ? `${host}/archives/${channel}/p${threadTs.replace(".", "")}` : `${host}/archives/${channel}`;
}

export function queuePrompt(days: number, now = new Date()): string {
  const after = new Date(now.getTime() - (days + 1) * 86_400_000).toISOString().slice(0, 10);
  return `Read-only Slack lookup. Change nothing: never post, react, or mark anything read.

Find the Slack conversations from the last ${String(days)} days that are waiting on a reply from me:
1. Find my own user id (call it ME).
2. Run these searches (newest first, read every page of results):
   a. "<@ME> after:${after}": messages that @mention me.
   b. "is:dm after:${after}": my DMs and group DMs.
   c. "from:<@ME> after:${after}": my own messages; each one in a thread is a thread I am in.
3. Read each candidate thread (or, for a DM without a thread, its recent messages). Keep it ONLY when the newest message from someone else there is newer than my newest message there. Someone else replying after a mention does not answer it for me. Ignore bots and integrations.

Reply with ONLY this JSON, no prose and no code fence:
{"me":"<my user id>","items":[{"kind":"mention|reply|dm","channel":"<channel id>","channel_name":"<#name, or the person's name for a DM, or group DM members>","thread_ts":"<thread ts, or null for a DM message outside a thread>","ts":"<ts of the newest message from someone else>","author":"<that person's display name>","text":"<that message, plain text, up to 160 characters, mentions as @Name>","permalink":"<permalink>"}]}
kind: mention when that message or the thread's parent @mentions me, dm when it is a DM or group DM, reply otherwise. Newest first. Nothing waiting: an empty items array.`;
}

export function threadPrompt(channel: string, threadTs: string | null): string {
  const what = threadTs
    ? `read the thread with ts ${threadTs} in conversation ${channel} (every message, the parent first)`
    : `read the 30 most recent messages in conversation ${channel}`;
  return `Read-only Slack lookup. Change nothing: never post, react, or mark anything read.

Find my own user id, then ${what}.

Reply with ONLY this JSON, no prose and no code fence:
{"me":"<my user id>","channel_name":"<#name, the person's name for a DM, or the group DM members>","messages":[{"ts":"<ts>","author":"<display name>","author_id":"<user id>","text":"<the full message as Markdown: mentions as @Name, links as [text](url), code as backticks or fenced blocks>","mentions_me":true,"reactions":[{"emoji":"<unicode emoji, or :name:>","count":1}],"files":[{"name":"<file name>","id":"<Slack file id, F...>"}]}]}
Oldest first. Never shorten a message.`;
}

/** The JSON object in a model answer (it may wrap it in prose or a fence). */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Slack read answered no JSON");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Slack read answered broken JSON");
  }
}

const Ts = z.string().regex(/^\d+\.\d+$/);
const QueueAnswer = z.object({
  items: z.array(
    z
      .object({
        kind: z.enum(["mention", "dm", "reply"]).catch("reply"),
        channel: z.string().regex(/^[CDG][A-Z0-9]+$/),
        channel_name: z.string().catch(""),
        thread_ts: Ts.nullable().catch(null),
        ts: Ts,
        author: z.string().catch(""),
        text: z.string().catch(""),
        permalink: z.string().catch(""),
      })
      .nullable()
      .catch(null),
  ),
});

/** One thread or DM waiting on Isaac, as the connector reported it. */
export const SlackRow = z.object({
  kind: z.enum(["mention", "dm", "reply"]),
  channel: z.string(),
  channelName: z.string(),
  threadTs: z.string().nullable(),
  ts: z.string(),
  author: z.string(),
  text: z.string(),
  url: z.string(),
  updatedAt: z.number(),
});
export type SlackRow = z.infer<typeof SlackRow>;

/** The answer as rows: one per thread or DM, newest first; malformed items are dropped. */
export function toRows(answer: string): SlackRow[] {
  const parsed = QueueAnswer.safeParse(jsonIn(answer));
  if (!parsed.success) throw new Error("Slack read answered in the wrong shape");
  const rows = new Map<string, SlackRow>();
  for (const i of parsed.data.items) {
    if (!i) continue;
    const host = /^https:\/\/[\w-]+\.slack\.com/.exec(i.permalink)?.[0] ?? WORKSPACE;
    const url = slackLink(host, i.channel, i.thread_ts);
    const prev = rows.get(url);
    if (prev && prev.updatedAt >= tsMs(i.ts)) continue;
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
    });
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

const REASON: Record<SlackRow["kind"], string> = { mention: "mentioned you", dm: "asked you", reply: "replied" };

export function slackItem(row: SlackRow): ReviewItem {
  return {
    url: row.url,
    ref: { kind: "slack", channel: row.channel, threadTs: row.threadTs },
    title: row.text,
    actor: row.author,
    reason: REASON[row.kind],
    label: row.threadTs !== null && !row.channel.startsWith("D") ? row.channelName : "DM",
    updatedAt: row.updatedAt,
    unread: true,
    slackKind: row.kind,
  };
}

const ThreadAnswer = z.object({
  me: z.string().catch(""),
  channel_name: z.string().catch(""),
  messages: z.array(
    z
      .object({
        ts: Ts,
        author: z.string().catch(""),
        author_id: z.string().catch(""),
        text: z.string().catch(""),
        mentions_me: z.boolean().catch(false),
        reactions: z.array(z.object({ emoji: z.string(), count: z.number() })).catch([]),
        files: z.array(z.object({ name: z.string(), id: z.string().catch("") })).catch([]),
      })
      .nullable()
      .catch(null),
  ),
});

export function toThread(answer: string, channel: string, threadTs: string | null): SlackThread {
  const parsed = ThreadAnswer.safeParse(jsonIn(answer));
  if (!parsed.success) throw new Error("Slack read answered in the wrong shape");
  const { me, channel_name, messages } = parsed.data;
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
        mine: me !== "" && m.author_id === me,
        text: m.text,
        mentionsMe: m.mentions_me,
        reactions: m.reactions,
        files: m.files.map((f) => f.name),
        attachments: m.files.map((f) => ({ name: f.name, id: f.id, src: null })),
        at: tsMs(m.ts),
      })),
    fetchedAt: Date.now(),
  };
}

/** The line Astra acts on: she posts `text` exactly, from the Slack desktop app. */
export function sendLine(channel: string, threadTs: string | null, text: string): string {
  return `Slack send request: channel=${channel} thread_ts=${threadTs ?? "none"} text=${text}`;
}

const Cache = z.object({
  queue: z.object({ rows: z.array(SlackRow), fetchedAt: z.number() }).nullable().catch(null),
  threads: z.record(z.string(), SlackThread).catch({}),
});
type CacheData = z.infer<typeof Cache>;

export class Slack {
  /** One read at a time per thing: a second open joins the read already running. */
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly run: ToolRun,
    private readonly claude: string,
    private readonly file: string,
    /** Where Slack's images are kept; without it files stay chips. */
    private readonly media?: ReviewMedia,
  ) {}

  /** One headless connector read; throws with a short reason. */
  private async read(prompt: string): Promise<string> {
    const cwd = mkdtempSync(join(tmpdir(), "relay-slack-"));
    try {
      const res = await this.run(
        [
          this.claude,
          "-p",
          prompt,
          "--model",
          "sonnet",
          "--permission-mode",
          "dontAsk",
          "--allowedTools",
          "ToolSearch",
          ...SLACK_READ_TOOLS,
          "--disallowedTools",
          ...DENIED_TOOLS,
          "--output-format",
          "json",
          "--no-session-persistence",
        ],
        // The Habit Gate's Claude Code hook must not block an unattended read.
        { cwd, timeoutMs: READ_TIMEOUT_MS, env: { EVA_GATE_OFF: "1" } },
      );
      if (res.timedOut) throw new Error("Reading Slack took too long");
      let out: unknown;
      try {
        out = JSON.parse(res.stdout);
      } catch {
        throw new Error(`claude exited ${res.code === null ? "by a signal" : String(res.code)}`);
      }
      const reply = z.object({ result: z.string(), is_error: z.boolean().optional() }).safeParse(out);
      if (res.code !== 0 || !reply.success || reply.data.is_error === true) {
        throw new Error(reply.success ? reply.data.result.slice(0, 200) : "No answer from the Slack connector");
      }
      return reply.data.result;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  private load(): CacheData {
    const c = Cache.safeParse(readJson(this.file, {}));
    return c.success ? c.data : { queue: null, threads: {} };
  }

  private save(change: (c: CacheData) => CacheData): void {
    const next = change(this.load());
    const threads = Object.entries(next.threads)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, KEEP_THREADS);
    writeJson(this.file, { queue: next.queue, threads: Object.fromEntries(threads) });
  }

  private once<T>(key: string, job: () => Promise<T>): Promise<T> {
    const busy = this.running.get(key);
    if (busy) return busy as Promise<T>;
    const p = job().finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  /** The last read queue; null before the first. */
  cached(): CacheData["queue"] {
    return this.load().queue;
  }

  get reading(): boolean {
    return this.running.has("queue");
  }

  /** A fresh queue read (joins one already running), kept on success. */
  readQueue(): Promise<NonNullable<CacheData["queue"]>> {
    return this.once("queue", async () => {
      const queue = { rows: toRows(await this.read(queuePrompt(7))), fetchedAt: Date.now() };
      this.save((c) => ({ ...c, queue }));
      return queue;
    });
  }

  /**
   * The thread with its images' host paths, fetched through the Slack app (kept files at once). Run
   * on every answer: a path's token lives only as long as this host process.
   */
  private async withImages(thread: SlackThread): Promise<SlackThread> {
    const media = this.media;
    if (media === undefined) return thread;
    return {
      ...thread,
      messages: await Promise.all(
        thread.messages.map(async (m) => ({
          ...m,
          attachments: await Promise.all(
            m.attachments.map(async (a) => ({
              ...a,
              src: a.id !== "" && IMAGE_NAME.test(a.name) ? await slackImage(a.id, media) : null,
            })),
          ),
        })),
      ),
    };
  }

  /** The last read thread, or (`refresh`, or never read) a fresh read. */
  async thread(channel: string, threadTs: string | null, refresh: boolean): Promise<SlackThread> {
    const key = `${channel}:${threadTs ?? "dm"}`;
    const hit = this.load().threads[key];
    if (!refresh && hit !== undefined) return this.withImages(hit);
    return this.once(key, async () => {
      const thread = toThread(await this.read(threadPrompt(channel, threadTs)), channel, threadTs);
      this.save((c) => ({ ...c, threads: { ...c.threads, [key]: thread } }));
      return this.withImages(thread);
    });
  }

  /** The thread as last read, without reading (its text: Astra's context, a row's title). */
  cachedThread(channel: string, threadTs: string | null): SlackThread | null {
    return this.load().threads[`${channel}:${threadTs ?? "dm"}`] ?? null;
  }
}
