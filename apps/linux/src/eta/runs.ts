// Runs out of an omp transcript: the piece of a session from one request to the reply that ends it,
// with what an estimate needs (title, model, thinking, turn times, plan progress). The same scanner
// reads finished transcripts for history and follows a live one line by line. Pure: callers hand in
// lines; the HANDOFF file a run keeps is read by the caller (`planFile` says which one).
import { basename, isAbsolute, join } from "node:path";

export const RUN_KINDS = ["build", "fix", "research", "review", "render", "deploy", "prototype", "other"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * `task`: a session an assistant or a job started to do one thing (listed in an assistant's
 * sessions.json, or an Eva agent session across its rotations); `chat`: any other top-level session;
 * `helper`: a subagent a `task` call started (its transcript names a parent session).
 */
export type RunAgent = "chat" | "task" | "helper";

/** A helper woken again after this long (a follow-up message) starts a new run. */
export const HELPER_REVIVE_MS = 10 * 60 * 1000;

export interface PlanSteps {
  readonly done: number;
  readonly total: number;
}

export interface RunKey {
  readonly agent: RunAgent;
  /**
   * Who ran it: a helper's agent definition from the `task` call that spawned it (`helper-code`,
   * `helper-visual`, `scout`; `task` when the call named none), an agent session's `--agent`, else null.
   */
  readonly role: string | null;
  readonly kind: RunKind;
  readonly model: string | null;
  readonly thinking: string | null;
}

export interface RunRecord extends RunKey {
  readonly file: string;
  readonly title: string;
  readonly startedAt: number;
  readonly durationMs: number;
  /** `done` ended on a reply; `failed` ended on an error, an abort or mid tool call. */
  readonly outcome: "done" | "failed";
  /** Seconds from the start of each assistant turn, in order. */
  readonly turnAt: readonly number[];
  readonly outputTokens: number;
  /** Plan progress as it changed: `[seconds from start, done, total]`. */
  readonly stepsAt: readonly (readonly [number, number, number])[];
  /** The longest it may run (an agent session's `--max-time`), from `startedAt`. */
  readonly limitMs?: number;
}

/** A run still going: what the estimator reads each poll. */
export interface OpenRun extends RunKey {
  readonly title: string;
  readonly startedAt: number;
  readonly lastAt: number;
  readonly turns: number;
  readonly outputTokens: number;
  /** The todo list's progress, or "step k of n" from the latest reply. */
  readonly steps: PlanSteps | null;
  /** A HANDOFF.md / PLAN.md the run wrote or read, absolute; its checkboxes are plan steps too. */
  readonly planFile: string | null;
  /** The last turn ended on a reply (not a tool call). */
  readonly replied: boolean;
}

const KIND_RULES: readonly (readonly [RunKind, RegExp])[] = [
  ["render", /\b(render|video|image|images|3d|blender|animation|film|glb|photo|portrait|sound|audio)\b/i],
  ["deploy", /\b(deploy|ship|shipping|release|publish|install|ota|rollout|staged?)\b/i],
  ["review", /\b(review|reviewer|audit|verify|council|critic|critique|qa|proof|check)\b/i],
  ["research", /\b(research|investigate|explore|scout|map|mapping|compare|analy[sz]e|survey|find|lookup|why)\b/i],
  ["fix", /\b(fix|fixes|bug|crash|broken|repair|regression|debug|hotfix|error|failing|flaky)\b/i],
  ["prototype", /\b(prototype|spike|poc|mock|mockup|sketch|experiment|demo|try)\b/i],
  ["build", /\b(build|add|implement|create|make|feature|wire|port|migrate|refactor|redesign|polish|cutover|ui)\b/i],
];

/** The kind of work a title names; the first rule that matches wins, so "Ship phone fix" is a deploy. */
export function classifyKind(title: string): RunKind {
  const words = title.replace(/([a-z])([A-Z])/g, "$1 $2");
  for (const [kind, rule] of KIND_RULES) if (rule.test(words)) return kind;
  return "other";
}

/** `anthropic/claude-opus-5-5` and `claude-opus-5-5` are the same model. */
export function modelName(model: string | undefined | null): string | null {
  if (model === undefined || model === null || model === "") return null;
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

const STEP_TEXT = /\bstep (\d{1,2}) (?:of|\/) ?(\d{1,2})\b/gi;
const PLAN_FILE = /^(handoff|plan)\.md$/i;
const EDIT_HEADER = /^\[([^\]#]+)#[0-9A-F]{4}\]/m;

interface Segment {
  startedAt: number;
  lastAt: number;
  turnAt: number[];
  outputTokens: number;
  stepsAt: [number, number, number][];
  steps: PlanSteps | null;
  todo: boolean;
  lastStop: string | null;
  /** A helper ends by calling `yield` (a tool call, so its last turn stops on toolUse). */
  yielded: "done" | "failed" | null;
  title: string;
  model: string | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const when = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Done and total from the todo tool's phases (`details.phases[].tasks[].status`); dropped tasks do not count. */
export function todoSteps(phases: unknown): PlanSteps | null {
  if (!Array.isArray(phases)) return null;
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    if (!isObject(phase) || !Array.isArray(phase["tasks"])) continue;
    for (const task of phase["tasks"]) {
      const status = isObject(task) ? str(task["status"]) : null;
      if (status === null || status === "dropped" || status === "removed" || status === "cancelled") continue;
      total += 1;
      if (status === "completed" || status === "done") done += 1;
    }
  }
  return total === 0 ? null : { done, total };
}

/** `- [x]` / `- [ ]` checkboxes in a markdown file (a HANDOFF's task list). Null below two. */
export function checkboxSteps(markdown: string): PlanSteps | null {
  let done = 0;
  let total = 0;
  for (const match of markdown.matchAll(/^\s*[-*] \[( |x|X)\]/gm)) {
    total += 1;
    if (match[1] !== " ") done += 1;
  }
  return total < 2 ? null : { done, total };
}

/**
 * One transcript, line by line. A run starts at a request (a user message, or the first reply of a
 * session started by a prompt of its own) and goes on until the next request that comes after a reply;
 * a message that lands mid-turn (a steer) or a background result is part of the run it lands in.
 */
export class TranscriptScan {
  /** Set by the caller once it knows who ran this transcript (`RunKey.role`). */
  role: string | null = null;
  private title = "";
  private model: string | null = null;
  private thinking: string | null = null;
  private agent: RunAgent;
  private cwd: string | null = null;
  private parentFile: string | null = null;
  private segment: Segment | null = null;
  private planFile: string | null = null;
  private readonly closed: RunRecord[] = [];
  private readonly spawned: Record<string, string> = {};

  /** `task`: the caller knows this transcript is a session an assistant or a job started. */
  constructor(
    readonly file: string,
    task = false,
  ) {
    this.agent = task ? "task" : "chat";
  }

  /** A helper's parent transcript (its `parentSession`), else null. */
  get parent(): string | null {
    return this.parentFile;
  }

  /** A helper's name in its parent's `task` call: `BossR3.jsonl` is BossR3, a nested `Lane.Wiring.jsonl` is Wiring. */
  get name(): string | null {
    return this.parentFile === null ? null : (basename(this.file, ".jsonl").split(".").at(-1) ?? null);
  }

  /** The helpers this transcript's `task` calls started, by name, to their agent definition. */
  spawns(): Readonly<Record<string, string>> {
    return this.spawned;
  }

  /** Feeds one jsonl line; lines that cannot matter are skipped before parsing. */
  line(text: string): void {
    if (text.length === 0) return;
    if (text.includes('"role":"toolResult"') && !text.includes('"toolName":"todo"')) return;
    if (text.startsWith('{"type":"custom"') && !text.includes('"customType":"session_exit"') && !text.includes('"customType":"todo_hud_state"')) return;
    if (text.startsWith('{"type":"custom_message"') || text.startsWith('{"type":"session_init"')) return;
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      return;
    }
    if (isObject(entry)) this.entry(entry);
  }

  /** Runs that have ended (a later request started a new one, or the session exited). */
  runs(): readonly RunRecord[] {
    return this.closed;
  }

  /** The run going on now, if the last request has had at least one reply turn. */
  open(): OpenRun | null {
    const segment = this.segment;
    if (segment === null || segment.turnAt.length === 0) return null;
    return {
      ...this.key(segment),
      title: segment.title,
      startedAt: segment.startedAt,
      lastAt: segment.lastAt,
      turns: segment.turnAt.length,
      outputTokens: segment.outputTokens,
      steps: segment.steps,
      planFile: this.planFile,
      replied: segment.yielded !== null || (segment.lastStop !== null && segment.lastStop !== "toolUse"),
    };
  }

  /** Ends the open run as it stands (a transcript that is no longer written). */
  finish(): readonly RunRecord[] {
    this.close();
    return this.closed;
  }

  private key(segment: Segment): RunKey {
    return { agent: this.agent, role: this.role, kind: classifyKind(segment.title), model: segment.model, thinking: this.thinking };
  }

  private entry(entry: Json): void {
    const type = entry["type"];
    const at = when(entry["timestamp"]);
    if (type === "title" || type === "title_change") {
      const title = str(entry["title"]);
      if (title !== null && title !== "") {
        this.title = title;
        if (this.segment !== null && this.segment.turnAt.length === 0) this.segment.title = title;
      }
    } else if (type === "session") {
      const parent = str(entry["parentSession"]);
      if (parent !== null) {
        this.agent = "helper";
        this.parentFile = parent;
        // A helper's title is its name (`LaneBoss2.jsonl`).
        if (this.title === "") this.title = basename(this.file, ".jsonl");
      }
      this.cwd = str(entry["cwd"]);
      const title = str(entry["title"]);
      if (title !== null && title !== "" && this.title === "") this.title = title;
    } else if (type === "model_change") {
      this.model = modelName(str(entry["model"]));
    } else if (type === "thinking_level_change") {
      this.thinking = str(entry["thinkingLevel"]);
    } else if (type === "custom") {
      if (entry["customType"] === "session_exit") this.close();
      else if (entry["customType"] === "todo_hud_state" && this.segment !== null && at !== null) {
        const data = entry["data"];
        const fingerprint = isObject(data) ? str(data["fingerprint"]) : null;
        if (fingerprint !== null) {
          try {
            this.steps(at, todoSteps((JSON.parse(fingerprint) as unknown[]).map((phase) => (isObject(phase) ? { tasks: phase["tasks"] } : phase))), true);
          } catch {
            // A fingerprint that is not JSON says nothing.
          }
        }
      }
    } else if (type === "message" && at !== null && isObject(entry["message"])) {
      this.message(entry["message"], at);
    }
  }

  private message(message: Json, at: number): void {
    const role = message["role"];
    if (role === "user") {
      const segment = this.segment;
      const ended = segment !== null && segment.turnAt.length > 0 && (segment.yielded !== null || (segment.lastStop !== null && segment.lastStop !== "toolUse"));
      // A helper's harness nudges it after a reply; only a follow-up long after is a new run.
      if (segment === null || (ended && (this.agent !== "helper" || at - segment.lastAt > HELPER_REVIVE_MS))) {
        this.close();
        this.start(at);
      }
    } else if (role === "assistant") {
      const segment = this.segment ?? this.start(at);
      segment.turnAt.push(Math.max(0, Math.round((at - segment.startedAt) / 1000)));
      segment.lastAt = at;
      segment.lastStop = str(message["stopReason"]);
      segment.yielded = null;
      const model = modelName(str(message["model"]));
      if (model !== null) segment.model = model;
      const usage = message["usage"];
      if (isObject(usage) && typeof usage["output"] === "number") segment.outputTokens += usage["output"];
      if (Array.isArray(message["content"])) this.content(message["content"], segment, at);
    } else if (role === "toolResult" && message["toolName"] === "todo" && this.segment !== null) {
      const details = message["details"];
      if (isObject(details)) this.steps(at, todoSteps(details["phases"]), true);
    }
  }

  private content(parts: readonly unknown[], segment: Segment, at: number): void {
    for (const part of parts) {
      if (!isObject(part)) continue;
      if (part["type"] === "text" && !segment.todo) {
        const text = str(part["text"]) ?? "";
        let last: PlanSteps | null = null;
        for (const match of text.matchAll(STEP_TEXT)) {
          const done = Number(match[1]) - 1;
          const total = Number(match[2]);
          if (total >= 2 && done >= 0 && done < total) last = { done, total };
        }
        if (last !== null) this.steps(at, last, false);
      } else if (part["type"] === "toolCall") {
        const path = this.planPath(part);
        if (path !== null) this.planFile = path;
        const args = part["arguments"];
        if (part["name"] === "yield") {
          const error = isObject(args) ? args["error"] : null;
          segment.yielded = typeof error === "string" && error !== "" ? "failed" : "done";
        } else if (part["name"] === "task" && isObject(args) && Array.isArray(args["tasks"])) {
          for (const task of args["tasks"]) {
            const name = isObject(task) ? str(task["name"]) : null;
            if (name !== null && name !== "") this.spawned[name] = (isObject(task) ? str(task["agent"]) : null) ?? "task";
          }
        }
      }
    }
  }

  private planPath(call: Json): string | null {
    const args = call["arguments"];
    if (!isObject(args)) return null;
    const name = call["name"];
    let path: string | null = null;
    if (name === "write" || name === "read") path = str(args["path"])?.split(":")[0] ?? null;
    else if (name === "edit") path = EDIT_HEADER.exec(str(args["input"]) ?? "")?.[1] ?? null;
    if (path === null || !PLAN_FILE.test(basename(path))) return null;
    if (isAbsolute(path)) return path;
    return this.cwd === null ? null : join(this.cwd, path);
  }

  private steps(at: number, steps: PlanSteps | null, todo: boolean): void {
    const segment = this.segment;
    if (segment === null || steps === null) return;
    if (todo) segment.todo = true;
    const before = segment.steps;
    if (before !== null && before.done === steps.done && before.total === steps.total) return;
    segment.steps = steps;
    segment.stepsAt.push([Math.max(0, Math.round((at - segment.startedAt) / 1000)), steps.done, steps.total]);
  }

  private start(at: number): Segment {
    const segment: Segment = { startedAt: at, lastAt: at, turnAt: [], outputTokens: 0, stepsAt: [], steps: null, todo: false, lastStop: null, yielded: null, title: this.title, model: this.model };
    this.segment = segment;
    this.planFile = null;
    return segment;
  }

  private close(): void {
    const segment = this.segment;
    this.segment = null;
    if (segment === null || segment.turnAt.length === 0) return;
    this.closed.push({
      ...this.key(segment),
      file: this.file,
      title: segment.title,
      startedAt: segment.startedAt,
      durationMs: segment.lastAt - segment.startedAt,
      outcome: segment.yielded === "done" || segment.lastStop === "stop" || segment.lastStop === "end_turn" ? "done" : "failed",
      turnAt: segment.turnAt,
      outputTokens: segment.outputTokens,
      stepsAt: segment.stepsAt,
    });
  }
}
