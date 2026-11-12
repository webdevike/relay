/**
 * Rules of tap-to-dictate in a composer (the dictation machine's `tap` region runs them): what the
 * field shows while listening and what a run leaves behind when it ends. Pure, no React Native.
 */

/** The draft before the tap followed by what was heard, one space (or the draft's newline) between them. */
export function joinDictation(base: string, heard: string): string {
  const before = base.replace(/\s+$/, "");
  const words = heard.trim();
  if (before === "") return words;
  if (words === "") return base;
  return `${before}${base.endsWith("\n") ? "\n" : " "}${words}`;
}

/** What a tap run is ending as: still listening (null), keep for editing, send, or drop. */
export type TapIntent = "keep" | "send" | "cancel" | null;

/** One tap run: the draft before the tap, what the field showed last, and how it is ending. */
export interface TapRun {
  base: string;
  interim: string;
  intent: TapIntent;
}

/**
 * How a tap run lands, given the recognizer's final words (`heard`, null when it gave none:
 * nothing heard, an error, the run dropped) and the draft now. `send` is the turn to send; `draft`
 * the field's next text, undefined to leave it alone (Isaac edited it after stopping).
 */
export function landDictation(run: TapRun, heard: string | null, draft: string): { send: string | null; draft: string | undefined } {
  if (run.intent === "cancel") return { send: null, draft: run.base };
  const words = heard === null ? run.interim : joinDictation(run.base, heard);
  if (run.intent === "send") return words.trim() === "" ? { send: null, draft: run.base } : { send: words, draft: undefined };
  const untouched = draft === run.base || draft === run.interim;
  return { send: null, draft: untouched ? words : undefined };
}
