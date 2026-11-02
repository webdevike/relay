/**
 * One Slack message as a timeline card, Isaac's own the same as everyone's: initials, bold name,
 * faint date, the text, attached file names as chips and reactions as emoji-and-count pills.
 */
import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { reviewAgo, type SlackMessage } from "@relay/protocol";
import { emojify, reactionEmoji } from "@relay/slack-emoji";
import { MessageText } from "@/agents/MessageText";
import { MarkdownImages } from "@/agents/MarkdownImages";
import { openExternal } from "@/lib/links";
import { nameTint } from "@/lib/format";
import { radii, spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { FEED_AVATAR, FeedCard } from "@/ui/FeedCard";
import { Text } from "@/ui/Text";

const DAY_MS = 86_400_000;

function fileSymbol(name: string): SFSymbol {
  if (/\.(mp4|mov|m4v|webm)$/i.test(name)) return "film";
  if (/\.(png|jpe?g|gif|heic|webp)$/i.test(name)) return "photo";
  return "doc";
}

/**
 * One Slack message as a card. Images the host fetched through the Slack app show inline (a tap
 * opens the viewer); any other file is a chip that opens the thread in Slack (`link`).
 */
export function SlackCard({ message, now, base, link }: { message: SlackMessage; now: number; base: string | null; link?: string }) {
  const colors = useColors();
  // `7h` within a day, else `Oct 28`.
  const when = now - message.at < DAY_MS ? reviewAgo(message.at, now) : new Date(message.at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const withImage = base === null ? [] : message.attachments.filter((a) => a.src !== null);
  const images = withImage.map((a) => ({ src: `${base ?? ""}${a.src ?? ""}`, alt: a.name }));
  const shown = new Set(withImage.map((a) => a.name));
  return (
    <FeedCard
      avatar={<Avatar name={message.author} size={FEED_AVATAR} tint={nameTint(message.author)} />}
      name={message.author}
      meta={`· ${when}`}
      badge={
        message.mentionsMe ? (
          <Text variant="caption" color="accent" style={styles.badge}>
            Mentions you
          </Text>
        ) : undefined
      }
    >
      <MessageText text={emojify(message.text)} large />
      {images.length > 0 && <MarkdownImages images={images} />}
      {message.files
        .filter((file) => !shown.has(file))
        .map((file) => (
          <Pressable
            key={file}
            onPress={link === undefined ? undefined : () => { openExternal(link); }}
            accessibilityRole={link === undefined ? undefined : "link"}
            accessibilityHint={link === undefined ? undefined : "Opens the thread in Slack"}
            style={[styles.chip, { borderColor: colors.hairline }]}
          >
            <SymbolView name={fileSymbol(file)} size={14} tintColor={colors.textMuted} />
            <Text variant="label" numberOfLines={1}>
              {file}
            </Text>
          </Pressable>
        ))}
      {message.reactions.length > 0 && (
        <View style={styles.reactions}>
          {message.reactions.map((reaction) => (
            <View key={reaction.emoji} style={[styles.chip, { borderColor: colors.hairline }]} accessibilityLabel={`${reaction.emoji}, ${String(reaction.count)}`}>
              <Text variant="label">{reactionEmoji(reaction.emoji)}</Text>
              <Text variant="label" color="textMuted" tabular>
                {String(reaction.count)}
              </Text>
            </View>
          ))}
        </View>
      )}
    </FeedCard>
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
  badge: { marginLeft: "auto" },
  chip: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, maxWidth: "100%" },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  divider: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.sm },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
});
