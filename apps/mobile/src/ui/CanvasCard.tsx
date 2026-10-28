/**
 * A live canvas row in a chat (`CanvasEntry`): the `start` Join card, a compact `turn` row (what
 * Isaac noted at the canvas and the agent's answer) and the `end` wrap-up. Layout only: the
 * caller says whether the room is live, where the agent's avatar is and what Join does.
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { CanvasEntry } from "@relay/protocol";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Pill } from "./Pill";
import { Text } from "./Text";
import { radii, spacing, useColors } from "@/theme";

const AVATAR = 36;
/** Join is a full touch target, not the default 36pt button. */
const JOIN_HEIGHT = 44;

export type CanvasCardState = "live" | "ended" | "unknown";

export interface CanvasCardProps {
  entry: CanvasEntry;
  /** The entry's room: live (Join opens it), ended, or unknown before the host has listed rooms. */
  state: CanvasCardState;
  /** The agent's avatar on the connected host; initials in its color stand in without one. */
  avatarUri: string | null;
  /** Join can be sent now (connected). */
  canJoin: boolean;
  onJoin: () => void;
  /** `end`: the summary, drawn by the caller (markdown); plain text without it. */
  summary?: ReactNode;
}

export function CanvasCard({ entry, state, avatarUri, canJoin, onJoin, summary }: CanvasCardProps) {
  switch (entry.kind) {
    case "start":
      return <JoinCard entry={entry} state={state} avatarUri={avatarUri} canJoin={canJoin} onJoin={onJoin} />;
    case "turn":
      return <TurnRow entry={entry} />;
    case "end":
      return <WrapUpCard entry={entry} summary={summary} />;
  }
}

function JoinCard({ entry, state, avatarUri, canJoin, onJoin }: Omit<CanvasCardProps, "summary">) {
  const colors = useColors();
  const ended = state === "ended";
  const title = ended ? `${entry.agent.name} on ${entry.board}` : `Join ${entry.agent.name} on ${entry.board}`;
  const purpose = entry.text?.trim() ?? "";
  return (
    <View
      testID="canvas-join-card"
      style={[styles.card, { borderColor: colors.hairline, backgroundColor: colors.surface }]}
    >
      <View style={styles.head}>
        <Avatar name={entry.agent.name} uri={avatarUri} size={AVATAR} tint={entry.agent.color} />
        <View style={styles.headText}>
          <Text variant="title" numberOfLines={2}>
            {title}
          </Text>
          {purpose !== "" && (
            <Text variant="body" color="textMuted" numberOfLines={3}>
              {purpose}
            </Text>
          )}
        </View>
      </View>
      {ended ? (
        <View style={styles.footer}>
          <Pill label="Ended" />
          <Text variant="caption" color="textMuted" style={styles.footerNote}>
            This session has ended.
          </Text>
        </View>
      ) : (
        <View style={styles.footer}>
          {state === "live" && <Pill label="Live" tone="ok" />}
          <View style={styles.joinButton}>
            <Button
              label="Join"
              height={JOIN_HEIGHT}
              disabled={!canJoin}
              onPress={onJoin}
              accessibilityLabel={`Join ${entry.agent.name} on ${entry.board}`}
              testID="canvas-join"
            />
          </View>
        </View>
      )}
    </View>
  );
}

function TurnRow({ entry }: { entry: CanvasEntry }) {
  const colors = useColors();
  const reply = entry.text?.trim() ?? "";
  return (
    <View style={styles.turn} accessibilityLabel={`On the canvas: ${entry.human === undefined ? "" : `${entry.human.name}: ${entry.human.text}. `}${entry.agent.name}: ${reply}`}>
      <SymbolView name="rectangle.3.group" size={14} tintColor={colors.textFaint} style={styles.turnGlyph} />
      <View style={styles.turnLines}>
        {entry.human !== undefined && (
          <Text variant="body" color="textMuted" numberOfLines={4}>
            <Text variant="label" color="text">{`${entry.human.name}: `}</Text>
            {entry.human.text}
          </Text>
        )}
        {reply !== "" && (
          <Text variant="body" color="textMuted" numberOfLines={4}>
            <Text variant="label" style={{ color: entry.agent.color }}>{`${entry.agent.name}: `}</Text>
            {reply}
          </Text>
        )}
      </View>
    </View>
  );
}

function WrapUpCard({ entry, summary }: { entry: CanvasEntry; summary: ReactNode }) {
  const colors = useColors();
  const text = entry.text?.trim() ?? "";
  return (
    <View testID="canvas-wrap-up" style={[styles.card, { borderColor: colors.hairline, backgroundColor: colors.surface }]}>
      <View>
        <Text variant="title">Canvas wrap-up</Text>
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {`${entry.agent.name} on ${entry.board}`}
        </Text>
      </View>
      {summary ?? (text !== "" && <Text variant="body">{text}</Text>)}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "stretch",
    maxWidth: 420,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  headText: { flex: 1, gap: 2 },
  footer: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  footerNote: { flex: 1 },
  joinButton: { marginLeft: "auto", minWidth: 120 },
  turn: { flexDirection: "row", gap: spacing.sm },
  turnGlyph: { marginTop: 3 },
  turnLines: { flex: 1, gap: 2 },
});
