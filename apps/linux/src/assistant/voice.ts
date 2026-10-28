// How a call's words travel through an assistant's normal thread. Each utterance goes in as a user
// turn whose first line is `VOICE_NOTE`: it tells the agent the reply is read aloud, so it answers
// short and plain, and that delegation and approvals do not change. The agent may put anything
// meant for reading after a `[[details]]` line; the call speaks only what comes before it. The
// phone's view of the thread strips both, marking the turn `voice`.

/** The line that ends the spoken part of a reply. */
export const DETAILS_MARKER = "[[details]]";
const DETAILS_LINE = /^[ \t]*\[\[details\]\][ \t]*$/m;

/** First line of every voice turn. One line, so the phone's view can drop it whatever its wording. */
export const VOICE_NOTE = `[Voice call: Isaac is talking to you live from Relay and your reply is read aloud. Answer in one to three short spoken sentences, no markdown, lists, code, links, paths or IDs. Anything he should read goes after a line holding only ${DETAILS_MARKER}; the chat shows it, the call does not speak it. Delegation, approvals and asking before anything hard to undo work exactly as in text.]`;

/** Opening every voice turn has, whatever the note's wording was when it was sent. */
const VOICE_OPENING = "[Voice call";

/** The turn a call sends for `heard`. */
export function voiceTurn(heard: string): string {
  return `${VOICE_NOTE}\n${heard}`;
}

/** A user turn's words without the voice note, and whether it was spoken on a call. */
export function splitVoiceTurn(text: string): { text: string; voice: boolean } {
  if (!text.startsWith(VOICE_OPENING)) return { text, voice: false };
  const newline = text.indexOf("\n");
  return { text: newline === -1 ? "" : text.slice(newline + 1).trim(), voice: true };
}

/** The part of a reply a call says out loud: everything before the details marker. */
export function spokenPart(text: string): string {
  const match = DETAILS_LINE.exec(text);
  return match === null ? text : text.slice(0, match.index);
}

/** Whether a reply still streaming in has reached its details marker, so its spoken part is final. */
export function spokenPartComplete(text: string): boolean {
  return DETAILS_LINE.test(text);
}

/** A reply as the chat shows it: the details marker line becomes a paragraph break. Text without it is returned as is. */
export function withoutDetailsMarker(text: string): string {
  const match = DETAILS_LINE.exec(text);
  if (match === null) return text;
  return `${text.slice(0, match.index).trimEnd()}\n\n${text.slice(match.index + match[0].length).trimStart()}`.trim();
}
