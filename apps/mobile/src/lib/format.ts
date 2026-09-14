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

function scaled(value: number, unit: string): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}
