// What a GPT-Live voice knows when a call starts: a short brief, never the thread. The voice only
// needs enough to follow what Isaac means and to handle small talk; anything that needs real
// context or work goes to the assistant behind it through delegation. Every part is capped, so the
// whole startup input stays around 300-600 tokens however long the thread or its memory file grows:
//   - who Isaac is lately, and today's open threads: headlines of `## About Isaac lately`,
//     `## Promised` and the newest `## Tracking` items of the assistant's `thread.md`;
//   - the last few turns of the thread, flattened to plain text;
//   - the time, and the greeting.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { plainSpeech } from "../call/speech";
import type { LiveInputMessage } from "./openai";

/** Assistant `agent`'s thread memory, `<agentHome>/work/eva/agents/<agent>/thread.md`; null when it has none. */
export async function readThreadMemory(agentHome: string | null, agent: string): Promise<string | null> {
  if (agentHome === null) return null;
  return readFile(join(agentHome, "work", "eva", "agents", agent, "thread.md"), "utf8").catch(() => null);
}

/** Items per memory section, and the length of one headline. */
export const ABOUT_ITEMS = 3;
export const PROMISED_ITEMS = 3;
export const TRACKING_ITEMS = 5;
export const HEADLINE_CHARS = 100;
/** Thread turns seeding the voice, newest last, and the length of one. */
export const RECENT_TURNS = 4;
export const TURN_CHARS = 180;

const DATED = /^(\d{4}-\d{2}-\d{2})\s+/;
const NOTHING = /^\(?(none|nothing to report)\)?\.?$/i;

/** The bullet items under each `## ` heading of a `thread.md`, in file order. */
export function memorySections(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = [];
      sections.set((heading[1] ?? "").toLowerCase(), current);
      continue;
    }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (current !== null && item !== null) current.push(item[1] ?? "");
  }
  return sections;
}

/** `text` cut to `max` characters at a word boundary, with an ellipsis when cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** One memory item as a headline: its date kept, its first sentence, plain text, capped. */
export function headline(item: string): string {
  const flat = plainSpeech(item, false).replace(/\s+/g, " ").trim();
  const dated = DATED.exec(flat);
  const body = dated === null ? flat : flat.slice(dated[0].length);
  const first = /^.+?[.!?](?=\s|$)/.exec(body)?.[0] ?? body;
  return clip(dated === null ? first : `${dated[1] ?? ""} ${first}`, HEADLINE_CHARS);
}

/** The newest `count` items: by their date when dated (later in the file wins a tie), else the last ones. */
function newest(items: readonly string[], count: number): string[] {
  return items
    .map((item, index) => ({ item, index, date: DATED.exec(item)?.[1] ?? "" }))
    .sort((a, b) => (a.date === b.date ? b.index - a.index : a.date < b.date ? 1 : -1))
    .slice(0, count)
    .map((entry) => entry.item);
}

/** The memory part of the brief, or null when the memory file has nothing to say. */
export function memoryBrief(title: string, markdown: string | null): string | null {
  if (markdown === null) return null;
  const sections = memorySections(markdown);
  const pick = (name: string, count: number, latest: boolean): string[] => {
    const items = (sections.get(name) ?? []).filter((item) => !NOTHING.test(item.trim()));
    return (latest ? newest(items, count) : items.slice(-count)).map(headline);
  };
  const about = pick("about isaac lately", ABOUT_ITEMS, true);
  const promised = pick("promised", PROMISED_ITEMS, false);
  const tracking = pick("tracking", TRACKING_ITEMS, true);
  if (about.length + promised.length + tracking.length === 0) return null;
  const lines = [`Background from ${title}'s notes, only so you know what Isaac means. These may be out of date: for their status or details, delegate.`];
  if (about.length > 0) lines.push("About Isaac:", ...about.map((line) => `- ${line}`));
  if (promised.length > 0) lines.push(`${title} promised him:`, ...promised.map((line) => `- ${line}`));
  if (tracking.length > 0) lines.push("Open threads, newest first:", ...tracking.map((line) => `- ${line}`));
  return lines.join("\n");
}

/** The last RECENT_TURNS turns of the thread, plain and capped. */
export function recentTurns(rows: readonly { readonly role: string; readonly text: string }[]): LiveInputMessage[] {
  const recent: LiveInputMessage[] = [];
  for (const row of [...rows].reverse()) {
    if (recent.length === RECENT_TURNS) break;
    if (row.role !== "user" && row.role !== "assistant") continue;
    const text = clip(plainSpeech(row.text, false).replace(/\s+/g, " ").trim(), TURN_CHARS);
    if (text === "" || NOTHING.test(text)) continue;
    recent.unshift({ role: row.role, text });
  }
  return recent;
}

/** Startup input of a call: the brief, the last turns, the time, and the greeting. */
export function liveBrief(title: string, memory: string | null, rows: readonly { readonly role: string; readonly text: string }[], clock: string): LiveInputMessage[] {
  const background = memoryBrief(title, memory);
  return [
    ...(background === null ? [] : [{ role: "developer" as const, text: background }]),
    ...recentTurns(rows),
    { role: "developer", text: clock },
    { role: "developer", text: `Isaac just started a call with ${title}. Greet him now in at most four words, like "Hey, what's up?", then pause and listen.` },
  ];
}

/** Rough token count of startup input (about four characters a token), for the log. */
export function estimatedTokens(texts: readonly string[]): number {
  return Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);
}
