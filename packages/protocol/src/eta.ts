// How long a running agent has left: the estimate the host attaches to an activity item (`eta`), and
// `etaView`, the one reading of it every client draws (the phone's header chips, the desktop's chips
// and Artifacts' Running rows). The host recomputes the estimate as the run goes (plan steps, history
// of similar runs, turn pace); between pushes a client only moves time forward, so the fill keeps
// growing without a frame every second. Relay desktop's chat-core/activity.ts mirrors the schema.
import { z } from "zod";

const positive = z.number().finite().positive();

export const ETA_CONFIDENCE = ["rough", "confident"] as const;
export const EtaConfidence = z.enum(ETA_CONFIDENCE);
export type EtaConfidence = z.infer<typeof EtaConfidence>;

export const ActivityEta = z.object({
  /** When the task began: the request that started this run, read from its transcript. */
  from: z.number().finite(),
  /** Expected length of the whole task from `from`, corrected live; `lowMs`..`highMs` holds the middle half. */
  totalMs: positive,
  lowMs: positive,
  highMs: positive,
  /** How long similar runs usually take (the median of the history the estimate leans on). */
  typicalMs: positive,
  /** How many past runs the estimate leans on (0 when it comes from the plan alone). */
  runs: z.number().int().nonnegative(),
  /** `confident` draws a solid fill, `rough` a soft striped one. */
  confidence: EtaConfidence,
  /** Already longer than nearly every similar run: drawn amber as "taking longer", never parked at 99%. */
  overrunning: z.boolean(),
  /** Plan progress when the run keeps one (its todo list, HANDOFF checkboxes, "step k of n"). */
  steps: z.object({ done: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(),
});
export type ActivityEta = z.infer<typeof ActivityEta>;

export type EtaState = "onTrack" | "overrunning";

export interface EtaView {
  /** How much of the badge to fill, 0..1; never full while the run is still going. */
  fraction: number;
  elapsedMs: number;
  remainingMs: number;
  state: EtaState;
  /** Solid when true, striped when the estimate is a rough guess. */
  confident: boolean;
  /** "About 12 min left", "Taking longer than usual". */
  label: string;
  /** The second line: how sure, and what it rests on ("Rough guess · 3 of 7 steps done"). */
  detail: string;
  /** Compact text for a chip with room ("12m", "<1m"); null when overrunning. */
  short: string | null;
}

/** A running fill stops short of full, so "full" can mean done. */
export const ETA_MAX_FRACTION = 0.95;
const ETA_MIN_FRACTION = 0.03;
const MINUTE = 60_000;

/** "12 min", "1 h 5 min", "45 s". */
export function etaDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function shortDuration(ms: number): string {
  if (ms < MINUTE) return "<1m";
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * What a badge shows for an estimate at `now`. The fill is elapsed over the expected total, held
 * between a sliver and `ETA_MAX_FRACTION`. Past the estimate's upper bound (the host said so, or no
 * fresher estimate came) the badge says "taking longer" instead of counting down from zero.
 */
export function etaView(eta: ActivityEta, now: number): EtaView {
  const elapsedMs = Math.max(0, now - eta.from);
  const overrunning = eta.overrunning || elapsedMs > eta.highMs;
  const remainingMs = Math.max(0, eta.totalMs - elapsedMs);
  const fraction = Math.min(ETA_MAX_FRACTION, Math.max(ETA_MIN_FRACTION, elapsedMs / eta.totalMs));
  const confident = eta.confidence === "confident" && !overrunning;
  const steps = eta.steps === undefined ? null : `${eta.steps.done} of ${eta.steps.total} steps done`;
  if (overrunning) {
    const usual = `Usually about ${etaDuration(eta.typicalMs)}, this one is at ${etaDuration(elapsedMs)}`;
    return {
      fraction,
      elapsedMs,
      remainingMs,
      state: "overrunning",
      confident,
      label: "Taking longer than usual",
      detail: steps === null ? usual : `${usual} · ${steps}`,
      short: null,
    };
  }
  const label = remainingMs < MINUTE ? "Less than a minute left" : `About ${etaDuration(remainingMs)} left`;
  const sure = confident ? "Fairly sure" : "Rough guess";
  const basis = eta.runs > 0 ? `${eta.runs} similar run${eta.runs === 1 ? "" : "s"}` : null;
  const parts = [sure, steps ?? basis].filter((part): part is string => part !== null);
  return { fraction, elapsedMs, remainingMs, state: "onTrack", confident, label, detail: parts.join(" · "), short: shortDuration(remainingMs) };
}
