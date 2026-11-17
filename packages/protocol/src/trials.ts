import { z } from "zod";

/**
 * Trial mode for taste agents (packages/atomic-agents `trial`): one request runs on three models at once, the
 * agent's own model answers the caller as usual, and Isaac sees the three results side by side as A / B / C with no
 * model names. He taps one (or "can't tell"); the models are revealed after his pick. The atomic-agents service keeps
 * the tally and switches the agent's model on its own when one is clearly winning, with its own chat message and an
 * Undo. The host folds the atomic-agents journal into these views (`trials.snapshot`); clients only draw them and
 * send picks and undos. Only sent to or by a host whose `welcome.features` has TRIALS_FEATURE.
 */
export const TRIALS_FEATURE = "trials";

export const TrialLetter = z.enum(["A", "B", "C"]);
export type TrialLetter = z.infer<typeof TrialLetter>;

/** A letter, or "can't tell" (`unsure`): counted as a pick nobody won. */
export const TrialPick = z.union([TrialLetter, z.literal("unsure")]);
export type TrialPick = z.infer<typeof TrialPick>;

/** One result on the card. */
export const TrialArm = z.object({
  letter: TrialLetter,
  status: z.enum(["running", "done", "failed"]),
  /** The result as Markdown (an image is `![](<path or url>)`), once done. */
  preview: z.string().max(20_000).optional(),
  /** Why it did not finish (failed arms are not pickable). */
  error: z.string().max(1000).optional(),
  seconds: z.number().optional(),
  /** Only after the pick: the model id and its short name (`Sonnet 5.5`). */
  model: z.string().max(200).optional(),
  modelLabel: z.string().max(200).optional(),
});
export type TrialArm = z.infer<typeof TrialArm>;

/** One request's comparison card. */
export const Trial = z.object({
  id: z.string().min(1).max(200),
  agent: z.string().min(1).max(200),
  /** The agent's name as Isaac reads it (`Diagram`). */
  label: z.string().max(200),
  /** The chat it belongs to (a ReactionThread: `assistant:<id>` or `session:<id>`); absent when no chat asked. */
  thread: z.string().max(400).optional(),
  /** When the request came in (ms): where the card sits in the chat. */
  at: z.number(),
  /** The request on one line. */
  request: z.string().max(500).optional(),
  arms: z.array(TrialArm).min(2).max(3),
  /** Isaac's pick; absent until he picks (an unpicked card simply does not count). */
  pick: TrialPick.optional(),
  pickedAt: z.number().optional(),
});
export type Trial = z.infer<typeof Trial>;

/** The agent's own message after it switched (or kept) its model on Isaac's picks. */
export const TrialSwitch = z.object({
  id: z.string().min(1).max(200),
  agent: z.string().min(1).max(200),
  label: z.string().max(200),
  /** The chat of the pick that decided it; absent when unknown (every chat with a card of this agent may show it). */
  thread: z.string().max(400).optional(),
  at: z.number(),
  /** `Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks over Opus 5.5 and GPT-6.1 Sol` */
  text: z.string().max(1000),
  from: z.string().max(200),
  to: z.string().max(200),
  fromLabel: z.string().max(200),
  toLabel: z.string().max(200),
  /** The winner was the model it already had: nothing switched, the trial just ended. */
  kept: z.boolean(),
  /** Undo was taken: the old model and the trial are back. */
  undone: z.boolean(),
});
export type TrialSwitch = z.infer<typeof TrialSwitch>;

export const TrialsSnapshot = z.object({
  trials: z.array(Trial).max(300),
  switches: z.array(TrialSwitch).max(100),
});
export type TrialsSnapshot = z.infer<typeof TrialsSnapshot>;

/** How long a badge names the model an agent switched to on its own. */
export const TRIAL_SWITCH_BADGE_MS = 24 * 60 * 60_000;

/** The cards and switch messages of one chat, oldest first. */
export function trialsOfThread(
  snapshot: TrialsSnapshot,
  thread: string,
): { readonly trials: Trial[]; readonly switches: TrialSwitch[] } {
  return {
    trials: snapshot.trials.filter((t) => t.thread === thread).sort((a, b) => a.at - b.at),
    switches: snapshot.switches.filter((s) => s.thread === thread).sort((a, b) => a.at - b.at),
  };
}

/** A pick Isaac can still make: not picked yet, and the letter is a finished arm (or "can't tell" once two finished). */
export function canPickTrial(trial: Trial, pick: TrialPick): boolean {
  if (trial.pick !== undefined) return false;
  const done = trial.arms.filter((a) => a.status === "done");
  if (pick === "unsure") return done.length >= 2;
  return done.length >= 2 && done.some((a) => a.letter === pick);
}
