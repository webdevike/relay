// Reviews on the host: what waits on Isaac's reply, for Relay mobile as Relay Desktop's Reviews page
// shows it (packages/protocol/src/reviews.ts is the wire spec). Every `reviews.req` op is answered
// here; `reviews.queue` goes to every device whenever a source finishes reading or Done, a snooze or a read mark changes, and
// `reviews.astra` whenever an item's Astra session changes.
//
// Sources: GitHub (`gh`, cached 60 s), Linear (GraphQL with his key, cached 60 s), Slack (headless
// `claude -p` through the claude.ai connector's read tools, minutes per read, kept on disk and
// refreshed in the background). A failing source keeps its last rows and reports its error.
// Writes (a PR comment or review, a Linear comment, a Slack send request to Astra) leave only on
// a confirmed op, and never from a test host (`writes` false).

import { join } from "node:path";
import type { LinearTicket, ReviewApprove, ReviewItem, ReviewPr, ReviewQueue, ReviewRef, ReviewSource, ReviewSourceState, ReviewsOp, ReviewsResult, ServerMessage } from "@relay/protocol";
import { z } from "zod";
import type { AgentProvider, AgentProviderChange, DropBlob, ReviewsRelaying } from "../seams";
import type { SessionClock } from "../session";
import { approvableKey, approveLine, approveState, readLedgers, readLoop, readTicketWork, workOf } from "./approve";
import { AstraSessions, type AstraSessionsDeps } from "./astra";
import { prContext, slackContext, ticketContext } from "./context";
import { readJson, writeJson, type ToolRun } from "./exec";
import { GitHub } from "./github";
import { claudeWriter, guideCache, type GuideRead } from "./guide";
import { Linear, linearItem, linearKey, ReviewMedia, type Fetch } from "./linear";
import { sendLine, Slack, slackItem, type SlackRow } from "./slack";

/** GitHub and Linear rows are read again after this long. */
export const REVIEWS_QUEUE_TTL_MS = 60_000;
const MAX_ITEMS = 500;
/** PR and ticket details kept for an Astra seed. */
const KEEP_DETAILS = 20;
export const DRY_RUN_ERROR = "Test host: nothing was posted";

export type ReviewsMessage = Extract<ServerMessage, { t: "reviews.queue" | "reviews.astra" }>;

export interface ReviewsServiceDeps {
  /** `$XDG_CONFIG_HOME/relay/reviews`: done.json, snooze.json, read.json, guides.json, slack.json, astra.json, media/. */
  readonly dir: string;
  /** Linear's key file, Astra's registry, prime and memory; null refuses Astra asks. */
  readonly agentHome: string | null;
  /** false on a test host: every post is refused, reads stay real. */
  readonly writes: boolean;
  readonly run: ToolRun;
  readonly gh: string;
  readonly claude: string;
  readonly fetch: Fetch;
  readonly agents: Pick<AgentProvider, "sessions" | "conversation" | "reply" | "configure">;
  readonly launch: AstraSessionsDeps["launch"];
  readonly sessionFile: (sessionId: string) => string | null;
  readonly socketPath: string;
  /** Hands one line to Astra's main thread as a job message; rejects when it can't. */
  readonly tellAstra: (line: string) => Promise<void>;
  readonly broadcast: (message: ReviewsMessage) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

/** url -> epoch ms: done.json (the item's updatedAt when Done), snooze.json (until), read.json (the updatedAt seen). */
const Marks = z.record(z.string(), z.number());

function readMarks(path: string): Record<string, number> {
  const parsed = Marks.safeParse(readJson(path, {}));
  return parsed.success ? parsed.data : {};
}

/** `marks` without `url`, then with `url -> value` unless value is null. */
function setMark(marks: Readonly<Record<string, number>>, url: string, value: number | null): Record<string, number> {
  const next = Object.fromEntries(Object.entries(marks).filter(([u]) => u !== url));
  if (value !== null) next[url] = value;
  return next;
}

interface SourceSlot {
  rows: ReviewItem[];
  state: ReviewSourceState;
  reading: Promise<void> | null;
}

/** Keeps the newest `KEEP_DETAILS` entries of a detail cache. */
function keep<T>(map: Map<string, T>, key: string, value: T): T {
  map.delete(key);
  map.set(key, value);
  for (const old of map.keys()) {
    if (map.size <= KEEP_DETAILS) break;
    map.delete(old);
  }
  return value;
}

export class ReviewsService implements ReviewsRelaying {
  private readonly github: GitHub;
  private readonly linear: Linear;
  private readonly slack: Slack;
  private readonly guide: GuideRead;
  private readonly media: ReviewMedia;
  private readonly astra: AstraSessions;
  private readonly donePath: string;
  private done: Record<string, number>;
  private readonly snoozePath: string;
  private snoozed: Record<string, number>;
  private readonly readPath: string;
  private seen: Record<string, number>;
  private readonly approvedPath: string;
  private readonly slots: Record<ReviewSource, SourceSlot>;
  private readonly prs = new Map<string, ReviewPr>();
  private readonly tickets = new Map<string, LinearTicket>();

  constructor(private readonly deps: ReviewsServiceDeps) {
    this.media = new ReviewMedia(join(deps.dir, "media"));
    this.github = new GitHub(deps.run, deps.gh, { media: this.media, fetchFn: deps.fetch, linearKey: () => linearKey(deps.agentHome) });
    this.linear = new Linear(() => linearKey(deps.agentHome), this.media, deps.fetch);
    this.slack = new Slack(deps.run, deps.claude, join(deps.dir, "slack.json"), this.media);
    this.guide = guideCache(join(deps.dir, "guides.json"), claudeWriter(deps.run, deps.claude));
    this.astra = new AstraSessions({
      agents: deps.agents,
      launch: deps.launch,
      sessionFile: deps.sessionFile,
      agentHome: deps.agentHome,
      socketPath: deps.socketPath,
      storePath: join(deps.dir, "astra.json"),
      emit: (item) => {
        deps.broadcast({ t: "reviews.astra", item });
      },
      clock: deps.clock,
      log: deps.log,
    });
    this.donePath = join(deps.dir, "done.json");
    this.done = readMarks(this.donePath);
    this.snoozePath = join(deps.dir, "snooze.json");
    this.snoozed = readMarks(this.snoozePath);
    this.readPath = join(deps.dir, "read.json");
    this.seen = readMarks(this.readPath);
    this.approvedPath = join(deps.dir, "approved.json");
    const idle = (): SourceSlot => ({ rows: [], state: { loading: false, error: null, fetchedAt: null }, reading: null });
    const slack = this.slack.cached();
    this.slots = {
      github: idle(),
      linear: idle(),
      slack: slack === null ? idle() : { rows: slack.rows.map(slackItem), state: { loading: false, error: null, fetchedAt: slack.fetchedAt }, reading: null },
    };
  }

  queue(): ReviewQueue {
    const items = [...this.slots.github.rows, ...this.slots.linear.rows, ...this.slots.slack.rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ITEMS);
    const now = this.deps.clock.now();
    const snoozed = Object.fromEntries(Object.entries(this.snoozed).filter(([, until]) => until > now));
    return {
      items,
      done: { ...this.done },
      snoozed,
      read: { ...this.seen },
      sources: { github: this.slots.github.state, linear: this.slots.linear.state, slack: this.slots.slack.state },
    };
  }

  /** The queue as it stands now, to every device. */
  private pushQueue(): ReviewQueue {
    const queue = this.queue();
    this.deps.broadcast({ t: "reviews.queue", queue });
    return queue;
  }

  /** One read of a source at a time; the rows stay on failure, which sets the source's error. */
  private read(source: ReviewSource, load: () => Promise<ReviewItem[]>): Promise<void> {
    const slot = this.slots[source];
    if (slot.reading !== null) return slot.reading;
    slot.state = { ...slot.state, loading: true };
    slot.reading = load().then(
      (rows) => {
        slot.rows = rows;
        slot.state = { loading: false, error: null, fetchedAt: this.deps.clock.now() };
      },
      (error: unknown) => {
        slot.state = { ...slot.state, loading: false, error: oneLine(error) };
        this.deps.log(`reviews: ${source} read failed: ${oneLine(error)}`);
      },
    ).finally(() => {
      slot.reading = null;
      this.deps.broadcast({ t: "reviews.queue", queue: this.queue() });
    });
    return slot.reading;
  }

  private async loadQueue(refresh: boolean): Promise<ReviewQueue> {
    const now = this.deps.clock.now();
    const stale = (slot: SourceSlot): boolean => refresh || slot.state.fetchedAt === null || now - slot.state.fetchedAt > REVIEWS_QUEUE_TTL_MS;
    const reads = [
      stale(this.slots.github) ? this.read("github", () => this.github.queue()) : (this.slots.github.reading ?? Promise.resolve()),
      stale(this.slots.linear) ? this.read("linear", async () => (await this.linear.queue()).map(linearItem)) : (this.slots.linear.reading ?? Promise.resolve()),
    ];
    // Slack takes minutes: it reads in the background and is pushed when done.
    if (refresh || this.slots.slack.state.fetchedAt === null) void this.read("slack", async () => (await this.slack.readQueue()).rows.map(slackItem));
    await Promise.all(reads);
    return this.queue();
  }

  async handle(op: ReviewsOp): Promise<Omit<ReviewsResult, "rid">> {
    try {
      return { ok: true, ...(await this.run(op)) };
    } catch (error) {
      return { ok: false, error: oneLine(error) };
    }
  }

  private refuseWrites(): void {
    if (!this.deps.writes) throw new Error(DRY_RUN_ERROR);
  }

  private async run(op: ReviewsOp): Promise<Omit<ReviewsResult, "rid" | "ok">> {
    switch (op.kind) {
      case "queue":
        return { queue: await this.loadQueue(op.refresh) };
      case "pr":
        return { pr: keep(this.prs, `${op.repo}#${String(op.number)}`, await this.github.pr(op.repo, op.number)) };
      case "guide": {
        const input = await this.github.guideInput(op.repo, op.number);
        return { guide: await this.guide(`${op.repo}#${String(op.number)}`, input.headRefOid, input) };
      }
      case "linear":
        return { ticket: keep(this.tickets, op.key, await this.linear.ticket(op.key)) };
      case "slack":
        return { thread: await this.slack.thread(op.channel, op.threadTs, op.refresh) };
      case "done": {
        const next = setMark(this.done, op.url, op.done ? op.updatedAt : null);
        writeJson(this.donePath, next);
        this.done = next;
        this.pushQueue();
        return { done: { ...next } };
      }
      case "snooze": {
        // Snoozes that ran out are dropped while the file is written anyway.
        const now = this.deps.clock.now();
        const live = Object.fromEntries(Object.entries(this.snoozed).filter(([, until]) => until > now));
        const next = setMark(live, op.url, op.until !== null && op.until > now ? op.until : null);
        writeJson(this.snoozePath, next);
        this.snoozed = next;
        return { queue: this.pushQueue() };
      }
      case "read": {
        const next = setMark(this.seen, op.url, op.read ? op.updatedAt : null);
        writeJson(this.readPath, next);
        this.seen = next;
        return { queue: this.pushQueue() };
      }
      case "comment":
        this.refuseWrites();
        return { url: await this.github.comment(op.repo, op.number, op.body) };
      case "review":
        this.refuseWrites();
        await this.github.review(op.repo, op.number, op.event, op.body);
        return {};
      case "linearComment":
        this.refuseWrites();
        return { url: await this.linear.comment(op.issueId, op.parentId, op.body) };
      case "linearUpload":
        this.refuseWrites();
        return { url: await this.linear.upload(op.name, op.mime, Buffer.from(op.data, "base64")) };
      case "slackSend":
        this.refuseWrites();
        await this.deps.tellAstra(sendLine(op.channel, op.threadTs, op.text));
        return {};
      case "approvable":
        return { approve: this.approveOf(op.repo, op.number) };
      case "work": {
        const root = this.deps.agentHome;
        if (root === null) return { work: null };
        const prUrl = `https://github.com/${op.repo}/pull/${String(op.number)}`;
        return { work: workOf(readLedgers(root), prUrl, (key) => readTicketWork(root, key), this.approveOf(op.repo, op.number)) };
      }
      case "approve": {
        this.refuseWrites();
        const approve = this.approveOf(op.repo, op.number);
        if (approve === null) throw new Error("That PR is no longer waiting on your approval");
        if (approve.state !== "ready") throw new Error(`${approve.key} was already handed to Astra`);
        await this.deps.tellAstra(approveLine(approve.key));
        const sent = { ...readMarks(this.approvedPath), [approve.key]: this.deps.clock.now() };
        writeJson(this.approvedPath, sent);
        return { approve: this.approveOf(op.repo, op.number) };
      }
      case "astraAsk": {
        const label = this.label(op.ref);
        return { astra: await this.astra.ask(op.url, `Astra · ${label}`, label, () => this.context(op.ref, op.url, label), op.text) };
      }
      case "astra":
        return { astra: await this.astra.snapshot(op.url) };
      case "prList":
        return { prs: await this.github.list(op.list) };
      case "prView":
        return { view: await this.github.view(op.repo, op.number) };
    }
  }

  /** Whether `repo#number` is an auto-work draft waiting on Isaac's approve, from this host's ledgers; null when it is not. */
  private approveOf(repo: string, number: number): ReviewApprove | null {
    const root = this.deps.agentHome;
    if (root === null) return null;
    const key = approvableKey(readLedgers(root), `https://github.com/${repo}/pull/${String(number)}`);
    if (key === null) return null;
    return { key, state: approveState({ loop: readLoop(root, key), sentAt: readMarks(this.approvedPath)[key] ?? null }) };
  }

  /** The Slack row the queue has for a thread, else one made from its last read. */
  private slackRow(channel: string, threadTs: string | null, url: string): SlackRow {
    const row = this.slack.cached()?.rows.find((r) => r.channel === channel && r.threadTs === threadTs);
    if (row !== undefined) return row;
    const thread = this.slack.cachedThread(channel, threadTs);
    const last = thread?.messages.filter((m) => !m.mine).at(-1);
    return {
      kind: channel.startsWith("D") ? "dm" : "reply",
      channel,
      channelName: thread?.channelName ?? channel,
      threadTs,
      ts: last?.ts ?? "0.0",
      author: last?.author ?? "",
      text: last?.text ?? "",
      url,
      updatedAt: last?.at ?? 0,
    };
  }

  /** How an item names its Astra session: `eCardSystems/api#170`, `ENG-6406`, `#ui-ux`. */
  private label(ref: ReviewRef): string {
    if (ref.kind === "github") return `${ref.repo}#${String(ref.number)}`;
    if (ref.kind === "linear") return ref.key;
    return this.slackRow(ref.channel, ref.threadTs, "").channelName;
  }

  /** The item as Astra's seed reads it, from the detail last read (read now when there is none). */
  private async context(ref: ReviewRef, url: string, label: string): Promise<string> {
    try {
      if (ref.kind === "github") {
        const key = `${ref.repo}#${String(ref.number)}`;
        return prContext(this.prs.get(key) ?? keep(this.prs, key, await this.github.pr(ref.repo, ref.number)));
      }
      if (ref.kind === "linear") return ticketContext(this.tickets.get(ref.key) ?? keep(this.tickets, ref.key, await this.linear.ticket(ref.key)));
      return slackContext(this.slackRow(ref.channel, ref.threadTs, url), this.slack.cachedThread(ref.channel, ref.threadTs));
    } catch (error) {
      return `### ${label}\n${url}\n(The host could not read this item: ${oneLine(error)})`;
    }
  }

  openMedia(name: string, token: string): DropBlob | null {
    return this.media.open(name, token);
  }

  observe(change: AgentProviderChange): void {
    this.astra.observe(change);
  }

  stop(): void {
    this.astra.stop();
  }
}

/** A failure as the one line the phone shows. */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim().split("\n")[0] ?? "").slice(0, 2000) || "Something went wrong";
}
