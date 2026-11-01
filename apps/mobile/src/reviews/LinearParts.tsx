/** A Linear ticket's pieces: property rows, the folded description and a comment thread as one timeline card. */
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { reviewAgo, type LinearComment } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { nameTint } from "@/lib/format";
import { tapHaptic } from "@/lib/haptics";
import { spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { FEED_AVATAR, FeedCard } from "@/ui/FeedCard";
import { Text } from "@/ui/Text";
import type { LinearThread } from "./model";

/** Description height before "Show full description". */
const FOLDED_HEIGHT = 160;

export function PropertyRow({ label, children, onPress }: { label: string; children: ReactNode; onPress?: (() => void) | undefined }) {
  const colors = useColors();
  return (
    <Pressable
      disabled={onPress === undefined}
      accessibilityRole={onPress === undefined ? undefined : "link"}
      onPress={onPress}
      style={({ pressed }) => [styles.property, { borderBottomColor: colors.hairline }, pressed && { opacity: 0.6 }]}
    >
      <Text color="textMuted">{label}</Text>
      <View style={styles.value}>{children}</View>
    </Pressable>
  );
}

/** The description clipped to a few lines until "Show full description". */
export function FoldedMarkdown({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  return (
    <View style={styles.folded}>
      <View style={open ? undefined : styles.clip}>
        <View
          onLayout={(event) => {
            setTall(event.nativeEvent.layout.height > FOLDED_HEIGHT);
          }}
        >
          <MessageText text={text} large />
        </View>
      </View>
      {tall && (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            tapHaptic();
            setOpen((value) => !value);
          }}
        >
          <Text color="textMuted">{open ? "Show less" : "Show full description"}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A comment's author line inside a thread card: initials avatar, bold name, faint age. */
function ReplyHead({ comment, now }: { comment: LinearComment; now: number }) {
  return (
    <View style={styles.replyHead}>
      <Avatar name={comment.author.name} size={FEED_AVATAR} tint={nameTint(comment.author.name)} />
      <Text variant="label" numberOfLines={1} style={styles.replyName}>
        {comment.author.name}
      </Text>
      <Text variant="label" color="textFaint">{`· ${reviewAgo(comment.at, now)}`}</Text>
    </View>
  );
}

export interface LinearThreadCardProps {
  thread: LinearThread;
  now: number;
  /** Rewrites a body before it renders (host media urls). */
  body: (markdown: string) => string;
  onReply: (comment: LinearComment) => void;
}

/** A top-level comment as a card, its replies indented under a hairline inside it, then "Reply in thread". */
export function LinearThreadCard({ thread, now, body, onReply }: LinearThreadCardProps) {
  const colors = useColors();
  const { comment, replies } = thread;
  return (
    <FeedCard
      avatar={<Avatar name={comment.author.name} size={FEED_AVATAR} tint={nameTint(comment.author.name)} />}
      name={comment.author.name}
      meta={`· ${reviewAgo(comment.at, now)}`}
      badge={
        comment.mentionsMe ? (
          <Text variant="caption" color="accent" style={styles.badge}>
            Mentions you
          </Text>
        ) : undefined
      }
    >
      <MessageText text={body(comment.body)} large />
      {replies.map((reply) => (
        <View key={reply.id} style={[styles.reply, { borderTopColor: colors.hairline }]}>
          <ReplyHead comment={reply} now={now} />
          <MessageText text={body(reply.body)} large />
        </View>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Reply in thread to ${comment.author.name}`}
        hitSlop={8}
        onPress={() => {
          tapHaptic();
          onReply(comment);
        }}
        style={({ pressed }) => [styles.replyButton, pressed && { opacity: 0.6 }]}
      >
        <SymbolView name="arrowshape.turn.up.left" size={13} tintColor={colors.textMuted} />
        <Text variant="label" color="textMuted">
          Reply in thread
        </Text>
      </Pressable>
    </FeedCard>
  );
}

const styles = StyleSheet.create({
  property: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  value: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  folded: { gap: spacing.sm },
  clip: { maxHeight: FOLDED_HEIGHT, overflow: "hidden" },
  badge: { marginLeft: "auto" },
  reply: { marginLeft: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, gap: spacing.xs },
  replyHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  replyName: { fontWeight: "700", flexShrink: 1 },
  replyButton: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingTop: spacing.xs },
});
