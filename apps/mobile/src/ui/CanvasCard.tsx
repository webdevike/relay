/**
 * A live canvas row in a chat (`CanvasEntry`): the `start` Join card and the `end` wrap-up are
 * one-row status cards (`StatusCardRow`, so they swipe away like the others); a `turn` is a compact
 * row (what Isaac noted at the canvas and the agent's answer). Layout only: the caller says whether
 * the room is live, where the agent's avatar is and what Join does.
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { CanvasEntry } from "@relay/protocol";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { StatusCardRow } from "./StatusCardRow";
import { Text } from "./Text";
import { spacing, useColors } from "@/theme";

const AVATAR = 22;

export type CanvasCardState = "live" | "ended" | "unknown";

export interface CanvasCardProps {
  entry: CanvasEntry;
  /** The chat message the entry came in: the card's name for dismissal is `canvas:<messageId>`, as on desktop. */
  messageId: string;
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

export function CanvasCard({ entry, messageId, state, avatarUri, canJoin, onJoin, summary }: CanvasCardProps) {
  switch (entry.kind) {
    case "start":
      return <JoinCard entry={entry} messageId={messageId} state={state} avatarUri={avatarUri} canJoin={canJoin} onJoin={onJoin} />;
    case "turn":
      return <TurnRow entry={entry} />;
    case "end":
      return <WrapUpCard entry={entry} messageId={messageId} summary={summary} />;
  }
}

function JoinCard({ entry, messageId, state, avatarUri, canJoin, onJoin }: Omit<CanvasCardProps, "summary">) {
  const ended = state === "ended";
  const board = entry.board || entry.slug;
  const line = ended ? `${entry.agent.name} on ${board}` : `Join ${entry.agent.name} on ${board}`;
  const purpose = entry.text?.trim() ?? "";
  return (
    <StatusCardRow
      id={`canvas:${messageId}`}
      running={state === "live"}
      line={line}
      lineLines={1}
      lead={<Avatar name={entry.agent.name} uri={avatarUri} size={AVATAR} tint={entry.agent.color} />}
      actions={
        ended ? undefined : (
          <Button label="Join" disabled={!canJoin} onPress={onJoin} accessibilityLabel={`Join ${entry.agent.name} on ${board}`} testID="canvas-join" />
        )
      }
      meta={
        ended ? (
          <Text variant="caption" color="textMuted">
            Ended
          </Text>
        ) : undefined
      }
      details={
        purpose === "" ? undefined : (
          <Text variant="body" color="textMuted">
            {purpose}
          </Text>
        )
      }
      style={styles.card}
      testID="canvas-join-card"
    />
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

function WrapUpCard({ entry, messageId, summary }: { entry: CanvasEntry; messageId: string; summary: ReactNode }) {
  const colors = useColors();
  const text = entry.text?.trim() ?? "";
  const details = summary ?? (text === "" ? undefined : <Text variant="body">{text}</Text>);
  return (
    <StatusCardRow
      id={`canvas:${messageId}`}
      running={false}
      line={`Canvas wrap-up · ${entry.board || entry.slug}`}
      accessibilityLabel={`Canvas wrap-up, ${entry.agent.name} on ${entry.board || entry.slug}`}
      lead={<SymbolView name="rectangle.3.group" size={16} tintColor={colors.textMuted} />}
      details={details}
      style={styles.card}
      testID="canvas-wrap-up"
    />
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: "stretch", maxWidth: 420 },
  turn: { flexDirection: "row", gap: spacing.sm },
  turnGlyph: { marginTop: 3 },
  turnLines: { flex: 1, gap: 2 },
});
