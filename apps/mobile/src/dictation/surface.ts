/**
 * Marks prompts sent from the phone so the agent knows where Isaac is typing:
 * `<surface>iPhone - Relay</surface>` on its own first line. Slash commands stay untagged
 * (omp only reads them at the start of a prompt). Every client's tag is stripped before display.
 */
export const SURFACE = "iPhone - Relay";

export function tagged(text: string): string {
  if (text.trim() === "" || /^\s*\//.test(text)) return text;
  return `<surface>${SURFACE}</surface>\n${text}`;
}

export function untagged(text: string): string {
  const match = /^\s*<surface>[^<]*<\/surface>[\r\n]*/.exec(text);
  return match === null ? text : text.slice(match[0].length);
}
