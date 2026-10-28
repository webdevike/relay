/**
 * Which chat rows take a reaction and the key it is stored under (see "Reactions" in the protocol).
 * Only Isaac's and the agent's own bubbles do, never tool, system, card, status or error rows, and
 * only once the host has them: a phone-side echo or pending turn carries the phone's clock, not
 * omp's timestamp, so its key would match nothing on the host or on Relay desktop.
 */
import { ISAAC_REACTOR, reactionKey, type Reaction, type ThreadReactions } from "@relay/protocol";

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

/**
 * `reactions` with `reactor`'s reaction on bubble `key` set to `emoji` (or cleared for null, and
 * the bubble dropped once nobody's reaction is left), as a new object; the same object when
 * nothing changes.
 */
export function withReaction(
  reactions: Readonly<ThreadReactions>,
  key: string,
  reactor: string,
  emoji: string | null,
  excerpt: string,
  at: number,
): ThreadReactions {
  const bubble = reactions[key];
  if (emoji === null) {
    if (bubble === undefined || !(reactor in bubble)) return reactions;
    const left = { ...bubble };
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by reactor
    delete left[reactor];
    if (Object.keys(left).length > 0) return { ...reactions, [key]: left };
    const next = { ...reactions };
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by reaction key
    delete next[key];
    return next;
  }
  if (bubble?.[reactor]?.emoji === emoji) return reactions;
  return { ...reactions, [key]: { ...bubble, [reactor]: { emoji, excerpt, at } } };
}

/** One badge on a bubble: who reacted and with what. */
export interface BubbleReaction {
  reactor: string;
  emoji: string;
}

/**
 * A bubble's badges in the order they sit, left to right: the assistants' by when they reacted,
 * then Isaac's last, so his is outermost on the bubble's corner.
 */
export function bubbleReactions(byReactor: Readonly<Record<string, Reaction>> | undefined): BubbleReaction[] {
  if (byReactor === undefined) return [];
  const agents = Object.entries(byReactor)
    .filter(([reactor]) => reactor !== ISAAC_REACTOR)
    .sort(([a, first], [b, second]) => first.at - second.at || a.localeCompare(b))
    .map(([reactor, reaction]) => ({ reactor, emoji: reaction.emoji }));
  const isaac = byReactor[ISAAC_REACTOR];
  return isaac === undefined ? agents : [...agents, { reactor: ISAAC_REACTOR, emoji: isaac.emoji }];
}
