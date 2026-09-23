/**
 * Home: a 2x2 grid of widgets, one per thing the phone can do with the host, each carrying its
 * live fact (session count, drop count, host state) so the screen answers "what is going on"
 * before anything is tapped. Trackpad and Drops share the top row, Agent Inbox and the host
 * (which opens Settings) the bottom.
 */
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Screen } from "@/ui/Screen";
import { Pill } from "@/ui/Pill";
import { Banner } from "@/ui/Banner";
import { Tile } from "@/home/Tile";
import { spacing } from "@/theme";
import { useConnectionStore, type ConnectionStatus } from "@/state/connection";
import { needsAttention, useAgentsStore } from "@/state/agents";
import { useDropsStore } from "@/state/drops";
import { actions } from "@/state/actions";
import { countOf } from "@/lib/format";

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
        <View style={styles.row}>
          <Tile
            symbol="tray"
            title="Agent Inbox"
            {...(agentsAvailable ? { value: order.length } : {})}
            tone={needingCount > 0 ? "warn" : agentsAvailable ? "accent" : "textMuted"}
            caption={inboxCaption(agentsAvailable, order.length, needingCount)}
            onPress={() => {
              router.push("/agents");
            }}
          />
          <Tile
            symbol="desktopcomputer"
            title={macName ?? "Host"}
            tone={mac === null ? "textMuted" : mac.accessibilityGranted ? "accent" : "warn"}
            caption={mac === null ? "Waiting for a host" : mac.accessibilityGranted ? `v${mac.version}, input ready` : `v${mac.version}, input unavailable`}
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
});
