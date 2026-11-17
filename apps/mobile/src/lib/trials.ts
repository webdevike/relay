/**
 * Trial mode in a chat, the pure part: which rows a thread's trial cards and switch messages add to
 * its list (each placed by its `at` among the messages, `openAsks.ts` `insertByAt`), and what a
 * card and a switch message say and offer. Everything here is derived from the host's snapshot and
 * this phone's unanswered pick, so the card needs no state of its own.
 */
import {
  canPickTrial,
  trialsOfThread,
  type AssistantMessage,
  type ClientMessage,
  type Trial,
  type TrialArm,
  type TrialLetter,
  type TrialPick,
  type TrialSwitch,
  type TrialsSnapshot,
} from "@relay/protocol";

/** Row ids of a trial card in a thread start with this (then the trial id). */
export const TRIAL_ROW_PREFIX = "trial-card:";
/** Row ids of a switch message in a thread start with this (then the switch id). */
export const TRIAL_SWITCH_ROW_PREFIX = "trial-switch:";

/** Whether `id` is a trial card or switch message row rather than one of the thread's messages. */
export function isTrialRow(id: string): boolean {
  return id.startsWith(TRIAL_ROW_PREFIX) || id.startsWith(TRIAL_SWITCH_ROW_PREFIX);
}

export type TrialRow =
  | { readonly kind: "trial"; readonly trial: Trial }
  | { readonly kind: "switch"; readonly entry: TrialSwitch };

export interface ThreadTrialRows {
  /** One `card` row per trial and switch message of the thread, oldest first. */
  readonly rows: AssistantMessage[];
  /** What each of those rows draws, by row id. */
  readonly byRow: ReadonlyMap<string, TrialRow>;
}

/** The rows `thread`'s trial cards and switch messages add to its list. */
export function threadTrialRows(snapshot: TrialsSnapshot, thread: string): ThreadTrialRows {
  const { trials, switches } = trialsOfThread(snapshot, thread);
  const byRow = new Map<string, TrialRow>();
  const rows: AssistantMessage[] = [];
  for (const trial of trials) {
    const id = `${TRIAL_ROW_PREFIX}${trial.id}`;
    byRow.set(id, { kind: "trial", trial });
    rows.push({ id, role: "card", text: trial.request ?? trial.label, at: trial.at });
  }
  for (const entry of switches) {
    const id = `${TRIAL_SWITCH_ROW_PREFIX}${entry.id}`;
    byRow.set(id, { kind: "switch", entry });
    rows.push({ id, role: "card", text: entry.text, at: entry.at });
  }
  return { rows: rows.sort((a, b) => a.at - b.at), byRow };
}

/** A card's arms in letter order (the host may list them in finish order). */
export function armsInOrder(trial: Trial): TrialArm[] {
  return [...trial.arms].sort((a, b) => a.letter.localeCompare(b.letter));
}

/** The card's small header: the question before the pick, Isaac's answer after it. */
export function trialHeader(trial: Trial): string {
  if (trial.pick === undefined) return `${trial.label} · which is better?`;
  return trial.pick === "unsure"
    ? `${trial.label} · you couldn't tell`
    : `${trial.label} · you picked ${trial.pick}`;
}

/** What an arm without a result says in place of it. */
export function armStateText(arm: TrialArm): string | null {
  if (arm.status === "running") return "Working on it";
  if (arm.status === "failed") return "Didn't finish";
  return null;
}

export interface TrialChoice {
  readonly pick: TrialPick;
  readonly label: string;
  /** It can be tapped now (protocol `canPickTrial`, connected, no pick of this phone's out). */
  readonly enabled: boolean;
  /** This phone sent it and the host has not answered yet. */
  readonly sending: boolean;
}

/**
 * The card's buttons: one per letter on the card, then "Can't tell". None once the card is picked
 * (the buttons go and the models show). While a pick of this phone's is out, every button waits.
 */
export function trialChoices(
  trial: Trial,
  sending: TrialPick | undefined,
  connected: boolean,
): TrialChoice[] {
  if (trial.pick !== undefined) return [];
  const letters: TrialPick[] = armsInOrder(trial).map((arm): TrialLetter => arm.letter);
  return [...letters, "unsure" as const].map((pick) => ({
    pick,
    label: pick === "unsure" ? "Can't tell" : pick,
    enabled: connected && sending === undefined && canPickTrial(trial, pick),
    sending: sending === pick,
  }));
}

/** The switch message's line: the agent's own words, or what Undo did. */
export function switchLine(entry: TrialSwitch): string {
  return entry.undone ? `Undone: back on ${entry.fromLabel}, trial on again` : entry.text;
}

/** Whether the switch message still offers Undo: a real switch (not a kept model) that was not undone. */
export function canUndoSwitch(entry: TrialSwitch): boolean {
  return !entry.undone && !entry.kept;
}

export type TrialPickFrame = Extract<ClientMessage, { t: "trial.pick" }>;
export type TrialUndoFrame = Extract<ClientMessage, { t: "trial.undo" }>;

/** Isaac's pick on card `trial`, made on the phone. */
export function trialPickFrame(trial: string, pick: TrialPick): TrialPickFrame {
  return { t: "trial.pick", trial, pick, surface: "phone" };
}

/** Undo of switch `switchId`. */
export function trialUndoFrame(switchId: string): TrialUndoFrame {
  return { t: "trial.undo", switch: switchId };
}
