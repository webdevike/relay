// `@name` in a comment: which agent a thread is for. Pure text helpers shared by the host (routing),
// the room page and Relay Desktop's Canvas page (autocomplete, and the assignee a saved thread keeps).
//
// A candidate is an assistant of the registry (`id` "astra", `name` "Astra") or an agent joined to the
// room (`id` its lowercased name). A mention is `@` at a word start followed by a candidate's id or
// name, any case, then a non-name character or the end ("@astra," and "ask @Astra." match; "me@astra"
// and "@astrank" do not).

export interface Mentionable {
  /** What a thread stores as its assignee: a registry assistant's id, else a joined agent's lowercased name. */
  readonly id: string;
  /** What the menu and the room show: "Astra". */
  readonly name: string;
  /** Short line under the name in the menu ("Eva self-improvement"). */
  readonly hint?: string | undefined;
  /** `#rrggbb` accent. */
  readonly color?: string | undefined;
  /** Host-relative avatar path (`/canvas/avatar/<id>`), when it has a face. */
  readonly avatar?: string | undefined;
  /** Joined to the room (as opposed to only listed in the registry). */
  readonly joined?: boolean | undefined;
}

export interface Mention {
  readonly candidate: Mentionable;
  /** Index of the `@`, and just past the matched name. */
  readonly start: number;
  readonly end: number;
}

const NAME_CHAR = /[\w.-]/;
const isNameChar = (c: string | undefined): boolean => c !== undefined && NAME_CHAR.test(c);

/** The labels a candidate answers to: its id and its name, lowercased, longest first. */
function labels(c: Mentionable): string[] {
  return [...new Set([c.id.toLowerCase(), c.name.toLowerCase()])].filter((l) => l !== "").sort((a, b) => b.length - a.length);
}

/** Whether the `@` at `at` has a word start before it (start of text, space, punctuation other than a name character). */
const startsWord = (text: string, at: number): boolean => at === 0 || !isNameChar(text[at - 1]);

/** A mention a trailing "." or "," does not extend: the name must end where a name character stops. */
function matchAt(text: string, at: number, candidates: readonly Mentionable[]): Mention | null {
  const rest = text.slice(at + 1).toLowerCase();
  let best: Mention | null = null;
  for (const candidate of candidates) {
    for (const label of labels(candidate)) {
      if (!rest.startsWith(label)) continue;
      const pos = at + 1 + label.length;
      const after = text[pos];
      // The name ends the word: "@astra." and "@astra," are Astra, "@astrank" and "@astra.x" are not.
      if (isNameChar(after) && !(after === "." && !isNameChar(text[pos + 1]))) continue;
      if (best === null || pos > best.end) best = { candidate, start: at, end: pos };
    }
  }
  return best;
}

/** The first `@name` in `text` (any position, any case) that names a candidate; null when none does. */
export function findMention(text: string, candidates: readonly Mentionable[]): Mention | null {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (!startsWord(text, at)) continue;
    const found = matchAt(text, at, candidates);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Who a message is for: the agent it names, else `current` (the thread's assignee), else null (nobody
 * in particular: the room's canvas self answers).
 */
export function assigneeFor(text: string, candidates: readonly Mentionable[], current: string | null | undefined): string | null {
  return findMention(text, candidates)?.candidate.id ?? current ?? null;
}

/** The `@query` being typed at `caret` (the autocomplete menu's trigger); null when the caret is not in one. */
export function activeMention(text: string, caret: number): { query: string; start: number; end: number } | null {
  let at = caret - 1;
  while (at >= 0 && isNameChar(text[at])) at -= 1;
  if (at < 0 || text[at] !== "@" || !startsWord(text, at)) return null;
  return { query: text.slice(at + 1, caret), start: at, end: caret };
}

/** The candidates the menu offers for `query`: names starting with it first, then containing it; joined agents before registry ones. */
export function suggest(query: string, candidates: readonly Mentionable[], limit = 6): Mentionable[] {
  const q = query.toLowerCase();
  const rank = (c: Mentionable): number => {
    const ls = labels(c);
    if (q === "") return 1;
    if (ls.some((l) => l.startsWith(q))) return 0;
    return ls.some((l) => l.includes(q)) ? 1 : 2;
  };
  return candidates
    .filter((c) => rank(c) < 2)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || Number(b.c.joined === true) - Number(a.c.joined === true) || a.i - b.i)
    .slice(0, limit)
    .map(({ c }) => c);
}

/** `text` with the `@query` at `active` replaced by `@<name> `, and where the caret goes. */
export function insertMention(text: string, active: { start: number; end: number }, candidate: Mentionable): { text: string; caret: number } {
  const token = `@${candidate.name} `;
  const after = text.slice(active.end);
  const next = `${text.slice(0, active.start)}${token}${after.startsWith(" ") ? after.slice(1) : after}`;
  return { text: next, caret: active.start + token.length };
}
