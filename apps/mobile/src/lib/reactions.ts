/**
 * Which chat rows take a reaction and the key it is stored under (see "Reactions" in the protocol).
 * Only Isaac's and the agent's own bubbles do, never tool, system, card, status or error rows, and
 * only once the host has them: a phone-side echo or pending turn carries the phone's clock, not
 * omp's timestamp, so its key would match nothing on the host or on Relay desktop.
 */
import { reactionKey, type Reaction } from "@relay/protocol";

export type ReactableRole = "user" | "assistant";

/** The "more" picker's emoji beyond the quick picks, by section; each one passes the protocol's `ReactionEmoji`. */
export const MORE_REACTIONS: readonly { title: string; emoji: readonly string[] }[] = [
  {
    title: "Faces",
    emoji: ["😀", "😁", "🤣", "😊", "😍", "🥰", "😘", "😎", "🤩", "🥳", "😏", "🤔", "🫡", "🤗", "🙃", "😉", "😌", "😴", "🥱", "😬", "😮", "😲", "😳", "🥺", "😢", "😭", "😤", "😡", "🤯", "😱", "🤢", "🤮", "🤡", "💀", "👀", "🫠"],
  },
  {
    title: "Hands",
    emoji: ["👏", "🙌", "🙏", "👌", "🤌", "✌️", "🤞", "🤝", "💪", "👋", "🫶", "✋", "👆", "👉", "🤘", "🖖"],
  },
  {
    title: "Hearts",
    emoji: ["🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "❤️‍🔥", "💯", "💖", "💕"],
  },
  {
    title: "Things",
    emoji: ["🔥", "✨", "⭐", "🎉", "🎯", "🚀", "✅", "❌", "⚠️", "💡", "📌", "🧠", "🐛", "🛠️", "⏰", "☕", "🍕", "🏆", "💰", "📈", "📉", "🤖", "👻", "🌈"],
  },
];

/** The reaction role of a row's `role`, or null when the row takes no reaction. */
export function reactableRole(role: string): ReactableRole | null {
  return role === "user" || role === "assistant" ? role : null;
}

/**
 * The reaction key of a transcript row, or null when it takes none: a non-bubble role, or a row
 * that is still the phone's own stand-in (`pending`) for words the host has not listed yet.
 */
export function bubbleReactionKey(message: { readonly role: string; readonly at: number }, pending = false): string | null {
  if (pending) return null;
  const role = reactableRole(message.role);
  return role === null ? null : reactionKey(role, message.at);
}

/** `reactions` with `key` set to `emoji` (or cleared for null), as a new object; the same object when nothing changes. */
export function withReaction(
  reactions: Readonly<Record<string, Reaction>>,
  key: string,
  emoji: string | null,
  excerpt: string,
  at: number,
): Record<string, Reaction> {
  if (emoji === null) {
    if (!(key in reactions)) return reactions;
    const next = { ...reactions };
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by reaction key
    delete next[key];
    return next;
  }
  if (reactions[key]?.emoji === emoji) return reactions;
  return { ...reactions, [key]: { emoji, excerpt, at } };
}
