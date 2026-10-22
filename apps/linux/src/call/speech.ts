// Turning an assistant's reply (markdown, streamed in) into sentences a call can say. Only the part
// before the details marker is spoken; code, images, tables, sign-in tokens and markup are dropped
// and links become their text, so nothing reads out as symbols.

import { spokenPart } from "../assistant/voice";
import { SILENCE_MARKER } from "../assistant/service";
import { splitSignin } from "../assistant/signin";

/**
 * `markdown` as plain speech. Lines become sentences (a finished line without end punctuation
 * gets a period), so list items are said one by one. While `streaming`, an unclosed code fence
 * hides everything after it and a half-written sign-in token is held back. Clock times are
 * spelled the way pocket-tts says them right ("2 12", "9 oh 5", "12 o'clock"); it reads "2:12"
 * as nonsense.
 */
export function speakable(markdown: string, streaming: boolean): string {
  const lines = splitSignin(spokenPart(markdown), streaming)
    .text.replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`?/g, "$1")
    .replace(/[*_~]{1,3}(?=\S)|(?<=\S)[*_~]{1,3}/g, "")
    .replace(/\s+[—–]\s+|—/g, ", ")
    .replace(/\b(\d{1,2}):00(?=\s*[AaPp]\.?[Mm]\b)/g, "$1")
    .replace(/\b(\d{1,2}):00\b/g, "$1 o'clock")
    .replace(/\b(\d{1,2}):0(\d)\b/g, "$1 oh $2")
    .replace(/\b(\d{1,2}):([1-5]\d)\b/g, "$1 $2")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+)/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("|"));
  return lines.map((line, index) => (index < lines.length - 1 && !/[.!?:;,]$/.test(line) ? `${line}.` : line)).join(" ");
}

/** `text` cut into sentences at end punctuation followed by a space. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * One reply as a call hears it while it streams in: `next` returns the sentences not said yet that
 * are certainly finished (all of them once `settled`). Sentences are counted rather than sliced by
 * offset, so markup that resolves later in the stream does not shift what was already said. The
 * silence marker, whole or on its way in, is never said.
 */
export class ReplySpeech {
  private said = 0;

  next(text: string, settled: boolean): string[] {
    const trimmed = text.trim();
    if (trimmed === SILENCE_MARKER || (!settled && SILENCE_MARKER.startsWith(trimmed))) return [];
    const all = sentences(speakable(text, !settled));
    const ready = settled ? all.length : all.length - 1;
    if (ready <= this.said) return [];
    const fresh = all.slice(this.said, ready);
    this.said = ready;
    return fresh;
  }
}
