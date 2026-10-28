/**
 * Assistants widget. Small: a Smart Stack of the host's assistants, newest reply first, one per
 * page with its portrait; swipe left or right between them (page dots under it), and a swipe past
 * the last or first one turns Home's page instead; a tap opens the one showing. Medium: the three
 * agents that spoke last, each with its last line and status; a row opens its thread. Elsewhere a
 * tap opens /assistants.
 */
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { selectHaptic } from "@/lib/haptics";
import type { AssistantAgent } from "@relay/protocol";
import { NestedPager } from "@/ui/NestedPager";
import { PageDots } from "@/ui/PageControls";
import { BreathingPortrait } from "@/ui/BreathingPortrait";
import { Text } from "@/ui/Text";
import { previewText } from "@/agents/markdown";
import { relativeTime } from "@/lib/format";
import { portraitOf } from "@/lib/portrait";
import { STATUS_LABEL, useAssistantStore } from "@/state/assistant";
import { useConnectionStore } from "@/state/connection";
import { spacing, useColors } from "@/theme";
import {
  useWidgetTint,
  WIDGET_PADDING,
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
        <BreathingPortrait name={agent.title} portrait={portraitOf(agent)} size={PORTRAIT} working={agent.status === "working"} />
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
 * The small widget as an iOS Smart Stack turned sideways: one assistant per page, its portrait the
 * main image, `PageDots` under them. Its `NestedPager` hands a swipe past either end to Home's pages.
 */
function AssistantStack({ agents, open, a11y }: { agents: readonly AssistantAgent[]; open: WidgetBodyProps["open"]; a11y: WidgetBodyProps["a11y"] }) {
  const tint = useWidgetTint("blue");
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [page, setPage] = useState(0);
  const shown = Math.min(page, agents.length - 1);
  const current = agents[shown] ?? agents[0];
  if (current === undefined) return null;
  return (
    <WidgetSurface
      label={`${current.title}: ${agentLine(current)}. ${String(shown + 1)} of ${String(agents.length)} assistants, swipe left or right for the next.`}
      href={{ pathname: "/eva", params: { agent: current.id } }}
      open={open}
      a11y={a11y}
      // The pages span the whole rect, so a swipe anywhere on the widget turns them, edge to edge.
      style={styles.stackSurface}
    >
      <View
        style={styles.fill}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setFrame((was) => (was.width === width && was.height === height ? was : { width, height }));
        }}
      >
        <NestedPager
          width={frame.width}
          page={shown}
          onPageChange={(next) => {
            selectHaptic();
            setPage(next);
          }}
          // Jiggle mode: the widget is for dragging, and a swipe on it turns Home.
          enabled={open !== null}
          style={styles.fill}
        >
          {agents.map((agent) => (
            <View key={agent.id} style={styles.page}>
              <BreathingPortrait name={agent.title} portrait={portraitOf(agent)} size={Math.round(frame.height * 0.36)} working={agent.status === "working"} />
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
        </NestedPager>
        <View pointerEvents="none" style={styles.dots}>
          <PageDots page={shown} count={agents.length} />
        </View>
      </View>
    </WidgetSurface>
  );
}

/** Height of the page-dots strip along the stack's bottom edge. */
const DOTS_ROW = 18;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  stackSurface: { padding: 0 },
  page: { flex: 1, padding: WIDGET_PADDING, paddingBottom: DOTS_ROW },
  stackName: { marginTop: spacing.sm, fontWeight: "600" },
  dots: { position: "absolute", left: 0, right: 0, bottom: 0, height: DOTS_ROW, justifyContent: "center" },
  rows: { flex: 1, justifyContent: "space-between" },
  row: { flex: 1, justifyContent: "center", gap: 1 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  name: { flex: 1, fontWeight: "600" },
});
