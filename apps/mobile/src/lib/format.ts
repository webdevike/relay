/** Formatting helpers shared across screens. Pure, no React Native imports. */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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
