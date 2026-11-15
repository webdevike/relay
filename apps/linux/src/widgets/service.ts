// Reply widgets and widget training (@relay/protocol REPLY_WIDGETS_FEATURE, WIDGET_TRAINING_FEATURE).
//
// After an assistant's final reply in its thread has gone out (`AssistantService` calls `reply` once
// the turn ends, so the text reply never waits), the host asks the atomic-agents `widget` specialist
// (`widget/widget.requested` -> `widget/widget.ready` over its journal, `bus.ts`) which widget, if
// any, the reply should have. It skips voice-call turns and replies that already hold a widget
// fence. The mode is `components.widget.mode` in the service's live `config.json`, read on every
// reply so a switch needs no restart:
//   - "shadow" (the default): log the suggestion only, to `<home>/bench/widget/shadow.jsonl` and a
//     `widget/widget.logged` event;
//   - "live": the same log, and an ```openui answer is kept for that reply and sent to every device
//     as the thread's `widgets.snapshot`, which shows it under the reply;
//   - "off" (or the component disabled): nothing is asked.
// No answer within ASK_TIMEOUT_MS is logged as a timeout and nothing is shown.
//
// 🎯 on a reply opens a one-question sheet on the device; its answer (`widget.label`) is saved with
// the reply, what was shown under it and the shadow suggestion to `<home>/bench/widget/training.jsonl`,
// which the widget bench loads as cases, plus a `widget/widget.labeled` event.
//
// The specialist only picks a widget for a finished reply: it never sees tools, delegation or approvals.

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MAX_REPLY_WIDGET, ReactionKey, reactionExcerpt, WIDGET_LABEL_TEXT, type ServerMessage, type ThreadWidgets, type WidgetLabel, type WidgetSurface } from "@relay/protocol";
import { ask, emit, readConfig, type AskAnswer } from "./bus";

/** How long a reply waits for its widget; later answers are dropped (the package logs them as usual). */
export const ASK_TIMEOUT_MS = 3_000;
/** A desktop with input this recent means Isaac reads on the desktop; otherwise on his phone. */
export const DESKTOP_RECENT_MS = 5 * 60_000;
/** Suggestions kept per thread, newest first. */
const MAX_PER_THREAD = 200;

export type WidgetMode = "shadow" | "live" | "off";

/** `components.widget` of the service's config.json: disabled is off; no mode (or no file) is shadow. */
export function widgetMode(config: unknown): WidgetMode {
  const widget = z
    .object({ components: z.object({ widget: z.object({ enabled: z.boolean().optional(), mode: z.enum(["shadow", "live", "off"]).optional() }).passthrough() }).passthrough() })
    .passthrough()
    .safeParse(config);
  if (!widget.success) return "shadow";
  const { enabled, mode } = widget.data.components.widget;
  return enabled === false ? "off" : (mode ?? "shadow");
}

const WIDGET_FENCE = /^[ \t]*```(?:openui|ui|html-widget|mantine-widget)[ \t]*\n[\s\S]*?^[ \t]*```[ \t]*$/m;
const WIDGET_FENCE_OPEN = /^[ \t]*```(?:openui|ui|html-widget|mantine-widget)[ \t]*$/m;

/** The first widget fence of a reply (the fence lines included), or null; an unclosed one counts as a widget too. */
export function widgetFence(text: string): string | null {
  return WIDGET_FENCE.exec(text)?.[0].trim() ?? (WIDGET_FENCE_OPEN.test(text) ? text.slice(text.search(WIDGET_FENCE_OPEN)).trim() : null);
}

/** Whether Isaac's turn asks for depth (cheap words only; no model call). */
export function askedForDetail(turn: string): boolean {
  return /\b(?:in detail|details?|detailed|break\s*(?:it\s+)?down|breakdown|deep[- ]dive|walk me through|show me|full (?:list|breakdown|picture))\b/i.test(turn);
}

/** Where Isaac reads now: the desktop when one had input within DESKTOP_RECENT_MS, else his phone. */
export function surfaceOf(desktops: readonly { readonly lastInputAt: number | null }[], now: number): WidgetSurface {
  return desktops.some((desktop) => desktop.lastInputAt !== null && now - desktop.lastInputAt <= DESKTOP_RECENT_MS) ? "desktop" : "phone";
}

/** An assistant's last reply of a finished turn, as its thread shows it. */
export interface FinishedReply {
  readonly agent: string;
  readonly sessionId: string;
  /** The reply's `ReactionKey`. */
  readonly message: string;
  readonly text: string;
  /** Isaac's turn it answers; null when the turn was a job line or is not in the thread. */
  readonly turn: { readonly text: string; readonly voice: boolean } | null;
}

const Suggestion = z.object({
  kind: z.enum(["openui", "none", "timeout"]),
  block: z.string().optional(),
  why: z.string().optional(),
  mode: z.enum(["shadow", "live"]),
  /** Shown under the reply (live mode, an openui answer). */
  shown: z.boolean(),
  at: z.number(),
});
type Suggestion = z.infer<typeof Suggestion>;

const WidgetState = z.object({ threads: z.record(z.string(), z.record(z.string(), Suggestion)).default({}) });
type WidgetState = z.infer<typeof WidgetState>;

/** `$XDG_CONFIG_HOME/relay/reply-widgets.json`. */
export function defaultReplyWidgetsPath(): string {
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "relay", "reply-widgets.json");
}

export interface ReplyWidgetServiceDeps {
  /** The atomic-agents home (`defaultAtomicAgentsHome`): journal, config.json, bench files. The host builds this service only when it exists. */
  readonly home: string;
  /** Where the suggestions per reply are kept (`defaultReplyWidgetsPath`). */
  readonly path: string;
  /** Where Isaac reads now (`surfaceOf` the remote-control desktops). */
  readonly surface: () => WidgetSurface;
  /** The full text of reply `message` of `thread` as the thread shows it; null when it is gone. */
  readonly message: (thread: string, message: string) => Promise<string | null>;
  /** Sends `message` to every authenticated device. */
  readonly broadcast: (message: ServerMessage) => void;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Asks the widget agent over the bus; defaults to `ask` on `home`'s journal with ASK_TIMEOUT_MS. A test seam. */
  readonly ask?: (request: Readonly<Record<string, unknown>>) => Promise<AskAnswer>;
}

/** Isaac's 🎯 answer on reply `message` of `thread` (a `widget.label` frame). */
export interface WidgetLabelInput {
  readonly thread: string;
  readonly message: string;
  readonly label: WidgetLabel;
  readonly surface: WidgetSurface;
  readonly excerpt: string;
}

/** `ok` false when the label could not be saved; `error` says why. */
export interface WidgetLabelResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** What a device session needs of the reply widgets. */
export interface ReplyWidgetRelaying {
  /** `thread`'s widgets shown under its replies, by reply key. */
  snapshot(thread: string): ThreadWidgets;
  /** Saves Isaac's 🎯 answer on reply `message` of `thread` as a bench case. */
  label(input: WidgetLabelInput): Promise<WidgetLabelResult>;
}

export class ReplyWidgetService implements ReplyWidgetRelaying {
  private state: WidgetState;

  constructor(private readonly deps: ReplyWidgetServiceDeps) {
    this.state = this.load();
  }

  snapshot(thread: string): ThreadWidgets {
    const widgets: ThreadWidgets = {};
    for (const [key, suggestion] of Object.entries(this.state.threads[thread] ?? {})) {
      if (suggestion.shown && suggestion.block !== undefined) widgets[key] = suggestion.block;
    }
    return widgets;
  }

  /** Asks for `reply`'s widget and logs (shadow) or shows (live) the answer. Resolves when done; never rejects. */
  async reply(reply: FinishedReply): Promise<void> {
    const mode = widgetMode(readConfig(this.deps.home));
    if (mode === "off") return;
    const tag = `widgets: ${reply.agent} ${reply.message}`;
    const skip = reply.turn?.voice === true ? "voice-call turn" : widgetFence(reply.text) !== null ? "the reply has its own widget" : null;
    if (skip !== null) {
      this.deps.log(`${tag}: ${skip}, skipped`);
      return;
    }
    const surface = this.deps.surface();
    const context = { channel: "text" as const, askedForDetail: askedForDetail(reply.turn?.text ?? "") };
    const started = this.deps.now();
    let answer: AskAnswer;
    try {
      const request = { draft: reply.text, surface, context };
      answer = await (this.deps.ask?.(request) ?? ask(this.deps.home, "widget", { request: "widget.requested", reply: "widget.ready" }, request, { timeoutMs: ASK_TIMEOUT_MS }));
    } catch (error) {
      this.deps.log(`${tag}: cannot ask the widget agent: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const ms = this.deps.now() - started;
    const ready = answer.reply;
    const block = typeof ready?.["block"] === "string" && ready["block"].length <= MAX_REPLY_WIDGET ? ready["block"] : undefined;
    const kind = ready === null ? "timeout" : ready["kind"] === "openui" && block !== undefined ? "openui" : "none";
    const why = typeof ready?.["why"] === "string" ? ready["why"] : undefined;
    const shown = mode === "live" && kind === "openui";
    const thread = `assistant:${reply.agent}`;
    this.keep(thread, reply.message, { kind, ...(block === undefined ? {} : { block }), ...(why === undefined ? {} : { why }), mode, shown, at: this.deps.now() });
    if (shown) this.deps.broadcast({ t: "widgets.snapshot", thread, widgets: this.snapshot(thread) });
    try {
      this.append("shadow.jsonl", {
        at: new Date(this.deps.now()).toISOString(),
        mode,
        agent: reply.agent,
        thread,
        message: reply.message,
        surface,
        context,
        draftHash: createHash("sha256").update(reply.text).digest("hex").slice(0, 16),
        excerpt: reactionExcerpt(reply.text),
        kind,
        ...(block === undefined ? {} : { block }),
        ...(why === undefined ? {} : { why }),
        ms,
        requestId: answer.requestId,
        shown,
      });
      emit(this.deps.home, "widget", "widget.logged", { requestId: answer.requestId, mode, agent: reply.agent, message: reply.message, surface, kind, ms, shown });
    } catch (error) {
      this.deps.log(`${tag}: cannot log the suggestion: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.deps.log(`${tag}: ${mode} ${kind} in ${String(ms)} ms${shown ? ", shown" : ""}`);
  }

  async label(input: WidgetLabelInput): Promise<WidgetLabelResult> {
    if (!input.thread.startsWith("assistant:") || !input.message.startsWith("assistant@")) return { ok: false, error: "only an assistant's reply in its thread can be labeled" };
    const agent = input.thread.slice("assistant:".length);
    try {
      const draft = (await this.deps.message(input.thread, input.message)) ?? input.excerpt;
      const own = widgetFence(draft);
      const kept = this.state.threads[input.thread]?.[input.message];
      const shown =
        own !== null
          ? { kind: "openui", source: "reply", block: own }
          : kept?.shown === true && kept.block !== undefined
            ? { kind: "openui", source: "widget", block: kept.block }
            : { kind: "none" };
      this.append("training.jsonl", {
        at: new Date(this.deps.now()).toISOString(),
        agent,
        thread: input.thread,
        message: input.message,
        surface: input.surface,
        label: input.label,
        answer: WIDGET_LABEL_TEXT[input.label],
        excerpt: input.excerpt,
        draft,
        shown,
        ...(kept === undefined ? {} : { suggestion: { kind: kept.kind, mode: kept.mode, ...(kept.block === undefined ? {} : { block: kept.block }), ...(kept.why === undefined ? {} : { why: kept.why }) } }),
      });
      emit(this.deps.home, "widget", "widget.labeled", { agent, message: input.message, surface: input.surface, label: input.label, shown: shown.kind });
      this.deps.log(`widgets: ${agent} ${input.message} labeled ${input.label}`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`widgets: cannot save the label on ${input.thread} ${input.message}: ${message}`);
      return { ok: false, error: message };
    }
  }

  private append(file: string, record: Record<string, unknown>): void {
    const path = join(this.deps.home, "bench", "widget", file);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  }

  private keep(thread: string, message: string, suggestion: Suggestion): void {
    if (!ReactionKey.safeParse(message).success) return;
    const entries = Object.entries({ ...this.state.threads[thread], [message]: suggestion })
      .sort(([a], [b]) => Number(b.slice(b.indexOf("@") + 1)) - Number(a.slice(a.indexOf("@") + 1)))
      .slice(0, MAX_PER_THREAD);
    this.state.threads = { ...this.state.threads, [thread]: Object.fromEntries(entries) };
    this.save();
  }

  private load(): WidgetState {
    const empty: WidgetState = { threads: {} };
    if (!existsSync(this.deps.path)) return empty;
    try {
      const parsed = WidgetState.safeParse(JSON.parse(readFileSync(this.deps.path, "utf8")));
      if (parsed.success) return parsed.data;
      this.deps.log(`widgets: ${this.deps.path} is not a reply widgets file; starting empty`);
    } catch (error) {
      this.deps.log(`widgets: cannot read ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return empty;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.deps.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.deps.path);
    } catch (error) {
      this.deps.log(`widgets: cannot save ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
