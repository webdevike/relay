// The text-level backstop against speaker echo, ported from the Meeting Drawer (Transcript.swift):
// on laptop speakers the mic hears the call, so mic text can repeat what the app track said a
// moment earlier. AEC3 in the worker cancels most of it; what gets through is dropped here word by
// word: mic words inside a run of four or more that the call audio had within ECHO_WINDOW_MS are
// echo (two overlapping three-word runs; the drawer took one, which also dropped everyday phrases
// like "a little bit"), and the stretches left over count only when they are at least
// MIN_OWN_RUN words long.

export const ECHO_WINDOW_MS = 8_000;
export const MIN_OWN_RUN = 4;

const WORD = /[\p{L}\p{N}']+/gu;

/** Lowercased words, as both sides are compared. */
export function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** Every three-word run of `text`. */
export function triples(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 2; i < w.length; i += 1) out.add(`${w[i - 2]} ${w[i - 1]} ${w[i]}`);
  return out;
}

/**
 * The mic text that is not echo of `appTriples`, keeping its own casing; "" when all of it is.
 * Text with no echo at all (including replies of up to three words) comes back unchanged.
 */
export function ownSpeech(micText: string, appTriples: ReadonlySet<string>): string {
  const tokens = [...micText.matchAll(WORD)].map((m) => m[0]);
  if (tokens.length < 4 || appTriples.size === 0) return micText;
  const lower = tokens.map((t) => t.toLowerCase());
  const hit = lower.map(
    (_, i) => i + 2 < lower.length && appTriples.has(`${lower[i]} ${lower[i + 1]} ${lower[i + 2]}`),
  );
  const bleed = tokens.map(() => false);
  for (let i = 0; i + 1 < hit.length; i += 1) {
    if (hit[i] === true && hit[i + 1] === true) for (let k = i; k < i + 4; k += 1) bleed[k] = true;
  }
  if (!bleed.includes(true)) return micText;
  const runs: string[] = [];
  let run: string[] = [];
  for (let i = 0; i <= tokens.length; i += 1) {
    const token = tokens[i];
    if (token !== undefined && !bleed[i]) {
      run.push(token);
      continue;
    }
    if (run.length >= MIN_OWN_RUN) runs.push(run.join(" "));
    run = [];
  }
  return runs.join(" … ");
}
