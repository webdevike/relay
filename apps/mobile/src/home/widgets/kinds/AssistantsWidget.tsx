/**
 * Assistants widget. Small: a Smart Stack of the host's assistants, newest reply first, one per
 * page with its portrait; swipe up or down between them, a tap opens the one showing. Medium: the three agents that spoke last, each with its last line and
 * status; a row opens its thread. Elsewhere a tap opens /assistants.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { selectHaptic } from "@/lib/haptics";
import type { AssistantAgent } from "@relay/protocol";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { previewText } from "@/agents/markdown";
import { relativeTime } from "@/lib/format";
import { portraitSeed } from "@/lib/portrait";
import { STATUS_LABEL, useAssistantStore } from "@/state/assistant";
import { useConnectionStore } from "@/state/connection";
import { spacing, useColors } from "@/theme";
import { useWidgetUi } from "../ui";
import {
  useWidgetTint,
  WidgetHeader,
  WidgetLink,
  WidgetNote,
  WidgetSpacer,
  WidgetSurface,
  type WidgetBodyProps,
} from "../WidgetParts";

const SYMBOL = "bubble.left.and.text.bubble.right.fill";
const ROWS = 3;
/** Portrait diameter beside an agent's name, about the header glyph's line height. */
const PORTRAIT = 20;

/** `just now` or `5m ago`. */
function ago(at: number): string {
  const rel = relativeTime(at);
  return rel === "now" ? "just now" : `${rel} ago`;
}

/** The line under an agent's name: its last reply, else what it covers, else its status. */
function agentLine(agent: AssistantAgent): string {
  const reply = agent.lastReply === undefined ? "" : previewText(agent.lastReply.text);
  if (reply !== "") return reply;
  if (agent.scope !== undefined && agent.scope !== "") return agent.scope;
  return agent.status === undefined ? "" : STATUS_LABEL[agent.status];
}

function AgentRow({ agent, open, first }: { agent: AssistantAgent; open: WidgetBodyProps["open"]; first: boolean }) {
  const colors = useColors();
  const dot = agent.status === "needs_you" ? colors.warn : agent.status === "working" ? colors.working : null;
  return (
    <WidgetLink
      href={{ pathname: "/eva", params: { agent: agent.id } }}
      open={open}
      style={[styles.row, !first && { borderTopColor: colors.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}
    >
      <View style={styles.rowHead}>
        <Portrait name={agent.title} seed={portraitSeed(agent)} size={PORTRAIT} />
        {dot !== null && <View style={[styles.dot, { backgroundColor: dot }]} />}
        <Text variant="label" numberOfLines={1} style={styles.name}>
          {agent.title}
        </Text>
        {agent.lastReply !== undefined && (
          <Text variant="caption" color="textFaint">
            {relativeTime(agent.lastReply.at)}
          </Text>
        )}
      </View>
      <Text variant="caption" color="textMuted" numberOfLines={1}>
        {agentLine(agent)}
      </Text>
    </WidgetLink>
  );
}

export function AssistantsWidget({ size, open, a11y }: WidgetBodyProps) {
  const agents = useAssistantStore((state) => state.agents);
  const connected = useConnectionStore((state) => state.status === "connected");
  const empty = agents === null ? (connected ? "Loading assistants…" : "Not connected") : agents.length === 0 ? "No assistants yet" : "No replies yet";

  if (size === "medium") {
    const rows = [...(agents ?? [])].sort((a, b) => (b.lastReply?.at ?? 0) - (a.lastReply?.at ?? 0)).slice(0, ROWS);
    return (
      <WidgetSurface
        label={rows.length === 0 ? `Assistants. ${empty}` : `Assistants. ${rows.map((a) => `${a.title}: ${agentLine(a)}`).join(". ")}`}
        href="/assistants"
        open={open}
        a11y={a11y}
      >
        {rows.length === 0 ? (
          <>
            <WidgetHeader symbol={SYMBOL} title="Assistants" color="blue" />
            <WidgetSpacer />
            <WidgetNote text={empty} />
          </>
        ) : (
          <View style={styles.rows}>
            {rows.map((agent, i) => (
              <AgentRow key={agent.id} agent={agent} open={open} first={i === 0} />
            ))}
          </View>
        )}
      </WidgetSurface>
    );
  }

  const stack = [...(agents ?? [])].sort((a, b) => (b.lastReply?.at ?? 0) - (a.lastReply?.at ?? 0));
  if (stack.length === 0) {
    return (
      <WidgetSurface label={`Assistants. ${empty}`} href="/assistants" open={open} a11y={a11y}>
        <WidgetHeader symbol={SYMBOL} title="Assistants" color="blue" />
        <WidgetSpacer />
        <WidgetNote text={empty} />
      </WidgetSurface>
    );
  }
  return <AssistantStack agents={stack} open={open} a11y={a11y} />;
}

/**
 * The small widget as an iOS Smart Stack: one assistant per page, its portrait the main image;
 * swipe up or down to the next. Vertical, so it never fights Home's sideways page swipe.
 */
function AssistantStack({ agents, open, a11y }: { agents: readonly AssistantAgent[]; open: WidgetBodyProps["open"]; a11y: WidgetBodyProps["a11y"] }) {
  const colors = useColors();
  const tint = useWidgetTint("blue");
  const [height, setHeight] = useState(0);
  const [page, setPage] = useState(0);
  const current = agents[Math.min(page, agents.length - 1)] ?? agents[0];
  if (current === undefined) return null;
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    if (height <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.y / height);
    if (next !== page) { selectHaptic(); setPage(next); }
  };
  return (
    <WidgetSurface
      label={`${current.title}: ${agentLine(current)}. ${String(page + 1)} of ${String(agents.length)} assistants, swipe up or down for the next.`}
      href={{ pathname: "/eva", params: { agent: current.id } }}
      open={open}
      a11y={a11y}
      style={styles.stackSurface}
    >
      <View
        style={styles.fill}
        onLayout={(event) => { setHeight(event.nativeEvent.layout.height); }}
        // The finger belongs to the stack: Home's scroll holds still so an up/down swipe pages assistants.
        onTouchStart={() => { if (agents.length > 1) useWidgetUi.getState().set({ stackTouched: true }); }}
        onTouchEnd={() => { useWidgetUi.getState().set({ stackTouched: false }); }}
        onTouchCancel={() => { useWidgetUi.getState().set({ stackTouched: false }); }}
      >
        {height > 0 && (
          <ScrollView pagingEnabled nestedScrollEnabled bounces={false} showsVerticalScrollIndicator={false} onMomentumScrollEnd={settle} style={styles.fill}>
            {agents.map((agent) => (
              <View key={agent.id} style={[styles.page, { height }]}>
                <Portrait name={agent.title} seed={portraitSeed(agent)} size={Math.round(height * 0.42)} />
                <Text variant="label" numberOfLines={1} style={styles.stackName}>
                  {agent.title}
                </Text>
                <Text variant="caption" color="textMuted" numberOfLines={2}>
                  {agentLine(agent)}
                </Text>
                <WidgetSpacer />
                {agent.lastReply !== undefined && (
                  <Text variant="caption" numberOfLines={1} style={{ color: tint }}>
                    {ago(agent.lastReply.at)}
                  </Text>
                )}
              </View>
            ))}
          </ScrollView>
        )}
        {agents.length > 1 && (
          <View pointerEvents="none" style={styles.dots}>
            {agents.map((agent, index) => (
              <View key={agent.id} style={[styles.stackDot, { backgroundColor: index === page ? colors.text : colors.hairline }]} />
            ))}
          </View>
        )}
      </View>
    </WidgetSurface>
  );
}

const styles = StyleSheet.create({
  reply: { marginTop: spacing.sm, fontWeight: "500" },
  fill: { flex: 1 },
  stackSurface: { paddingRight: spacing.lg },
  page: { paddingRight: spacing.sm },
  stackName: { marginTop: spacing.sm, fontWeight: "600" },
  dots: { position: "absolute", right: -spacing.sm, top: 0, bottom: 0, justifyContent: "center", gap: 4 },
  stackDot: { width: 5, height: 5, borderRadius: 2.5 },
  rows: { flex: 1, justifyContent: "space-between" },
  row: { flex: 1, justifyContent: "center", gap: 1 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  name: { flex: 1, fontWeight: "600" },
});
