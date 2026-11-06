// Open asks, the parsing half: what question a reply asks Isaac, the short label its badge shows,
// the key that tells a repeated question from a new one, and its short id. `ask-store.ts` keeps
// them per thread.

import { createHash } from "node:crypto";
import { MAX_ASK_LABEL, MAX_ASK_QUESTION } from "@relay/protocol";
import { readable } from "../push/preview";

/** A sentence of plain text with its end punctuation and any closing quote or bracket. */
const SENTENCE = /.+?(?:[.!?…]+["')\]]*(?=\s|$)|$)/g;

/** `text` cut to `max` characters at a word boundary (when one is in the second half) with "…"; whole when it fits. */
export function clipAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const head = space > max / 2 ? cut.slice(0, space) : cut.replace(/[\uD800-\uDBFF]$/, "");
  return `${head.replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * The question a reply asks, as plain text: markdown flattened (code blocks and images dropped,
 * links keep their text, emphasis, code ticks and heading, list and quote markers go), split into
 * sentences, the last one ending in "?" (else the last sentence), cut to `MAX_ASK_QUESTION`.
 * "" for a reply with nothing to read.
 */
export function askQuestion(text: string): string {
  const sentences = readable(text).lines.flatMap((line) => (line.match(SENTENCE) ?? []).map((sentence) => sentence.trim()).filter((sentence) => sentence !== ""));
  const question = sentences.findLast((sentence) => /\?["')\]]*$/.test(sentence)) ?? sentences.at(-1) ?? "";
  return clipAt(question, MAX_ASK_QUESTION);
}

/** Shortest rest of a question that a lead-in ("Last one for today: ...") is dropped for. */
const MIN_AFTER_LEAD_IN = 15;

/** `question` without a lead-in before ": " when what follows is long enough to stand alone (its first letter capitalized); whole otherwise. */
export function withoutLeadIn(question: string): string {
  const rest = /^[^:]+?:\s+(.+)$/.exec(question)?.[1];
  return rest === undefined || rest.length < MIN_AFTER_LEAD_IN ? question : `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/** The badge text: the reply's `[[ask-label: ...]]` when it gave one, else the question (`withoutLeadIn`) cut to `MAX_ASK_LABEL`. */
export function askLabel(question: string, explicit?: string): string {
  const label = explicit?.trim().replace(/\s+/g, " ");
  return clipAt(label === undefined || label === "" ? withoutLeadIn(question) : label, MAX_ASK_LABEL);
}

/** The question as a dedupe key: lowercase, punctuation gone, whitespace collapsed. */
export function askKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** An ask's short id: the first 8 hex of the sha1 of `seed`. */
export function askId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 8);
}
