/**
 * Every client marks a prompt with where Isaac typed it, `<surface>Mac Mini - Relay Desktop</surface>`
 * or `<surface>iPhone - Relay</surface>`, on the prompt's own first line, so the agent knows. The tag
 * is for the agent only: every place that shows a user's words (the phone's rows, the host's pushes
 * and previews) shows them through `untagged`. Older history carries `- EvaOS` and `- Terminal` tags;
 * any label is stripped.
 */
const LEADING_SURFACE = /^\s*<surface>[^<]*<\/surface>[\r\n]*/;

/** `text` without a leading `<surface>...</surface>` tag from any client; unchanged without one. */
export function untagged(text: string): string {
  const match = LEADING_SURFACE.exec(text);
  return match === null ? text : text.slice(match[0].length);
}
