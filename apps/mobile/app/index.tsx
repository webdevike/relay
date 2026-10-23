/**
 * Home: a grid of widgets, one per thing the phone can do with the host, each carrying its
 * live fact (session count, drop count, host state) so the screen answers "what is going on"
 * before anything is tapped. Assistants leads with the newest reply of any agent (the list and
 * each thread live under it); Trackpad and Drops share the next row, Agent Inbox and the host
 * (which opens Settings) the one after. While the host's habit gate is locked its card leads.
 * The Work | Personal switch on top scopes the app to one omp account (`lib/profile.ts`): the
 * inbox count here and the inbox itself show that account's sessions, and new sessions run on it.
 */
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Screen } from "@/ui/Screen";
import { Pill } from "@/ui/Pill";
import { Banner } from "@/ui/Banner";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { useSettingsStore } from "@/state/settings";
import { PROFILE_TABS, scopeOrder } from "@/lib/profile";
import { tapHaptic } from "@/lib/haptics";
import { Tile } from "@/home/Tile";
import { useBoardsStore } from "@/state/boards";
import { spacing } from "@/theme";
import { useConnectionStore, type ConnectionStatus } from "@/state/connection";
import { needsAttention, useAgentsStore } from "@/state/agents";
import { useDropsStore } from "@/state/drops";
import { useGateStore } from "@/state/gate";
import { assistantsCaption, useAssistantStore } from "@/state/assistant";
import { HabitGate } from "@/gate/HabitGate";
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
  const boards = useBoardsStore((state) => state.boards);
  const router = useRouter();
  const status = useConnectionStore((state) => state.status);
  const mac = useConnectionStore((state) => state.mac);
  const macName = useConnectionStore((state) => state.macName);
  const pairing = useConnectionStore((state) => state.pairing);
  const agentsAvailable = mac?.agentsAvailable === true;
  const sessions = useAgentsStore((state) => state.sessions);
  const profile = useSettingsStore((state) => state.ompProfile);
  const setSettings = useSettingsStore((state) => state.set);
  const allOrder = useAgentsStore((state) => state.order);
  const order = scopeOrder(allOrder, sessions, profile);
  const needingCount = order.filter((id) => {
    const session = sessions[id];
    return session !== undefined && needsAttention(session);
  }).length;
  const drops = useDropsStore((state) => state.drops);
  const latestDrop = drops[0];
  const pill = pillFor[status];
  const gateLocked = useGateStore((state) => state.gate?.locked === true);
  // The host's registry, asked on every welcome and kept live by the host; none until the first answer.
  const assistantsLine = useAssistantStore((state) => assistantsCaption(state.agents));

  return (
    <Screen title={macName ?? "Relay"} headerRight={<Pill label={pill.label} tone={pill.tone} />} scroll={gateLocked}>
      <View style={styles.profile}>
        <SegmentedTabs
          tabs={PROFILE_TABS}
          value={profile}
          size="large"
          onChange={(next) => {
            if (next === profile) return;
            tapHaptic();
            setSettings({ ompProfile: next });
          }}
        />
      </View>
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
      {gateLocked && (
        <View style={styles.gate}>
          <HabitGate />
        </View>
      )}
      <View style={styles.grid}>
        <Tile
          symbol="bubble.left.and.text.bubble.right"
          title="Assistants"
          caption={assistantsLine}
          size="wide"
          onPress={() => {
            router.push("/assistants");
          }}
        />
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
        <Tile
          symbol="display"
          title="Live view"
          caption="See and control your Mac"
          size="wide"
          onPress={() => {
            router.push("/screen");
          }}
        />
        <Tile
          symbol="chart.xyaxis.line"
          title="Boards"
          caption={boards.length === 0 ? "Live dashboards from the host" : boards.map((b) => b.title).join(", ")}
          size="wide"
          onPress={() => {
            router.push("/boards");
          }}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg },
  banner: { paddingBottom: spacing.lg },
  gate: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg },
  grid: { paddingHorizontal: spacing.xl, gap: spacing.md },
  row: { flexDirection: "row", gap: spacing.md },
});
