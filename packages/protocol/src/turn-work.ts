import { z } from "zod";

/**
 * A look at an assistant's work behind one reply ("peek behind the curtain"): the turn's thinking
 * and its tool steps, folded from the omp transcript the host already keeps. Nothing of it rides
 * on `assistant.snapshot`: a client asks for one turn at a time (`assistant.work.req`), and for
 * a step's full input and output, or the turn's full thinking, only when Isaac opens it
 * (`detail`). Only sent to a host whose `welcome.features` has ASSISTANT_WORK_FEATURE.
 *
 * A turn runs from a user message (Isaac's, or a job line) to the next one; omp's synthetic user
 * messages (reminders it adds itself) stay inside the turn. Times come from the transcript: a
 * message's `timestamp` is when it started, an assistant message's `duration` is how long the model
 * took on it, and a tool result's `timestamp` is when the tool finished. A tool starts when the
 * assistant message that called it ends.
 */

export const ASSISTANT_WORK_FEATURE = "assistant.work";
/** Steps one answer carries; a longer turn leaves its oldest out and counts them (`earlier`). */
export const MAX_WORK_STEPS = 120;
/** Characters of the thinking excerpt a turn's answer carries. */
export const THINKING_EXCERPT = 400;
/** Characters of a step's title, summary and output line. */
export const MAX_STEP_LINE = 120;
/** Characters of a detail text (a step's input or output, the turn's whole thinking). */
export const MAX_WORK_DETAIL = 32_000;
/** `detail` naming the turn's whole thinking rather than a step. */
export const THINKING_DETAIL = "thinking";

const ms = z.number().finite();

export const TurnStepStatus = z.enum(["running", "done", "failed"]);
export type TurnStepStatus = z.infer<typeof TurnStepStatus>;

/** One tool call of a turn. */
export const TurnStep = z.object({
  /** The tool call's id, what `detail` takes. */
  id: z.string().min(1).max(200),
  tool: z.string().min(1).max(100),
  /** What the call is for, in words (omp's intent); empty when it gave none. */
  title: z.string().max(MAX_STEP_LINE),
  /** One line of its input: the command, the path, the pattern. */
  summary: z.string().max(MAX_STEP_LINE),
  startedAt: ms,
  /** When its result came in; absent while it runs, and for a call that never got one. */
  endedAt: ms.optional(),
  status: TurnStepStatus,
  /** The first line of its output. */
  output: z.string().max(MAX_STEP_LINE).optional(),
});
export type TurnStep = z.infer<typeof TurnStep>;

/** One turn's work as a client shows it. */
export const TurnWork = z.object({
  /** When the turn started (its user message); a client asks for the same turn again with it. */
  at: ms,
  /** When its last message ended; absent while it runs. */
  endedAt: ms.optional(),
  running: z.boolean(),
  /** Time the model spent on the turn's messages (thinking and writing), not counting tools. */
  modelMs: z.number().nonnegative(),
  /** The turn's thinking: an excerpt (the first block once done, the newest while it runs) and the whole length. */
  thinking: z
    .object({
      excerpt: z.string().max(THINKING_EXCERPT + 1),
      chars: z.number().int().nonnegative(),
    })
    .optional(),
  /** While it runs: the model at work (thinking or writing) or tools running, since when. */
  now: z.object({ kind: z.enum(["model", "tools"]), since: ms }).optional(),
  /** The newest `MAX_WORK_STEPS` tool calls, in order. */
  steps: z.array(TurnStep).max(MAX_WORK_STEPS),
  /** Tool calls before `steps[0]` left out. */
  earlier: z.number().int().nonnegative().optional(),
});
export type TurnWork = z.infer<typeof TurnWork>;

/** A step's full input and output (`detail` = its id), or the turn's whole thinking (`detail` = THINKING_DETAIL) in `text`. */
export const TurnWorkDetail = z.object({
  input: z
    .string()
    .max(MAX_WORK_DETAIL + 1)
    .optional(),
  output: z
    .string()
    .max(MAX_WORK_DETAIL + 1)
    .optional(),
  text: z
    .string()
    .max(MAX_WORK_DETAIL + 1)
    .optional(),
  failed: z.boolean().optional(),
  /** Some text was cut to MAX_WORK_DETAIL. */
  truncated: z.boolean().optional(),
});
export type TurnWorkDetail = z.infer<typeof TurnWorkDetail>;

// ---------------------------------------------------------------------------------------------
// The fold: omp transcript messages (each session-file `message` entry's `message`) to turns.
// ---------------------------------------------------------------------------------------------

/** A tool call as the fold reads it from an assistant message. */
export interface WorkCall {
  readonly id: string;
  readonly name: string;
  readonly intent: string;
  readonly args: Record<string, unknown>;
}

/** The fields of one transcript message the fold reads; `workMessageOf` makes them. */
export interface WorkMessage {
  readonly role: "user" | "assistant" | "toolResult";
  /** Its `timestamp` (ms). */
  readonly at: number;
  /** Assistant: how long the model took on it (ms). */
  readonly durationMs: number;
  /** Assistant: its thinking blocks. */
  readonly thinking: readonly string[];
  /** Assistant: its tool calls. */
  readonly calls: readonly WorkCall[];
  /** Tool result: the call it answers, whether it failed, its content. */
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly content?: unknown;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The fold's view of one omp transcript message, or null for one that is not a turn's (custom,
 * bash execution, a message without a timestamp) and for a synthetic user message, which omp adds
 * itself mid-turn and so never starts one.
 */
export function workMessageOf(raw: unknown): WorkMessage | null {
  if (!isObj(raw) || typeof raw["timestamp"] !== "number") return null;
  const at = raw["timestamp"];
  const content = raw["content"];
  switch (raw["role"]) {
    case "user":
      if (raw["synthetic"] === true) return null;
      return { role: "user", at, durationMs: 0, thinking: [], calls: [] };
    case "toolResult":
      return {
        role: "toolResult",
        at,
        durationMs: 0,
        thinking: [],
        calls: [],
        toolCallId: str(raw["toolCallId"]),
        isError: raw["isError"] === true,
        content,
      };
    case "assistant": {
      const thinking: string[] = [];
      const calls: WorkCall[] = [];
      for (const part of Array.isArray(content) ? (content as unknown[]) : []) {
        if (!isObj(part)) continue;
        if (part["type"] === "thinking" && str(part["thinking"]).trim() !== "")
          thinking.push(str(part["thinking"]));
        if (part["type"] === "toolCall" && str(part["id"]) !== "" && str(part["name"]) !== "") {
          const args = isObj(part["arguments"]) ? part["arguments"] : {};
          calls.push({
            id: str(part["id"]),
            name: str(part["name"]),
            intent: str(part["intent"]) || str(args["i"]),
            args,
          });
        }
      }
      const duration = raw["duration"];
      return {
        role: "assistant",
        at,
        durationMs:
          typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : 0,
        thinking,
        calls,
      };
    }
    default:
      return null;
  }
}

/** When `message` ended (whole ms): an assistant message after its model time, anything else at its timestamp. */
function endOf(message: WorkMessage): number {
  return Math.round(message.at + message.durationMs);
}

/** `text` on one line, whitespace runs collapsed, cut to `max` with an ellipsis. */
export function oneLine(text: string, max = MAX_STEP_LINE): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The first non-blank line of `text`, cut to `max`. */
function firstLineOf(text: string, max = MAX_STEP_LINE): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return oneLine(line, max);
}

/** A hashline edit's file header (`[path#1A2B]`) or an apply_patch file line. */
const EDIT_HEADER = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$|^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$/m;

/** One line of a call's input as the step row shows it under its title: the command, the file, the pattern, the query. */
export function stepSummary(name: string, args: Record<string, unknown>): string {
  for (const key of [
    "command",
    "path",
    "file_path",
    "notebook_path",
    "url",
    "query",
    "goal",
    "app",
  ]) {
    const value = str(args[key]);
    if (key === "path" && name === "grep" && str(args["pattern"]) !== "")
      return oneLine(`${str(args["pattern"])} ${value}`.trim());
    if (value.trim() !== "") return firstLineOf(value);
  }
  const input = str(args["input"]);
  const header = EDIT_HEADER.exec(input);
  if (header !== null) return oneLine(header[1] ?? header[2] ?? "");
  const pattern = str(args["pattern"]);
  if (pattern !== "") return oneLine(pattern);
  const code = str(args["code"]);
  if (code !== "") return firstLineOf(code);
  const tasks = args["tasks"];
  if (Array.isArray(tasks)) return tasks.length === 1 ? "1 task" : `${String(tasks.length)} tasks`;
  for (const [key, value] of Object.entries(args))
    if (key !== "i" && typeof value === "string" && value.trim() !== "") return firstLineOf(value);
  return "";
}

/** The text of a tool result's content: its text parts joined, an image as `[image]`. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content as unknown[]) {
    if (!isObj(part)) continue;
    if (part["type"] === "text") parts.push(str(part["text"]));
    else if (part["type"] === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/**
 * The turn of `messages` holding time `at` (a row's `at`: the message at or before it), as
 * [start, end): from the user message that opened it to the next. Null `at` takes the newest
 * turn; null when there are no messages.
 */
export function turnBounds(
  messages: readonly WorkMessage[],
  at: number | null,
): { start: number; end: number } | null {
  if (messages.length === 0) return null;
  let anchor = messages.length - 1;
  if (at !== null) {
    anchor = -1;
    for (const [i, message] of messages.entries()) if (message.at <= at) anchor = i;
    if (anchor === -1) anchor = 0;
  }
  let start = anchor;
  while (start > 0 && messages[start]?.role !== "user") start -= 1;
  let end = anchor + 1;
  while (end < messages.length && messages[end]?.role !== "user") end += 1;
  return { start, end };
}

/** Cuts `text` to `max` characters, saying whether it did. */
function capped(text: string, max = MAX_WORK_DETAIL): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text, cut: false };
}

/**
 * The work of the turn holding `at` (null: the newest). `live` says the transcript is the running
 * session's and that session is working now: then the newest turn is the running one, its calls
 * without a result are running and `now` says what is underway. `now` is the clock.
 */
export function foldTurnWork(
  messages: readonly WorkMessage[],
  at: number | null,
  live: boolean,
): TurnWork | null {
  const bounds = turnBounds(messages, at);
  if (bounds === null) return null;
  const turn = messages.slice(bounds.start, bounds.end);
  const first = turn[0];
  const last = turn.at(-1);
  if (first === undefined || last === undefined) return null;
  const running = live && bounds.end === messages.length;
  const results = new Map<string, WorkMessage>();
  for (const message of turn)
    if (message.role === "toolResult" && message.toolCallId !== undefined)
      results.set(message.toolCallId, message);
  const steps: TurnStep[] = [];
  const thinking: string[] = [];
  let modelMs = 0;
  let pending = false;
  for (const message of turn) {
    if (message.role !== "assistant") continue;
    modelMs += message.durationMs;
    thinking.push(...message.thinking);
    for (const call of message.calls) {
      const result = results.get(call.id);
      if (result === undefined && running) pending = true;
      const output = result === undefined ? "" : firstLineOf(resultText(result.content));
      steps.push({
        id: call.id,
        tool: call.name.slice(0, 100),
        title: oneLine(call.intent),
        summary: stepSummary(call.name, call.args),
        startedAt: endOf(message),
        ...(result === undefined ? {} : { endedAt: result.at }),
        status:
          result === undefined
            ? running
              ? "running"
              : "done"
            : result.isError === true
              ? "failed"
              : "done",
        ...(output === "" ? {} : { output }),
      });
    }
  }
  const excerptOf = running ? thinking.at(-1) : thinking[0];
  const earlier = Math.max(0, steps.length - MAX_WORK_STEPS);
  return {
    at: first.at,
    ...(running ? {} : { endedAt: endOf(last) }),
    running,
    modelMs: Math.round(modelMs),
    ...(excerptOf === undefined
      ? {}
      : {
          thinking: {
            excerpt: oneLine(excerptOf, THINKING_EXCERPT),
            chars: thinking.reduce((sum, block) => sum + block.length, 0),
          },
        }),
    ...(running
      ? { now: { kind: pending ? ("tools" as const) : ("model" as const), since: endOf(last) } }
      : {}),
    steps: steps.slice(earlier),
    ...(earlier === 0 ? {} : { earlier }),
  };
}

/** A call's input as its detail shows it: the command, the patch, the file's text, else its arguments as JSON. */
function inputText(call: WorkCall): string {
  const command = str(call.args["command"]);
  if (command !== "") return command;
  const input = str(call.args["input"]);
  if (input !== "") return input;
  const path = str(call.args["path"]);
  const content = str(call.args["content"]);
  if (content !== "") return path === "" ? content : `${path}\n\n${content}`;
  const code = str(call.args["code"]);
  if (code !== "") return code;
  const rest = Object.fromEntries(Object.entries(call.args).filter(([key]) => key !== "i"));
  return Object.keys(rest).length === 0 ? "" : JSON.stringify(rest, null, 2);
}

/**
 * The full text behind one part of the turn holding `at`: `detail` THINKING_DETAIL for its whole
 * thinking, else a step's id for that call's input and output. Null when the turn has no such step.
 */
export function turnWorkDetail(
  messages: readonly WorkMessage[],
  at: number | null,
  detail: string,
): TurnWorkDetail | null {
  const bounds = turnBounds(messages, at);
  if (bounds === null) return null;
  const turn = messages.slice(bounds.start, bounds.end);
  if (detail === THINKING_DETAIL) {
    const text = capped(turn.flatMap((message) => message.thinking).join("\n\n"));
    return { text: text.text, ...(text.cut ? { truncated: true } : {}) };
  }
  for (const message of turn) {
    const call = message.calls.find((candidate) => candidate.id === detail);
    if (call === undefined) continue;
    const result = turn.find(
      (candidate) => candidate.role === "toolResult" && candidate.toolCallId === detail,
    );
    const input = capped(inputText(call));
    const output = result === undefined ? null : capped(resultText(result.content));
    return {
      input: input.text,
      ...(output === null ? {} : { output: output.text }),
      ...(result?.isError === true ? { failed: true } : {}),
      ...(input.cut || output?.cut === true ? { truncated: true } : {}),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// What clients say about a turn's work (phone sheet; the desktop can share it).
// ---------------------------------------------------------------------------------------------

/** Seconds as the sheet says them: `<0.1s`, `0.4s`, `12s`, `2m 05s`. */
export function workDuration(ms: number): string {
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A running clock: `0:09`, `12:40`. */
export function workClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How many tool calls the turn made, in words: `1 tool`, `4 tools`. */
export function toolCount(work: Pick<TurnWork, "steps" | "earlier">): string {
  const count = work.steps.length + (work.earlier ?? 0);
  return count === 1 ? "1 tool" : `${String(count)} tools`;
}

/**
 * The sheet's header: `Working` with the elapsed clock and the tool count while the turn runs,
 * `Thought 12s` and the count once done (the count left out for a turn without tools).
 */
export function workHeader(work: TurnWork, now: number): { title: string; meta: string } {
  const tools = work.steps.length + (work.earlier ?? 0);
  if (work.running)
    return { title: "Working", meta: `${workClock(now - work.at)} · ${toolCount(work)}` };
  return {
    title: `Thought ${workDuration(work.modelMs)}`,
    meta: tools === 0 ? "" : toolCount(work),
  };
}
