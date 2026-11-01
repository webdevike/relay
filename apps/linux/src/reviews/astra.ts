// Per-item Astra sessions for Reviews (evaos-electron astra-sessions.ts, on the host's omp-in-herdr
// machinery). The first @Astra ask on a PR, ticket or Slack thread launches a real omp session with
// Astra's registry profile and model in its own herdr workspace titled `Astra · <label>`, registered
// with this host's agent socket, so it is in the Agent Inbox and her approvals reach Isaac as usual.
// It is NOT her main thread: no RELAY_ASSISTANT. The seed is her prime, her thread memory, the item
// and the question; later asks go to the live session as turns, or resume its file once it ended.
// Every change of an item's session goes out as `reviews.astra`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { untagged, type AgentMessage, type AstraItem, type AstraTurn } from "@relay/protocol";
import { z } from "zod";
import type { LaunchOptions } from "../agents/herdr";
import { parseSessionRows } from "../agents/transcript";
import { loadRegistry } from "../assistant/registry";
import type { AgentProvider, AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";
import { readJson, writeJson } from "./exec";

const AGENT = "astra";
/** Streamed updates go out at most this often per item. */
const EMIT_MS = 150;
/** Where Isaac's own words start in a prompt Reviews sent; the seed above it is not shown. */
export const ASK_MARK = "\n\n---\nIsaac asks:\n";

const Store = z.record(z.string(), z.object({ title: z.string(), sessionFile: z.string().nullable(), sessionId: z.string().nullable() }));
type StoreEntry = z.infer<typeof Store>[string];

/**
 * The first message of an item session: Astra's prime, what is different about this session, her
 * thread memory, the item, then Isaac's question after `ASK_MARK`.
 */
export function seedPrompt(o: { prime: string; memory: string | null; title: string; label: string; url: string; context: string; question: string }): string {
  return `${o.prime}

---
This session is not your main thread. Isaac opened it from Reviews in Relay on his phone to talk with you about one item: ${o.label} (${o.url}). It is titled "${o.title}" and stays about that item: every @Astra question he asks on it comes here, and he reads your answers inline under the item's comment box.
Everything in your prime still holds: your scope, tools, skills, delegation, approvals, and the hard rules (Slack sends only from the desktop app, nothing posted, commented or sent on GitHub, Linear or Slack without his OK on the exact text). Three differences:
- Your thread memory is below, so skip reading it on start; do the other start reads only if you need them.
- This first message carries his question: answer it instead of replying "(nothing to report)".
- Leave work/eva/agents/astra/thread.md alone from here unless he asks.
When he wants something posted, write the exact text he could send: Reviews has a "Use as reply" button that copies your answer into the comment box, and he confirms before anything posts.

## Your thread memory (work/eva/agents/astra/thread.md)

${o.memory === null || o.memory.trim() === "" ? "(empty)" : o.memory.trim()}

## The item

${o.context.trim()}${ASK_MARK}${o.question.trim()}`;
}

/** A transcript row: the provider's `AgentMessage` or a parsed session-file row (a streamed one has no time yet). */
type Row = Pick<AgentMessage, "id" | "role" | "text" | "tool" | "streaming"> & { readonly at?: number };

/**
 * Rows as Reviews shows them: Isaac's words only (the seed above `ASK_MARK` hidden), tool rows as
 * one line; omp's notices and empty rows dropped.
 */
export function toTurns(messages: readonly Row[]): AstraTurn[] {
  const turns: AstraTurn[] = [];
  for (const m of messages) {
    const streaming = m.streaming === true;
    const at = m.at === undefined ? {} : { at: m.at };
    if (m.role === "system") continue;
    if (m.role === "user") {
      const mark = m.text.lastIndexOf(ASK_MARK);
      turns.push({ id: m.id, role: "user", text: mark >= 0 ? m.text.slice(mark + ASK_MARK.length) : m.text, streaming: false, ...at });
    } else if (m.role === "tool") {
      const line = (m.tool === undefined ? m.text : `${m.tool.name} ${m.tool.summary}`).trim().split("\n")[0] ?? "";
      if (line !== "") turns.push({ id: m.id, role: "tool", text: line, streaming, ...at });
    } else if (m.text.trim() !== "" || streaming) {
      turns.push({ id: m.id, role: "assistant", text: m.text, streaming, ...at });
    }
  }
  return turns;
}

/** How many of Isaac's turns carry `text` (a surface tag or the seed around it does not matter). */
function userTurns(turns: readonly AstraTurn[], text: string): number {
  const asked = text.trim();
  return turns.filter((t) => t.role === "user" && untagged(t.text).includes(asked)).length;
}

export interface AstraSessionsDeps {
  readonly agents: Pick<AgentProvider, "sessions" | "conversation" | "reply" | "configure">;
  /** The bridge's `launchJoined`; null when the host has no agent home. */
  readonly launch: ((options: LaunchOptions) => Promise<{ readonly joined: Promise<string> }>) | null;
  /** A live session's transcript file, when omp reported one. */
  readonly sessionFile: (sessionId: string) => string | null;
  readonly agentHome: string | null;
  /** This host's agent socket: the item's omp registers here (a test host's sessions come back to it). */
  readonly socketPath: string;
  /** `astra.json`: per item url its title, session id and file. */
  readonly storePath: string;
  readonly emit: (item: AstraItem) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

/** A launch that has not registered yet, or failed. */
interface Pending {
  readonly question: string;
  /** Epoch ms he asked. */
  readonly at: number;
  readonly starting: boolean;
  readonly error: string | null;
}

export class AstraSessions {
  private readonly store: Record<string, StoreEntry>;
  private readonly pending = new Map<string, Pending>();
  /** Streamed text per session and message id, until the message settles into the conversation. */
  private readonly streams = new Map<string, Map<string, { text: string; streaming: boolean }>>();
  private readonly timers = new Map<string, () => void>();
  /** Each item's last seen session status, so a `sessions` change pushes only the items it moved. */
  private readonly statusKeys = new Map<string, string>();
  /**
   * The newest ask per item until the session's transcript shows it (`before` = how many of his
   * turns with those words it showed when he asked). A launched omp registers before its first
   * prompt is submitted, so its first snapshots have no turns at all.
   */
  private readonly asked = new Map<string, { text: string; before: number; at: number }>();

  constructor(private readonly deps: AstraSessionsDeps) {
    const parsed = Store.safeParse(readJson(deps.storePath, {}));
    this.store = parsed.success ? parsed.data : {};
  }

  private remember(url: string, entry: StoreEntry): void {
    this.store[url] = entry;
    writeJson(this.deps.storePath, this.store);
  }

  private live(sessionId: string | null | undefined): AgentProvider["sessions"][number] | undefined {
    return sessionId === null || sessionId === undefined ? undefined : this.deps.agents.sessions.find((s) => s.id === sessionId && s.status !== "ended");
  }

  private readHome(rel: string): string | null {
    if (this.deps.agentHome === null) return null;
    try {
      return readFileSync(join(this.deps.agentHome, rel), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Isaac's question to the item's session: a turn in the live one, else a launch (resuming its
   * file, or seeded with `context()` for a first ask). Answers the item as it stands; the launch's
   * join and every later change go out through `emit`.
   */
  async ask(url: string, title: string, label: string, context: () => Promise<string>, text: string): Promise<AstraItem> {
    const launch = this.deps.launch;
    if (launch === null || this.deps.agentHome === null) throw new Error("Astra asks need the host's --agent-home");
    const saved = this.store[url];
    const live = this.live(saved?.sessionId);
    const shown = await this.snapshot(url);
    const askedAt = this.deps.clock.now();
    this.asked.set(url, { text: text.trim(), before: userTurns(shown?.turns ?? [], text), at: askedAt });
    if (live !== undefined) {
      await this.deps.agents.reply(live.id, text, true);
      return this.snapshot(url).then((item) => item ?? this.empty(url, title));
    }
    if (this.pending.get(url)?.starting === true) throw new Error("Astra is still starting on this item");
    let astra;
    try {
      astra = loadRegistry(this.deps.agentHome).find((a) => a.id === AGENT);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    if (astra === undefined) throw new Error("Astra is not in .omp/assistant/agents.json");
    const file = saved?.sessionFile != null && existsSync(saved.sessionFile) ? saved.sessionFile : null;
    let prompt = text;
    if (file === null) {
      const prime = this.readHome(join(".omp", "assistant", "agents", AGENT, "prime.md"))?.trim();
      if (!prime) throw new Error("Astra's prime (.omp/assistant/agents/astra/prime.md) is missing");
      prompt = seedPrompt({ prime, memory: this.readHome(join("work", "eva", "agents", AGENT, "thread.md")), title, label, url, context: await context(), question: text });
    }
    this.remember(url, { title, sessionFile: file, sessionId: null });
    this.pending.set(url, { question: text, at: askedAt, starting: true, error: null });
    let joined: Promise<string>;
    try {
      ({ joined } = await launch({
        prompt,
        label: title,
        // Named by the host (below), as Relay Desktop names its item sessions; omp's auto-title would rename it.
        ompArgs: ["--no-title"],
        env: { RELAY_AGENTS_SOCKET: this.deps.socketPath },
        ...(astra.profile === undefined ? {} : { profile: astra.profile }),
        ...(astra.model === undefined ? {} : { model: astra.model }),
        ...(file === null ? {} : { resume: file }),
      }));
    } catch (error) {
      const message = `Couldn't start Astra: ${error instanceof Error ? error.message : String(error)}`;
      this.pending.set(url, { question: text, at: askedAt, starting: false, error: message });
      this.schedule(url);
      throw new Error(message);
    }
    joined.then(
      (sessionId) => {
        this.pending.delete(url);
        this.remember(url, { title, sessionFile: this.deps.sessionFile(sessionId) ?? file, sessionId });
        this.deps.agents.configure({ sessionId, title }).catch((error: unknown) => {
          this.deps.log(`reviews: could not name ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.schedule(url);
      },
      (error: unknown) => {
        this.pending.set(url, { question: text, at: askedAt, starting: false, error: `Couldn't start Astra: ${error instanceof Error ? error.message : String(error)}` });
        this.schedule(url);
      },
    );
    this.deps.log(`reviews: Astra session for ${label} launching${file === null ? "" : ` (resuming ${file})`}`);
    return (await this.snapshot(url)) ?? this.empty(url, title);
  }

  private empty(url: string, title: string): AstraItem {
    return { url, title, sessionId: null, turns: [], working: false, waiting: null, error: null };
  }

  /** The item's session: live from the provider, else its file; null when it never had one. */
  async snapshot(url: string): Promise<AstraItem | null> {
    const saved = this.store[url];
    const pending = this.pending.get(url);
    if (saved === undefined && pending === undefined) return null;
    const title = saved?.title ?? "Astra";
    const live = this.live(saved?.sessionId);
    if (live !== undefined) {
      const rows: Row[] = (await this.deps.agents.conversation(live.id)) ?? [];
      const streams = this.streams.get(live.id);
      if (streams !== undefined) {
        const merged = rows.map((row) => {
          const stream = streams.get(row.id);
          return stream === undefined ? row : { ...row, ...stream };
        });
        const known = new Set(rows.map((row) => row.id));
        for (const [id, stream] of streams) if (!known.has(id)) merged.push({ id, role: "assistant", ...stream });
        rows.splice(0, rows.length, ...merged);
      }
      const detail = live.statusDetail?.trim();
      const waiting =
        live.status === "needs_permission"
          ? `Waiting for your approval${detail ? `: ${detail}` : ""}`
          : live.status === "waiting"
            ? detail !== undefined && detail !== "" ? detail : "Astra is asking you something"
            : null;
      const turns = toTurns(rows);
      const asked = this.asked.get(url);
      if (asked !== undefined && userTurns(turns, asked.text) <= asked.before) {
        // Sent, not in the transcript yet: his bubble stays and she counts as working.
        turns.push({ id: "pending", role: "user", text: asked.text, streaming: false, at: asked.at });
        return { url, title, sessionId: live.id, turns, working: true, waiting, error: null };
      }
      this.asked.delete(url);
      return { url, title, sessionId: live.id, turns, working: live.status === "working", waiting, error: null };
    }
    let rows: Row[] = [];
    if (saved?.sessionFile != null) {
      try {
        let next = 0;
        rows = parseSessionRows(readFileSync(saved.sessionFile, "utf8"), null, () => `r${String((next += 1))}`);
      } catch {
        // A missing file shows an empty session; the next ask starts a new one.
      }
    }
    const turns = toTurns(rows);
    if (pending?.starting === true) turns.push({ id: "pending", role: "user", text: pending.question, streaming: false, at: pending.at });
    return { url, title, sessionId: null, turns, working: pending?.starting === true, waiting: null, error: pending?.error ?? null };
  }

  /** Every provider change: the items whose session it touches are pushed (debounced). */
  observe(change: AgentProviderChange): void {
    if (change.kind === "gate") return;
    if (change.kind === "sessions") {
      for (const [url, entry] of Object.entries(this.store)) {
        if (entry.sessionId === null) continue;
        const live = this.live(entry.sessionId);
        if (live !== undefined) {
          const file = this.deps.sessionFile(live.id);
          if (file !== null && file !== entry.sessionFile) this.remember(url, { ...entry, sessionFile: file });
        }
        const key = live === undefined ? "gone" : `${live.status}|${live.statusDetail ?? ""}`;
        if (this.statusKeys.get(url) === key) continue;
        this.statusKeys.set(url, key);
        this.schedule(url);
      }
      return;
    }
    const url = Object.keys(this.store).find((key) => this.store[key]?.sessionId === change.sessionId);
    if (url === undefined) return;
    if (change.kind === "message") {
      const streams = this.streams.get(change.sessionId) ?? new Map<string, { text: string; streaming: boolean }>();
      streams.set(change.id, { text: change.text, streaming: change.streaming });
      this.streams.set(change.sessionId, streams);
    } else if (change.kind === "conversation") {
      const streams = this.streams.get(change.sessionId);
      for (const message of change.appended) streams?.delete(message.id);
    }
    this.schedule(url);
  }

  private schedule(url: string): void {
    if (this.timers.has(url)) return;
    this.timers.set(
      url,
      this.deps.clock.after(EMIT_MS, () => {
        this.timers.delete(url);
        this.snapshot(url).then(
          (item) => {
            if (item !== null) this.deps.emit(item);
          },
          (error: unknown) => {
            this.deps.log(`reviews: Astra item ${url}: ${error instanceof Error ? error.message : String(error)}`);
          },
        );
      }),
    );
  }

  stop(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }
}
