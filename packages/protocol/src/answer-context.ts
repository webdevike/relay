// An answer to an OLDER open ask ("Waiting on you" badge, a reply chip on a bubble that is not the
// newest) reaches the agent as bare text like `Skip it`, which reads as a reply to the latest
// message. Such an answer is sent as `[answer to: "<question excerpt>"] Skip it` instead (the host's
// `[answer to ask <id>]` is the same idea for a session's ask). The chat shows only Isaac's words;
// the host reads the tag back to close the ask it names (`answerTagOf`).

/** Longest question excerpt in the tag, in characters, ellipsis included. */
export const MAX_ANSWER_CONTEXT = 120;

const TAG = /^\[answer to: "([^"\n]*)"\] /;

/** The question as the tag carries it: whitespace collapsed, double quotes softened, cut with an ellipsis. */
export function answerExcerpt(question: string): string {
  const flat = question.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  if (flat.length <= MAX_ANSWER_CONTEXT) return flat;
  return `${flat.slice(0, MAX_ANSWER_CONTEXT - 1).trimEnd()}…`;
}

/**
 * The text to send for `answer` to the question `question`: tagged when it answers an earlier
 * question (`older`), `answer` unchanged when it answers the newest message or the question is empty.
 */
export function answerText(answer: string, question: string, older: boolean): string {
  if (!older) return answer;
  const q = answerExcerpt(question);
  return q === "" ? answer : `[answer to: "${q}"] ${answer}`;
}

/** `text` without a leading answer tag, for the bubble Isaac sees. */
export function stripAnswerContext(text: string): string {
  return text.replace(TAG, "");
}

/** A turn's leading answer tag: the question excerpt it names (compare with `answerExcerpt`) and the words after it; null without one. */
export function answerTagOf(text: string): { question: string; answer: string } | null {
  const match = TAG.exec(text);
  return match === null ? null : { question: match[1] ?? "", answer: text.slice(match[0].length) };
}

/** The bits of an open ask `stillAsking` reads. */
export interface AskTurnInput {
  source: "replies" | "ask" | "session";
  question: string;
  at: number;
}

/**
 * Whether the thread's own reply-chip question (`source` "replies") still waits on Isaac, judged from
 * the rows the client holds: any later turn of his answers it, typed or tapped, except one whose
 * answer tag names another question. The host closes it too (its snapshot's `asks`), but a client
 * must not keep a stale outline, label and chips for a snapshot it holds that predates the close.
 * Other asks (an omp ask card, a session's question) answer elsewhere and always stay open here.
 */
export function stillAsking(
  ask: AskTurnInput,
  rows: readonly { role: string; text: string; at?: number | undefined }[],
): boolean {
  if (ask.source !== "replies") return true;
  const excerpt = answerExcerpt(ask.question);
  return !rows.some((row) => {
    if (row.role !== "user" || row.at === undefined || row.at <= ask.at) return false;
    const tag = answerTagOf(row.text);
    return tag === null || tag.question === excerpt;
  });
}
