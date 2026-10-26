/**
 * Assistants widget. Small: the newest reply across the host's assistants, led by who said it;
 * opens that agent's thread. Medium: the three agents that spoke last, each with its last line and
 * status; a row opens its thread. Elsewhere a tap opens /assistants.
 */
import { StyleSheet, View } from "react-native";
import type { AssistantAgent } from "@relay/protocol";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { previewText } from "@/agents/markdown";
import { relativeTime } from "@/lib/format";
import { portraitSeed } from "@/lib/portrait";
import { latestReply, STATUS_LABEL, useAssistantStore } from "@/state/assistant";
import { useConnectionStore } from "@/state/connection";
import { spacing, useColors } from "@/theme";
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
  const tint = useWidgetTint("blue");
  const latest = latestReply(agents);
  const line = latest === null ? "" : previewText(latest.text);
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

  if (latest === null || line === "") {
    return (
      <WidgetSurface label={`Assistants. ${empty}`} href="/assistants" open={open} a11y={a11y}>
        <WidgetHeader symbol={SYMBOL} title="Assistants" color="blue" />
        <WidgetSpacer />
        <WidgetNote text={empty} />
      </WidgetSurface>
    );
  }
  return (
    <WidgetSurface
      label={`${latest.agent.title} said: ${line}. ${ago(latest.at)}`}
      href={{ pathname: "/eva", params: { agent: latest.agent.id } }}
      open={open}
      a11y={a11y}
    >
      <WidgetHeader
        symbol={SYMBOL}
        title={latest.agent.title}
        color="blue"
        leading={<Portrait name={latest.agent.title} seed={portraitSeed(latest.agent)} size={PORTRAIT} />}
      />
      <Text variant="body" numberOfLines={4} style={styles.reply}>
        {line}
      </Text>
      <WidgetSpacer />
      <Text variant="caption" numberOfLines={1} style={{ color: tint }}>
        {ago(latest.at)}
      </Text>
    </WidgetSurface>
  );
}

const styles = StyleSheet.create({
  reply: { marginTop: spacing.sm, fontWeight: "500" },
  rows: { flex: 1, justifyContent: "space-between" },
  row: { flex: 1, justifyContent: "center", gap: 1 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  name: { flex: 1, fontWeight: "600" },
});
