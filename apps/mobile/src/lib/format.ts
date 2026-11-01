/** Formatting helpers shared across screens. Pure, no React Native imports. */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KIB = 1024;

/**
 * Compact relative-time label for a past timestamp, given `now` (defaults to `Date.now()`).
 * <60s -> "now"; <60m -> "Nm"; <24h -> "Nh"; else -> "Nd".
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  return `${Math.floor(delta / DAY)}d`;
}

/** Truncates `text` to `maxLength`, appending an ellipsis when it was cut. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

/** "1 session", "3 sessions". Regular English plurals only. */
export function countOf(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** "512 B", "3.4 KB", "12 MB": one decimal below 10 of a unit, whole numbers above. */
export function byteSize(bytes: number): string {
  const clamped = Math.max(0, bytes);
  if (clamped < KIB) return `${Math.round(clamped)} B`;
  if (clamped < KIB * KIB) return scaled(clamped / KIB, "KB");
  if (clamped < KIB * KIB * KIB) return scaled(clamped / KIB / KIB, "MB");
  return scaled(clamped / KIB / KIB / KIB, "GB");
}

/** Media position as m:ss ("0:07", "12:30"); negatives clamp to 0:00. */
export function mediaClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How long something has run: "45s", "2m 10s", "1h 5m"; negatives clamp to "0s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / SECOND));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** A token count: "850 tokens", "41k tokens", "1.2M tokens" (whole thousands, one decimal of millions). */
export function tokenCount(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return countOf(n, "token");
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

function scaled(value: number, unit: string): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `5:53 PM` in local time (built by hand: ICU puts a narrow no-break space before PM). */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours() % 12 || 12)}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

/** `October 30, 2026 at 5:53 PM` in local time: an activity line's date. */
export function longDate(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()] ?? ""} ${String(d.getDate())}, ${String(d.getFullYear())} at ${clockTime(at)}`;
}

/** `text` cut into runs, each `highlights` word (leftmost, then longest) its own bright run. */
export function highlightParts(text: string, highlights: readonly string[]): { text: string; bright: boolean }[] {
  const words = highlights.filter((word) => word !== "");
  const parts: { text: string; bright: boolean }[] = [];
  let rest = text;
  while (rest !== "") {
    let best: { index: number; word: string } | null = null;
    for (const word of words) {
      const index = rest.indexOf(word);
      if (index >= 0 && (best === null || index < best.index || (index === best.index && word.length > best.word.length))) best = { index, word };
    }
    if (best === null) {
      parts.push({ text: rest, bright: false });
      break;
    }
    if (best.index > 0) parts.push({ text: rest.slice(0, best.index), bright: false });
    parts.push({ text: best.word, bright: true });
    rest = rest.slice(best.index + best.word.length);
  }
  return parts;
}

/** Identity colors for initials avatars of people with no photo. */
const NAME_TINTS = ["#E57373", "#F0A35E", "#E8C64B", "#7BC67E", "#4DB6AC", "#64B5F6", "#9575CD", "#F06292"];

/** One stable `#RRGGBB` per name (case and spacing aside), for `Avatar` `tint`. */
export function nameTint(name: string): string {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return NAME_TINTS[hash % NAME_TINTS.length] ?? "#64B5F6";
}
