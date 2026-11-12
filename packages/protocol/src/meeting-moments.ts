// Moments: the few lines of a call worth jumping back to. Detected from the transcript the host
// already streams (no host code, no model): sentence patterns over finalized lines, so it is cheap
// enough to re-run whenever the lines change (clients memoise on the lines array).
import { meetingRows, type LiveLine, type MeetingRow } from "./meetings";

/** `decision`: something was settled. `action`: someone took something on. `you`: someone else spoke to Isaac. */
export type MomentKind = "decision" | "action" | "you";

export interface MeetingMoment {
  /** Stable while the call runs: `<row id>:<sentence index>`. */
  readonly id: string;
  readonly kind: MomentKind;
  /** The transcript row (`meetingRows` id) it sits in, for jumping to it. */
  readonly rowId: string;
  /** Where its row starts, ms from the start of the recording. */
  readonly startMs: number;
  /** Who said it ("You" for Isaac's own mic). */
  readonly speaker: string;
  /** The sentence itself, trimmed to MOMENT_MAX_CHARS. */
  readonly text: string;
  /** `you` only: Isaac has spoken since. */
  readonly answered: boolean;
}

export const MOMENT_MAX_CHARS = 140;

const MENTION = /\bisaac\b/i;
const DECISION =
  /\b(we(?:'ll| will| are going to| decided| agreed)|let'?s (?:go with|settle|ship|do|move|use|make)|(?:we |i )?decided|(?:we )?agreed|the decision is|settle (?:it|this)|going with|ship (?:it|the [\w -]+?) (?:on|by|this|next)|by (?:end of|the end of) (?:the )?(?:week|month|day|quarter))\b/i;
const ACTION =
  /\b(i(?:'ll| will|'m going to| am going to)|i can (?:take|look|send|open|do|own|handle|follow|check|write|draft|review|get|pair|set)|action item|follow[- ]up|next step)\b/i;

function kindOf(sentence: string, mic: boolean): MomentKind | null {
  if (!mic && MENTION.test(sentence)) return "you";
  if (DECISION.test(sentence)) return "decision";
  // A question is rarely a commitment ("can you open it?" is a request, caught as a mention).
  if (!sentence.endsWith("?") && ACTION.test(sentence)) return "action";
  return null;
}

/** The moments of `lines` (finalized, non-echo ones only), oldest first. */
export function detectMoments(lines: readonly LiveLine[]): MeetingMoment[] {
  const rows: MeetingRow[] = meetingRows(lines.filter((l) => l.final));
  const out: MeetingMoment[] = [];
  rows.forEach((row) => {
    const mic = row.track === "mic";
    // Sentence ends split the row, the punctuation staying with its sentence.
    const parts = row.text.match(/[^.!?]+[.!?]*/g)?.map((p) => p.trim()).filter((p) => p !== "") ?? [];
    parts.forEach((s, i) => {
      const kind = kindOf(s, mic);
      if (kind === null) return;
      const answered =
        kind === "you" && rows.some((r) => r.track === "mic" && r.startMs > row.startMs);
      out.push({
        id: `${row.id}:${i}`,
        kind,
        rowId: row.id,
        startMs: row.startMs,
        speaker: mic ? "You" : row.speaker,
        text: s.length <= MOMENT_MAX_CHARS ? s : `${s.slice(0, MOMENT_MAX_CHARS - 1).trimEnd()}…`,
        answered,
      });
    });
  });
  return out;
}

/** `ms` as whole minutes since the start ("14m"), the transcript's coarse stamp. */
export const momentStamp = (ms: number): string => `${Math.floor(ms / 60_000)}m`;
