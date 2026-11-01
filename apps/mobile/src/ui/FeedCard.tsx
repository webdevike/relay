import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { highlightParts, longDate } from "@/lib/format";
import { spacing, useColors } from "@/theme";
import { Text } from "./Text";

/** Size of the avatar or portrait in a card's header. */
export const FEED_AVATAR = 22;
/** Corner radius of a timeline card. */
const RADIUS = 24;

export interface FeedCardProps {
  /** `FEED_AVATAR` disc before the name: an initials `Avatar` or an assistant's `Portrait`. */
  avatar?: ReactNode;
  /** Bold author; without one the card has no header (a ticket's description). */
  name?: string | undefined;
  /** Faint text after the name: `· 1d ago`, `· AI assistant`. */
  meta?: string | undefined;
  /** Right of the header: a verdict pill, a Private mark. */
  badge?: ReactNode;
  children: ReactNode;
}

/** One rounded raised card of an item's timeline (Linear's issue view): a header row of avatar, bold name and faint meta, then the body. */
export function FeedCard({ avatar, name, meta, badge, children }: FeedCardProps) {
  const colors = useColors();
  return (
    <View style={[styles.card, { backgroundColor: colors.surfaceRaised }]}>
      {name !== undefined && (
        <View style={styles.head}>
          {avatar}
          <Text variant="label" numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          {meta !== undefined && (
            <Text variant="label" color="textFaint" numberOfLines={1} style={styles.meta}>
              {meta}
            </Text>
          )}
          {badge}
        </View>
      )}
      {children}
    </View>
  );
}

export interface ActivityLineProps {
  actor: string;
  /** What happened after the actor's name. */
  text: string;
  /** Words in `text` drawn bright (state names, a commit sha). */
  highlights: readonly string[];
  at: number;
}

/** A history line between timeline cards: a small hollow circle, the actor and what they did, and its full date under it. */
export function ActivityLine({ actor, text, highlights, at }: ActivityLineProps) {
  const colors = useColors();
  const date = longDate(at);
  return (
    <View style={styles.activity} accessible accessibilityLabel={`${actor} ${text}, ${date}`}>
      <View style={[styles.ring, { borderColor: colors.textFaint }]} />
      <View style={styles.activityText}>
        <Text color="textMuted">
          <Text style={styles.bright}>{actor}</Text>
          {" "}
          {highlightParts(text, highlights).map((part, i) =>
            part.bright ? (
              <Text key={i} style={styles.bright}>
                {part.text}
              </Text>
            ) : (
              part.text
            ),
          )}
        </Text>
        <Text variant="caption" color="textFaint">
          {date}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: RADIUS, padding: spacing.lg, gap: spacing.sm },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { fontWeight: "700", flexShrink: 1 },
  meta: { flexShrink: 1 },
  activity: { flexDirection: "row", gap: spacing.md, paddingHorizontal: spacing.sm },
  ring: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, marginTop: 6 },
  activityText: { flex: 1, gap: 2 },
  bright: { fontWeight: "600" },
});
