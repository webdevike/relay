// Comment threads on a skill (packages/canvas-live doc-threads.ts), host side: the file they persist
// to beside the skill (SKILL.md itself never holds them) and the turn a comment becomes in the
// assistant's thread, telling it how to answer and how to suggest a change.
//
// Threads file: <relay config>/skill-threads/<encoded name>.json
//   {threads: [{id, quote, resolved, assignee?, messages: ThreadMsg[]}]}
// A thread finds its text again by `quote` when the skill is loaded fresh from the file.

import { z } from "zod";
import { THREAD_ID, type ThreadMsg } from "@relay/canvas-live/threads";
import { readJson, writeJson } from "../reviews/exec";

export interface StoredThread {
  id: string;
  quote: string;
  resolved: boolean;
  assignee?: string;
  messages: ThreadMsg[];
}

const Message = z.object({
  id: z.string().min(1),
  kind: z.enum(["human", "agent"]),
  name: z.string(),
  color: z.string(),
  avatar: z.string().optional(),
  text: z.string(),
  ts: z.number(),
});
const Thread = z.object({
  id: z.string().regex(THREAD_ID),
  quote: z.string(),
  resolved: z.boolean(),
  assignee: z.string().optional(),
  messages: z.array(Message),
});

/** The threads in `file`; malformed entries are skipped, a missing or unreadable file has none. */
export function readThreads(file: string): StoredThread[] {
  const raw = readJson(file, null) as { threads?: unknown } | null;
  if (raw === null || !Array.isArray(raw.threads)) return [];
  const out: StoredThread[] = [];
  for (const entry of raw.threads) {
    const parsed = Thread.safeParse(entry);
    if (!parsed.success) continue;
    const { assignee, messages, ...rest } = parsed.data;
    out.push({ ...rest, ...(assignee === undefined ? {} : { assignee }), messages: messages.map(({ avatar, ...m }) => (avatar === undefined ? m : { ...m, avatar })) });
  }
  return out;
}

/** The file's text for `threads`, compared before writing so an unchanged list never rewrites it. */
export const threadsText = (threads: readonly StoredThread[]): string => JSON.stringify({ threads });

export function writeThreads(file: string, threads: readonly StoredThread[]): void {
  writeJson(file, { threads });
}

export interface CommentTurn {
  readonly skill: string;
  readonly file: string;
  readonly thread: string;
  readonly quote: string;
  /** Who wrote the comment ("Isaac"). */
  readonly from: string;
  readonly text: string;
  /** The assistant's name as its caret and messages show it. */
  readonly as: string;
  /** The command line that runs relay-linux (`bun ~/Eva/work/relay/apps/linux/src/main.ts`). */
  readonly cli: string;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The turn a comment becomes in the assistant's thread: the comment, where it is, and how to answer or suggest. */
export function commentTurn(turn: CommentTurn): string {
  const skill = shellQuote(turn.skill);
  const as = shellQuote(turn.as);
  const base = `${turn.cli} skills`;
  return [
    `[Skill comment from ${turn.from}] ${turn.text}`,
    `(Skill "${turn.skill}", ${turn.file}, comment thread ${turn.thread} on the text ${JSON.stringify(turn.quote)}.)`,
    `${turn.from} wrote this in a comment on that text in Relay Desktop's Skills editor. Answer there, not here: a question gets its answer, a request gets the change and one line on what you did.`,
    `Answer in the thread:`,
    `  ${base} reply ${skill} ${turn.thread} --as ${as} - <<'EOF'`,
    `  <your answer>`,
    `  EOF`,
    `Change the skill only as a suggestion in the thread: ${turn.from} watches your caret type it and accepts or rejects it. Never save it and never write SKILL.md yourself.`,
    `  replace text:   ${base} edit ${skill} --as ${as} --thread ${turn.thread} --find '<text as shown, unique, inside one block>' --replace '<new text>'`,
    `  add blocks:     ${base} edit ${skill} --as ${as} --thread ${turn.thread} --after '<text as shown, unique>' --insert '<markdown: list items, paragraphs, headings>'`,
    `--find and --after match the text as the editor shows it, without markdown syntax. Blocks inserted after a list item's text become items of that list.`,
  ].join("\n");
}
