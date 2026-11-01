/**
 * One Slack message as a chat bubble: Isaac's on the right in his bubble color, everyone else's on
 * the left under their initials, name and date; attached file names as chips and reactions as
 * emoji-and-count pills under it.
 */
import { StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { reviewAgo, type SlackMessage } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { radii, spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";

const DAY_MS = 86_400_000;

function fileSymbol(name: string): SFSymbol {
  if (/\.(mp4|mov|m4v|webm)$/i.test(name)) return "film";
  if (/\.(png|jpe?g|gif|heic|webp)$/i.test(name)) return "photo";
  return "doc";
}

/** `7h` within a day, else `Oct 28`. */
function slackWhen(at: number, now: number): string {
  return now - at < DAY_MS ? reviewAgo(at, now) : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Slack sends emoji as names (`fire`); a name shows as `:fire:`, a real emoji as itself. */
function emojiText(emoji: string): string {
  return /^[\w+-]+$/.test(emoji) ? `:${emoji}:` : emoji;
}

export function SlackBubble({ message, now }: { message: SlackMessage; now: number }) {
  const colors = useColors();
  const extras = (
    <>
      {message.files.map((file) => (
        <View key={file} style={[styles.chip, { borderColor: colors.hairline }, message.mine && styles.end]}>
          <SymbolView name={fileSymbol(file)} size={14} tintColor={colors.textMuted} />
          <Text variant="label" numberOfLines={1}>
            {file}
          </Text>
        </View>
      ))}
      {message.reactions.length > 0 && (
        <View style={[styles.reactions, message.mine && styles.end]}>
          {message.reactions.map((reaction) => (
            <View key={reaction.emoji} style={[styles.chip, { borderColor: colors.hairline }]} accessibilityLabel={`${reaction.emoji}, ${String(reaction.count)}`}>
              <Text variant="label">{emojiText(reaction.emoji)}</Text>
              <Text variant="label" color="textMuted" tabular>
                {String(reaction.count)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
  if (message.mine) {
    return (
      <View style={styles.mineWrap}>
        <View style={[styles.bubble, styles.end, { backgroundColor: colors.bubbleUser }]}>
          <Text style={styles.mineText}>{message.text}</Text>
        </View>
        {extras}
      </View>
    );
  }
  return (
    <View style={styles.theirs}>
      <Avatar name={message.author} size={32} />
      <View style={styles.theirsBody}>
        <Text variant="label" color="textMuted">
          {`${message.author}  `}
          <Text variant="label" color="textFaint">
            {slackWhen(message.at, now)}
          </Text>
        </Text>
        <View style={[styles.bubble, { backgroundColor: colors.surfaceRaised }]}>
          <MessageText text={message.text} />
        </View>
        {extras}
      </View>
    </View>
  );
}

/** "4 replies" over a hairline after a thread's parent. */
export function RepliesDivider({ count }: { count: number }) {
  const colors = useColors();
  return (
    <View style={styles.divider}>
      <Text variant="label" color="textFaint">{`${String(count)} ${count === 1 ? "reply" : "replies"}`}</Text>
      <View style={[styles.rule, { backgroundColor: colors.hairline }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  mineWrap: { alignItems: "flex-end", gap: spacing.sm, paddingLeft: spacing.xxxl + spacing.lg },
  mineText: { color: "#FFFFFF" },
  end: { alignSelf: "flex-end" },
  bubble: { alignSelf: "flex-start", maxWidth: "100%", borderRadius: radii.lg + 4, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  theirs: { flexDirection: "row", gap: spacing.md, paddingRight: spacing.xxxl },
  theirsBody: { flex: 1, gap: spacing.xs, alignItems: "flex-start" },
  chip: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, maxWidth: "100%" },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  divider: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
});
