/**
 * Astra in an item's timeline, as private threads: Isaac's ask as his own card marked Private, his
 * replies and hers indented under a hairline inside it (the phone's thread card, Linear's comment
 * thread), and the thread's own "Reply to Astra" box at the end. Her replies carry her portrait,
 * "Astra · AI assistant" and a Private mark; her answer grows in place, typing dots stand in while
 * she works with nothing to show yet, her tool work shows as faint lines. Nothing here is ever posted.
 */
import { useRef, useState, type ReactNode } from "react";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { reviewAgo, type AstraItem, type AstraTurn } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { nameTint } from "@/lib/format";
import { portraitOf } from "@/lib/portrait";
import { useAssistantStore } from "@/state/assistant";
import { spacing, useColors, useScheme } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { FEED_AVATAR, FeedCard } from "@/ui/FeedCard";
import { IconButton } from "@/ui/IconButton";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { TypingDots } from "@/ui/TypingDots";
import { useItemReveal } from "./ItemScreen";
import { astraAnswer, astraTyping, type AstraThread } from "./model";

const ASTRA = { id: "astra" } as const;
const ACTION_HEIGHT = 32;
const SEND_SIZE = 30;
const FIELD_MAX_HEIGHT = 120;

/** The lock and words at the right of a private card's header. */
function PrivateMark({ label }: { label: string }) {
  const colors = useColors();
  return (
    <View style={styles.private} accessibilityLabel={label}>
      <SymbolView name="lock.fill" size={10} tintColor={colors.textFaint} />
      <Text variant="caption" color="textFaint" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** An author line inside a thread card: avatar, bold name, faint meta, the Private mark. */
function ReplyHead({ avatar, name, meta }: { avatar: ReactNode; name: string; meta: string | undefined }) {
  return (
    <View style={styles.replyHead}>
      {avatar}
      <Text variant="label" numberOfLines={1} style={styles.replyName}>
        {name}
      </Text>
      {meta !== undefined && (
        <Text variant="label" color="textFaint" numberOfLines={1} style={styles.replyMeta}>
          {meta}
        </Text>
      )}
      <PrivateMark label="Private" />
    </View>
  );
}

interface AstraReplyProps {
  turns: readonly AstraTurn[];
  /** The newest reply of the live thread: it shows her working, waiting or failing, and Stop. */
  last: boolean;
  item: AstraItem | undefined;
  onUseAsReply: (text: string) => void;
  onOpenSession: (sessionId: string) => void;
  onStop: () => void;
}

/** One run of Astra's turns: tool work as faint lines, her answer (a caret while it streams) or her typing dots, then small actions. */
function AstraReply({ turns, last, item, onUseAsReply, onOpenSession, onStop }: AstraReplyProps) {
  const colors = useColors();
  const agent = useAssistantStore((state) => state.agents?.find((a) => a.id === "astra"));
  const working = last && item?.working === true;
  const streaming = turns.some((turn) => turn.streaming);
  const answer = streaming ? null : astraAnswer(turns);
  const sessionId = item?.sessionId ?? null;
  const waiting = last ? (item?.waiting ?? null) : null;
  const error = last ? (item?.error ?? null) : null;
  return (
    <View style={[styles.reply, { borderTopColor: colors.hairline }]}>
      <ReplyHead avatar={<Portrait name="Astra" portrait={portraitOf(agent ?? ASTRA)} size={FEED_AVATAR} />} name="Astra" meta="· AI assistant" />
      {turns.map((turn) =>
        turn.role === "tool" ? (
          <Text key={turn.id} variant="caption" color="textFaint" numberOfLines={1}>
            {turn.text}
          </Text>
        ) : (
          <MessageText key={turn.id} text={turn.streaming ? `${turn.text}▍` : turn.text} streaming={turn.streaming} large />
        ),
      )}
      {astraTyping(turns, working) && <TypingDots fill={colors.surface} label="Astra is typing" />}
      {waiting !== null && <Banner tone="warn" icon="hand.raised" message="Astra is waiting on you" detail={waiting} detailLines={3} />}
      {error !== null && <Banner tone="danger" message={error} detailLines={3} />}
      {(answer !== null || (working && sessionId !== null)) && (
        <View style={styles.actions}>
          {answer !== null && (
            <Button
              label="Use as reply"
              variant="secondary"
              height={ACTION_HEIGHT}
              testID="astra-use-as-reply"
              onPress={() => {
                onUseAsReply(answer);
              }}
            />
          )}
          {sessionId !== null && (
            <Button
              label="Open session"
              variant="ghost"
              height={ACTION_HEIGHT}
              testID="astra-open-session"
              onPress={() => {
                onOpenSession(sessionId);
              }}
            />
          )}
          {working && sessionId !== null && <Button label="Stop" variant="secondary" tone="danger" height={ACTION_HEIGHT} accessibilityLabel="Stop Astra" testID="astra-stop" onPress={onStop} />}
        </View>
      )}
    </View>
  );
}

/** The thread's own box: what he types goes to Astra in this thread at once, never posted. */
function ThreadReplyField({ onSend }: { onSend: (text: string) => void }) {
  const colors = useColors();
  const scheme = useScheme();
  const reveal = useItemReveal();
  const box = useRef<View>(null);
  const [draft, setDraft] = useState("");
  const empty = draft.trim() === "";
  const send = () => {
    if (empty) return;
    onSend(draft);
    setDraft("");
  };
  return (
    <View ref={box} style={[styles.field, { backgroundColor: colors.surface }]}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Reply to Astra"
        placeholderTextColor={colors.textFaint}
        multiline
        keyboardAppearance={scheme}
        selectionColor={colors.accent}
        accessibilityLabel="Reply to Astra, private"
        testID="astra-thread-reply-field"
        onFocus={() => {
          // Up from the bottom of the card, the keyboard would cover the box: bring it above the dock once the keyboard is up.
          if (Keyboard.isVisible()) {
            reveal(box.current);
            return;
          }
          const sub = Keyboard.addListener("keyboardDidShow", () => {
            sub.remove();
            reveal(box.current);
          });
        }}
        style={[styles.input, { color: colors.text }]}
      />
      <IconButton
        symbol="arrow.up"
        size={SEND_SIZE}
        backgroundColor={empty ? colors.surfaceRaised : colors.text}
        tintColor={empty ? colors.textFaint : colors.bg}
        disabledOpacity={1}
        accessibilityLabel="Send to Astra"
        testID="astra-thread-reply-send"
        disabled={empty}
        onPress={send}
      />
    </View>
  );
}

export interface AstraThreadCardProps {
  thread: AstraThread;
  item: AstraItem | undefined;
  now: number;
  /** Isaac's name where the item knows it; else "You". */
  name: string;
  onUseAsReply: (text: string) => void;
  onOpenSession: (sessionId: string) => void;
  onStop: () => void;
  /** Sends a reply typed in this thread's box, given the root's text for its prefix. */
  onReply: (rootText: string, text: string) => void;
}

/** One private thread: his root ask as his card, the replies indented inside it, then "Reply to Astra". */
export function AstraThreadCard({ thread, item, now, name, onUseAsReply, onOpenSession, onStop, onReply }: AstraThreadCardProps) {
  const colors = useColors();
  const { root, replies } = thread;
  const lastReply = replies[replies.length - 1];
  const age = (at: number) => (Number.isFinite(at) ? `· ${reviewAgo(at, now)}` : undefined);
  const me = <Avatar name={name} size={FEED_AVATAR} tint={nameTint(name)} />;
  return (
    <FeedCard {...(root === null ? {} : { avatar: me, name, meta: age(root.at), badge: <PrivateMark label="Private" /> })}>
      {root !== null && <MessageText text={root.text} large />}
      {replies.map((part) =>
        part.kind === "ask" ? (
          <View key={part.id} style={[styles.reply, { borderTopColor: colors.hairline }]}>
            <ReplyHead avatar={me} name={name} meta={age(part.at)} />
            <MessageText text={part.text} large />
          </View>
        ) : (
          <AstraReply key={part.id} turns={part.turns} last={thread.live && part === lastReply} item={item} onUseAsReply={onUseAsReply} onOpenSession={onOpenSession} onStop={onStop} />
        ),
      )}
      <ThreadReplyField
        onSend={(text) => {
          onReply(root?.text ?? "", text);
        }}
      />
    </FeedCard>
  );
}

const styles = StyleSheet.create({
  private: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: "auto", flexShrink: 0 },
  replyHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  replyName: { fontWeight: "700", flexShrink: 1 },
  replyMeta: { flexShrink: 1 },
  reply: { marginLeft: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, gap: spacing.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm, paddingTop: spacing.xs },
  field: { flexDirection: "row", alignItems: "flex-end", gap: spacing.xs, borderRadius: 20, paddingLeft: spacing.md, paddingRight: 5, paddingVertical: 5, marginTop: spacing.xs },
  input: { flex: 1, fontSize: 16, maxHeight: FIELD_MAX_HEIGHT, paddingTop: 6, paddingBottom: 6 },
});
