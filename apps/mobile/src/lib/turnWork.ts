/**
 * What the assistant thread shows of a turn's work (pure, tested): which replies carry the brain that opens
 * the work sheet, and how the sheet words a step. The fold and the header live in `@relay/protocol`
 * (`turn-work.ts`), shared with whoever else draws a turn's work.
 */
import { workClock, workDuration, type AssistantMessage, type TurnStep } from "@relay/protocol";
import { toolLabel } from "./toolName";

/** A reply's brain: the turn is over, or it runs now (the brain pulses). */
export type WorkBrain = "settled" | "live";

/** A row that starts a turn: Isaac's message, or a job line (a `status` row that is not a specialist caption or a guest's line). */
function startsTurn(row: AssistantMessage): boolean {
  return (
    row.role === "user" ||
    (row.role === "status" && row.agents === undefined && row.guest === undefined)
  );
}

/**
 * The replies that carry a brain, by row id: the last assistant row of every turn in `rows` (oldest first),
 * the newest one `live` while the thread is `busy`. `skip` leaves out rows that are not the host's (echoes,
 * local rows, ask and trial cards). Empty when the brain is off (`show`): Settings' Show work, and a host that
 * answers `assistant.work.req`.
 */
export function workBrains(
  rows: readonly AssistantMessage[],
  busy: boolean,
  show: boolean,
  skip: (row: AssistantMessage) => boolean,
): ReadonlyMap<string, WorkBrain> {
  const brains = new Map<string, WorkBrain>();
  if (!show) return brains;
  let last: string | null = null;
  for (const row of rows) {
    if (skip(row)) continue;
    if (startsTurn(row)) {
      if (last !== null) brains.set(last, "settled");
      last = null;
    } else if (row.role === "assistant") last = row.id;
  }
  if (last !== null) brains.set(last, busy ? "live" : "settled");
  return brains;
}

/** One step row of the sheet: its title (the intent, else the tool), the tool and input line, and its time. */
export interface StepView {
  title: string;
  tool: string;
  summary: string;
  /** How long it took (`1.4s`), the running clock while it runs, empty for a call that never got a result. */
  time: string;
  /** The error line of a failed step. */
  error: string | null;
}

export function stepView(step: TurnStep, now: number): StepView {
  const tool = toolLabel(step.tool);
  return {
    title: step.title === "" ? tool : step.title,
    tool,
    summary: step.summary,
    time:
      step.status === "running"
        ? workClock(now - step.startedAt)
        : step.endedAt === undefined
          ? ""
          : workDuration(step.endedAt - step.startedAt),
    error: step.status === "failed" ? (step.output ?? "Failed") : null,
  };
}

/** A line of a step's input or output, with the tone a patch line reads in: added, removed, or plain. */
export interface DetailLine {
  text: string;
  tone: "add" | "del" | null;
}

/** Tools whose input is a patch (`+` / `-` lines). */
const PATCH_TOOLS: Record<string, true> = { edit: true, apply_patch: true, ast_edit: true };

/** `text` as lines; a patch tool's `+` / `-` lines (not `+++` / `---` headers) take their tones. */
export function detailLines(tool: string, text: string): DetailLine[] {
  const patch = PATCH_TOOLS[toolLabel(tool)] === true;
  return text.split("\n").map((line) => ({
    text: line,
    tone: !patch
      ? null
      : line.startsWith("+") && !line.startsWith("+++")
        ? "add"
        : line.startsWith("-") && !line.startsWith("---")
          ? "del"
          : null,
  }));
}
