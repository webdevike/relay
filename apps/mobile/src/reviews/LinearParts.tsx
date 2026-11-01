/** A Linear ticket's pieces: property rows, the folded description and the threaded comments. */
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { reviewAgo, type LinearComment } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { tapHaptic } from "@/lib/haptics";
import { spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { Text } from "@/ui/Text";
import { linearThreads } from "./model";

/** Description height before "Show full description". */
const FOLDED_HEIGHT = 120;

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
          <MessageText text={text} />
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

function CommentView({ comment, now, body, small }: { comment: LinearComment; now: number; body: string; small: boolean }) {
  return (
    <View style={styles.comment}>
      <Avatar name={comment.author.name} size={small ? 26 : 32} />
      <View style={styles.commentBody}>
        {comment.mentionsMe && (
          <Text variant="label" color="accent">
            Mentions you
          </Text>
        )}
        <View style={styles.commentHead}>
          <Text variant="title">{comment.author.name}</Text>
          <Text variant="label" color="textFaint">
            {reviewAgo(comment.at, now)}
          </Text>
        </View>
        <MessageText text={body} />
      </View>
    </View>
  );
}

export interface LinearCommentsProps {
  comments: readonly LinearComment[];
  now: number;
  /** Rewrites a body before it renders (host media urls). */
  body: (markdown: string) => string;
  onReply: (comment: LinearComment) => void;
}

export function LinearComments({ comments, now, body, onReply }: LinearCommentsProps) {
  const colors = useColors();
  const threads = linearThreads(comments);
  return (
    <View style={styles.comments}>
      <Text variant="title" style={styles.heading}>
        Comments
      </Text>
      {threads.length === 0 && <Text color="textMuted">No comments yet.</Text>}
      {threads.map((thread) => (
        <View key={thread.comment.id} style={styles.thread}>
          <CommentView comment={thread.comment} now={now} body={body(thread.comment.body)} small={false} />
          {thread.replies.map((reply) => (
            <View key={reply.id} style={styles.reply}>
              <CommentView comment={reply} now={now} body={body(reply.body)} small />
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reply in thread to ${thread.comment.author.name}`}
            hitSlop={8}
            onPress={() => {
              tapHaptic();
              onReply(thread.comment);
            }}
            style={({ pressed }) => [styles.replyButton, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name="arrowshape.turn.up.left" size={14} tintColor={colors.accent} />
            <Text color="accent">Reply in thread</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  property: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  value: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  folded: { gap: spacing.sm, paddingTop: spacing.md },
  clip: { maxHeight: FOLDED_HEIGHT, overflow: "hidden" },
  comments: { gap: spacing.lg, paddingTop: spacing.xl },
  heading: { fontSize: 20, lineHeight: 26 },
  thread: { gap: spacing.md },
  comment: { flexDirection: "row", gap: spacing.md },
  commentBody: { flex: 1, gap: 2 },
  commentHead: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  reply: { marginLeft: 44 },
  replyButton: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginLeft: 44 },
});
