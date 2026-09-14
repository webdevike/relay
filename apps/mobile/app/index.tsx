/**
 * Home: a grid of widgets, one per thing the phone can do with the host, each carrying its live
 * fact (session count, drop count, host state) so the screen answers "what is going on" before
 * anything is tapped. Trackpad and Drops share a row, the inbox takes a full row with the top
 * sessions inline, host and settings close the grid.
 *
 * Hallmark: redesign, component-scope grid. Pre-emit critique: P4 H5 E4 S4 R5 V4.
 */
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Screen } from "@/ui/Screen";
import { Pill } from "@/ui/Pill";
import { Banner } from "@/ui/Banner";
import { Text } from "@/ui/Text";
import { StatusDot } from "@/ui/StatusDot";
import { Tile } from "@/home/Tile";
import { spacing } from "@/theme";
import { useConnectionStore, type ConnectionStatus } from "@/state/connection";
import { needsAttention, useAgentsStore } from "@/state/agents";
import { useDropsStore } from "@/state/drops";
import { actions } from "@/state/actions";
import { countOf } from "@/lib/format";

/** Sessions shown inline on the inbox widget; the rest is a count. */
const INBOX_PREVIEW = 3;

const pillFor: Record<ConnectionStatus, { label: string; tone: "accent" | "ok" | "warn" | "danger" | "textMuted" }> = {
  idle: { label: "Not connected", tone: "textMuted" },
  discovering: { label: "Finding host…", tone: "accent" },
  connecting: { label: "Connecting…", tone: "accent" },
  pairing: { label: "Pairing", tone: "warn" },
  authenticating: { label: "Authenticating…", tone: "accent" },
  connected: { label: "Connected", tone: "ok" },
  reconnecting: { label: "Reconnecting…", tone: "warn" },
  offline: { label: "Offline", tone: "danger" },
};

function inboxCaption(available: boolean, sessions: number, needing: number): string {
  if (!available) return "Host has no agent bridge";
  if (sessions === 0) return "No sessions";
  const base = countOf(sessions, "session");
  if (needing === 0) return base;
  return `${base}, ${needing} ${needing === 1 ? "needs" : "need"} you`;
}

export default function Home() {
  const router = useRouter();
  const status = useConnectionStore((state) => state.status);
  const mac = useConnectionStore((state) => state.mac);
  const macName = useConnectionStore((state) => state.macName);
  const pairing = useConnectionStore((state) => state.pairing);
  const agentsAvailable = mac?.agentsAvailable === true;
  const sessions = useAgentsStore((state) => state.sessions);
  const order = useAgentsStore((state) => state.order);
  const needingCount = order.filter((id) => {
    const session = sessions[id];
    return session !== undefined && needsAttention(session);
  }).length;
  const drops = useDropsStore((state) => state.drops);
  const latestDrop = drops[0];
  const pill = pillFor[status];
  const preview = order.slice(0, INBOX_PREVIEW);

  return (
    <Screen title={macName ?? "Relay"} headerRight={<Pill label={pill.label} tone={pill.tone} />}>
      {status === "offline" && (
        <View style={styles.banner}>
          <Banner tone="danger" message="Can't reach your host on this network." />
        </View>
      )}
      {status === "pairing" && (
        <View style={styles.banner}>
          <Banner
            tone="warn"
            message={pairing.pinRequired ? "Enter the PIN shown on your host." : `${macName ?? "Your host"} is nearby but not paired.`}
            actionLabel={pairing.pinRequired ? "Enter PIN" : "Pair"}
            onAction={() => {
              if (!pairing.pinRequired) actions.startPairing();
              router.push("/pairing");
            }}
          />
        </View>
      )}
      <View style={styles.grid}>
        <View style={styles.row}>
          <Tile
            symbol="cursor.rays"
            title="Trackpad"
            caption="Move, click, scroll"
            onPress={() => {
              router.push("/trackpad");
            }}
          />
          <Tile
            symbol="tray.and.arrow.down"
            title="Drops"
            value={drops.length}
            caption={latestDrop === undefined ? "Nothing shared yet" : latestDrop.title}
            onPress={() => {
              router.push("/drops");
            }}
          />
        </View>
        <Tile
          size="wide"
          symbol="tray"
          title="Agent Inbox"
          tone={needingCount > 0 ? "warn" : agentsAvailable ? "accent" : "textMuted"}
          caption={inboxCaption(agentsAvailable, order.length, needingCount)}
          onPress={() => {
            router.push("/agents");
          }}
        >
          {preview.length > 0 && (
            <View style={styles.sessions}>
              {preview.map((id) => {
                const session = sessions[id];
                if (session === undefined) return null;
                return (
                  <View key={id} style={styles.session}>
                    <StatusDot status={session.status} />
                    <Text variant="label" numberOfLines={1} style={styles.sessionTitle}>
                      {session.title}
                    </Text>
                    <Text variant="caption" color="textFaint" numberOfLines={1} style={styles.sessionActivity}>
                      {session.statusDetail ?? session.lastActivity}
                    </Text>
                  </View>
                );
              })}
              {order.length > INBOX_PREVIEW && (
                <Text variant="caption" color="textFaint">
                  {`${order.length - INBOX_PREVIEW} more`}
                </Text>
              )}
            </View>
          )}
        </Tile>
        <View style={styles.row}>
          <Tile
            symbol="desktopcomputer"
            title={macName ?? "Host"}
            tone={mac === null ? "textMuted" : mac.accessibilityGranted ? "accent" : "warn"}
            caption={mac === null ? "Waiting for a host" : mac.accessibilityGranted ? `v${mac.version}, input ready` : `v${mac.version}, input unavailable`}
            onPress={() => {
              router.push("/settings");
            }}
          />
          <Tile
            symbol="gearshape"
            title="Settings"
            tone="textMuted"
            caption="Speech, host address, haptics"
            onPress={() => {
              router.push("/settings");
            }}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { paddingBottom: spacing.lg },
  grid: { paddingHorizontal: spacing.xl, gap: spacing.md },
  row: { flexDirection: "row", gap: spacing.md },
  sessions: { gap: spacing.sm },
  session: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sessionTitle: { flexShrink: 0, maxWidth: "45%" },
  sessionActivity: { flex: 1 },
});
