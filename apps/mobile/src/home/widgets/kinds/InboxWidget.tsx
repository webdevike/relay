/**
 * Inbox widget. Small: how many agent sessions there are, with how many need the user under it
 * (red when any do). Medium: that count beside the top three sessions in inbox order (needing the
 * user first, then most recent), each with its status; a row opens that session.
 * Elsewhere a tap opens /agents.
 */
import { StyleSheet, View } from "react-native";
import type { AgentSession } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { StatusDot } from "@/ui/StatusDot";
import { countOf } from "@/lib/format";
import { needsAttention, useAgentsStore } from "@/state/agents";
import { useConnectionStore } from "@/state/connection";
import { spacing, useColors } from "@/theme";
import { WidgetFigure, WidgetHeader, WidgetLink, WidgetNote, WidgetSpacer, WidgetSurface, type WidgetBodyProps } from "../WidgetParts";

const ROWS = 3;

/** What the user would see first about a session: why it waits, else its last activity. */
function sessionLine(session: AgentSession): string {
  if (needsAttention(session) && session.statusDetail !== undefined && session.statusDetail !== "") return session.statusDetail;
  return session.lastActivity;
}

function SessionRow({ session, open, first }: { session: AgentSession; open: WidgetBodyProps["open"]; first: boolean }) {
  const colors = useColors();
  return (
    <WidgetLink
      href={{ pathname: "/agents", params: { sessionId: session.id } }}
      open={open}
      style={[styles.row, !first && { borderTopColor: colors.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}
    >
      <View style={styles.rowHead}>
        <StatusDot status={session.status} size={7} />
        <Text variant="label" numberOfLines={1} style={styles.title}>
          {session.title}
        </Text>
      </View>
      <Text variant="caption" color="textMuted" numberOfLines={1}>
        {sessionLine(session)}
      </Text>
    </WidgetLink>
  );
}

export function InboxWidget({ size, open, a11y }: WidgetBodyProps) {
  const sessions = useAgentsStore((state) => state.sessions);
  const order = useAgentsStore((state) => state.order);
  const mac = useConnectionStore((state) => state.mac);
  const listed = order.flatMap((id) => {
    const session = sessions[id];
    return session === undefined ? [] : [session];
  });
  const needing = listed.filter(needsAttention).length;
  const note = mac === null ? "Not connected" : !mac.agentsAvailable ? "Host has no agent bridge" : null;
  const needLine = needing === 1 ? "needs you" : "need you";
  const label =
    note !== null
      ? `Inbox. ${note}`
      : `Inbox. ${needing} ${needLine}, ${countOf(listed.length, "session")}.${
          size === "medium" ? ` ${listed.slice(0, ROWS).map((s) => `${s.title}: ${sessionLine(s)}`).join(". ")}` : ""
        }`;

  const count =
    note !== null ? (
      <WidgetNote text={note} />
    ) : (
      <View>
        <WidgetFigure value={String(listed.length)} />
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {listed.length === 1 ? "agent" : "agents"}
        </Text>
        <Text variant="caption" color={needing > 0 ? "danger" : "textFaint"} numberOfLines={1}>
          {needing} {needLine}
        </Text>
      </View>
    );

  return (
    <WidgetSurface label={label} href="/agents" open={open} a11y={a11y}>
      {size === "small" ? (
        <>
          <WidgetHeader symbol="tray.fill" title="Inbox" color="orange" />
          <WidgetSpacer />
          {count}
        </>
      ) : (
        <View style={styles.columns}>
          <View style={styles.summary}>
            <WidgetHeader symbol="tray.fill" title="Inbox" color="orange" />
            <WidgetSpacer />
            {count}
          </View>
          {note === null && (
            <View style={styles.rows}>
              {listed.length === 0 ? (
                <WidgetNote text="No sessions" />
              ) : (
                listed.slice(0, ROWS).map((session, i) => <SessionRow key={session.id} session={session} open={open} first={i === 0} />)
              )}
            </View>
          )}
        </View>
      )}
    </WidgetSurface>
  );
}

const styles = StyleSheet.create({
  columns: { flex: 1, flexDirection: "row", gap: spacing.lg },
  summary: { width: "34%" },
  rows: { flex: 1, justifyContent: "center" },
  row: { flex: 1, maxHeight: 48, justifyContent: "center", gap: 1 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { flex: 1, fontWeight: "600" },
});
