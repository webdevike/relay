// Media that failed to render on a Relay client. Relay desktop and the phone send one `render.failed`
// frame per bubble, src and device when an image, video, audio clip or 3D model in an agent's reply
// will not show (RENDER_REPORT_FEATURE). Agents cannot see that happen, so the host closes the loop:
//
// - Every unique report (thread, bubble, src, surface) is one JSON line in
//   `$XDG_CONFIG_HOME/relay/render-failures.jsonl` (or `~/.config/relay/...`; dir 0700, file 0600),
//   whether or not the agent hears of it. The tail of that file is read back on start, so a host
//   restart neither re-logs a known failure nor tells an agent about a bubble twice.
// - The agent that wrote the bubble gets one quiet background line about it, sent once the bubble's
//   reports settle for RENDER_DEBOUNCE_MS so every failing src of the bubble (from every device that
//   reported in time) is in the same line. A bubble gets at most one line ever; later reports for it
//   are only logged (`duplicate-message`).
// - A bubble older than RENDER_STALE_MS (its ReactionKey's omp timestamp) is only logged (`stale`):
//   clients re-render old chats, and an old /drops embed whose drop the host has since evicted is not
//   the agent's to repost.
// - A thread gets at most RENDER_CAP lines per RENDER_WINDOW_MS; beyond that reports are only logged
//   (`capped`) and the last allowed line tells the agent to stop retrying. A repost is a new bubble,
//   so it can be reported once more, and the cap ends any repost cycle: no loop is possible.
//
// `assistant:<id>` threads hear it through the assistant's `say` (its `[From <Title>'s background
// jobs] ` line). `session:<id>` threads go to the assistant that runs the session, else straight to the
// live session as a `[From Relay's background jobs] ` turn (a background line: an open `ask` holds it,
// see agents/ask-hold.ts); a thread with no live owner is logged as `no-owner`.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSession, RenderFailure } from "@relay/protocol";
import { relayConfigDir } from "../host-config";
import type { SessionClock } from "../session";

/** How long a bubble's reports settle before its agent hears them, so every failing src is one line. */
export const RENDER_DEBOUNCE_MS = 2000;
/** Lines one thread's agent may get per RENDER_WINDOW_MS. */
export const RENDER_CAP = 3;
/** The rolling window RENDER_CAP counts over. */
export const RENDER_WINDOW_MS = 30 * 60_000;
/** Bubbles older than this are only logged: a re-rendered old chat is not something to repost. */
export const RENDER_STALE_MS = 2 * 60 * 60_000;
/** Lines of the log read back on start to rebuild what was already reported and told. */
export const RENDER_TAIL_LINES = 5000;

/** The prefix of a line sent straight to a non-assistant session; matches `isBackgroundLine` (agents/ask-hold.ts). */
export const RELAY_BACKGROUND_PREFIX = "[From Relay's background jobs] ";
/** What happened to a report: told in a line (`sent`, or `batched` into another report's line), or only logged. */
export type RenderDelivery = "sent" | "batched" | "capped" | "no-owner" | "duplicate-message" | "stale";

/** One line of `render-failures.jsonl`. */
export interface RenderFailureLine {
  readonly at: string;
  readonly thread: string;
  /** The assistant that owns the thread; null for a plain session or an unknown one. */
  readonly agent: string | null;
  readonly message: string;
  readonly kind: RenderFailure["kind"];
  readonly form: RenderFailure["form"];
  readonly src: string;
  readonly error: string;
  readonly surface: RenderFailure["surface"];
  readonly device: { readonly id: string; readonly name: string };
  readonly delivered: RenderDelivery;
}

/** `$XDG_CONFIG_HOME/relay/render-failures.jsonl`. */
export function defaultRenderFailuresPath(): string {
  return join(relayConfigDir(), "render-failures.jsonl");
}

const LAST_LINE = " Further render failures in this thread are only logged for 30 minutes; if the repost fails too, tell Isaac instead of retrying.";

/** The agent's line for bubble `message`'s failures; `last` when it is the thread's last allowed line in the window. */
export function renderFailureLine(message: string, failures: readonly RenderFailure[], last: boolean): string {
  const surfaces = [...new Set(failures.map((f) => f.surface))].join(" and ");
  const seen = new Set<string>();
  const items: string[] = [];
  for (const f of failures) {
    const item = `${f.kind} (${f.form}) ${f.src} (${f.error})`;
    if (seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return (
    `Render failed on ${surfaces}: ${items.join("; ")} in your message ${message}. ` +
    `Repost it in a working form: a .glb/.gltf only renders in an openui Model("/drops/<id>/<token>") block, ` +
    `images, video and audio as the markdown that share prints, https or /drops srcs only, never local paths (skill://relay-widgets). ` +
    `Reply (nothing to report) if it was already fixed.` +
    (last ? LAST_LINE : "")
  );
}

export interface RenderFailureDeps {
  readonly path: string;
  /** Assistant `id`'s thread; undefined for an unknown assistant. `say` adds its `[From <Title>'s background jobs] ` prefix. */
  readonly assistant: (id: string) => { say(text: string): Promise<void> } | undefined;
  /** The provider's current sessions. */
  readonly sessions: () => readonly AgentSession[];
  /** Delivers `text` as session `sessionId`'s next turn. */
  readonly reply: (sessionId: string, text: string) => Promise<void>;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  readonly debounceMs?: number;
  readonly cap?: number;
  readonly windowMs?: number;
  readonly staleMs?: number;
}

/** What a phone or desktop session needs: hand over one report from device `device`. */
export interface RenderFailureReporting {
  report(failure: RenderFailure, device: { readonly id: string; readonly name: string }): void;
}

interface Pending {
  readonly at: number;
  readonly failure: RenderFailure;
  readonly device: { readonly id: string; readonly name: string };
}

interface Route {
  readonly agent: string | null;
  readonly send: ((text: string) => Promise<void>) | null;
}

export class RenderFailureService implements RenderFailureReporting {
  /** thread|message|src|surface of every report logged. */
  private readonly reported = new Set<string>();
  /** thread|message of every bubble whose agent got (or was capped out of) its one line. */
  private readonly told = new Set<string>();
  /** When each thread's agent got its lines, oldest first. */
  private readonly sent = new Map<string, number[]>();
  /** Bubbles waiting out the debounce, with their reports. */
  private readonly pending = new Map<string, Pending[]>();
  private readonly debounceMs: number;
  private readonly cap: number;
  private readonly windowMs: number;
  private readonly staleMs: number;

  constructor(private readonly deps: RenderFailureDeps) {
    this.debounceMs = deps.debounceMs ?? RENDER_DEBOUNCE_MS;
    this.cap = deps.cap ?? RENDER_CAP;
    this.windowMs = deps.windowMs ?? RENDER_WINDOW_MS;
    this.staleMs = deps.staleMs ?? RENDER_STALE_MS;
    this.load();
  }

  report(failure: RenderFailure, device: { readonly id: string; readonly name: string }): void {
    const key = `${failure.thread}|${failure.message}|${failure.src}|${failure.surface}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const bubble = `${failure.thread}|${failure.message}`;
    const at = this.deps.clock.now();
    const written = Number(failure.message.slice(failure.message.indexOf("@") + 1));
    if (Number.isFinite(written) && at - written > this.staleMs) {
      this.append({ at, failure, device }, this.route(failure.thread).agent, "stale");
      return;
    }
    if (this.told.has(bubble)) {
      this.append({ at, failure, device }, this.route(failure.thread).agent, "duplicate-message");
      return;
    }
    const waiting = this.pending.get(bubble);
    if (waiting !== undefined) {
      waiting.push({ at, failure, device });
      return;
    }
    this.pending.set(bubble, [{ at, failure, device }]);
    this.deps.clock.after(this.debounceMs, () => {
      void this.flush(bubble);
    });
  }

  /** Tells the bubble's agent about every report it gathered, within the thread's cap. */
  private async flush(bubble: string): Promise<void> {
    const reports = this.pending.get(bubble);
    this.pending.delete(bubble);
    const first = reports?.[0];
    if (reports === undefined || first === undefined) return;
    const { thread, message } = first.failure;
    const route = this.route(thread);
    if (route.send === null) {
      // Not told: a report from a device that comes back while an owner runs may still reach it.
      for (const report of reports) this.append(report, route.agent, "no-owner");
      this.deps.log(`render: no live owner for ${thread}; ${reports.length} failure(s) only logged`);
      return;
    }
    this.told.add(bubble);
    const now = this.deps.clock.now();
    const times = (this.sent.get(thread) ?? []).filter((t) => now - t < this.windowMs);
    if (times.length >= this.cap) {
      this.sent.set(thread, times);
      for (const report of reports) this.append(report, route.agent, "capped");
      this.deps.log(`render: ${thread} is over its ${this.cap} lines per window; ${message} only logged`);
      return;
    }
    // The slot is taken before the send settles, so two bubbles flushing together cannot both pass the cap.
    times.push(now);
    this.sent.set(thread, times);
    const text = renderFailureLine(message, reports.map((r) => r.failure), times.length === this.cap);
    try {
      await route.send(text);
    } catch (error) {
      this.sent.set(thread, (this.sent.get(thread) ?? []).filter((t) => t !== now));
      this.told.delete(bubble);
      for (const report of reports) this.append(report, route.agent, "no-owner");
      this.deps.log(`render: cannot tell ${thread} about ${message}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    reports.forEach((report, i) => {
      this.append(report, route.agent, i === 0 ? "sent" : "batched");
    });
    this.deps.log(`render: told ${thread} about ${reports.length} failure(s) in ${message}`);
  }

  /** Who hears about `thread` and how; `send` is null when nothing live owns it. */
  private route(thread: string): Route {
    if (thread.startsWith("assistant:")) {
      const id = thread.slice("assistant:".length);
      const target = this.deps.assistant(id);
      return { agent: id, send: target === undefined ? null : (text) => target.say(text) };
    }
    const id = thread.slice("session:".length);
    const session = this.deps.sessions().find((candidate) => candidate.id === id);
    if (session === undefined) return { agent: null, send: null };
    if (session.kind === "assistant" && session.assistant !== undefined) {
      const target = this.deps.assistant(session.assistant);
      return { agent: session.assistant, send: target === undefined ? null : (text) => target.say(text) };
    }
    if (session.status === "ended") return { agent: null, send: null };
    return { agent: null, send: (text) => this.deps.reply(id, `${RELAY_BACKGROUND_PREFIX}${text}`) };
  }

  private append(report: Pending, agent: string | null, delivered: RenderDelivery): void {
    const { failure } = report;
    const line: RenderFailureLine = {
      at: new Date(report.at).toISOString(),
      thread: failure.thread,
      agent,
      message: failure.message,
      kind: failure.kind,
      form: failure.form,
      src: failure.src,
      error: failure.error,
      surface: failure.surface,
      device: { id: report.device.id, name: report.device.name },
      delivered,
    };
    try {
      mkdirSync(dirname(this.deps.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.deps.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      chmodSync(this.deps.path, 0o600);
    } catch (error) {
      this.deps.log(`render: cannot write ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Rebuilds what was reported, which bubbles were told and when each thread's lines went out, from the log's tail. */
  private load(): void {
    if (!existsSync(this.deps.path)) return;
    let lines: string[];
    try {
      lines = readFileSync(this.deps.path, "utf8").split("\n").slice(-RENDER_TAIL_LINES - 1);
    } catch (error) {
      this.deps.log(`render: cannot read ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const raw of lines) {
      if (raw.trim() === "") continue;
      let line: Partial<RenderFailureLine>;
      try {
        line = JSON.parse(raw) as Partial<RenderFailureLine>;
      } catch {
        continue;
      }
      if (typeof line.thread !== "string" || typeof line.message !== "string" || typeof line.src !== "string") continue;
      this.reported.add(`${line.thread}|${line.message}|${line.src}|${String(line.surface)}`);
      const bubble = `${line.thread}|${line.message}`;
      if (line.delivered === "sent" || line.delivered === "batched" || line.delivered === "capped") this.told.add(bubble);
      const at = typeof line.at === "string" ? Date.parse(line.at) : Number.NaN;
      if (line.delivered === "sent" && Number.isFinite(at)) this.sent.set(line.thread, [...(this.sent.get(line.thread) ?? []), at]);
    }
  }
}
