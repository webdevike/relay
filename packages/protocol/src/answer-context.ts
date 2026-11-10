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
