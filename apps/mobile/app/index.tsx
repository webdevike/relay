import { useRouter } from "expo-router";
import { View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Screen } from "@/ui/Screen";
import { Row } from "@/ui/Row";
import { Separator } from "@/ui/Separator";
import { Pill } from "@/ui/Pill";
import { Banner } from "@/ui/Banner";
import { colors, spacing } from "@/theme";
import { useConnectionStore, type ConnectionStatus } from "@/state/connection";
import { needsAttention, useAgentsStore } from "@/state/agents";
import { useDropsStore } from "@/state/drops";
import { actions } from "@/state/actions";
import { countOf } from "@/lib/format";

const pillFor: Record<ConnectionStatus, { label: string; tone: "accent" | "ok" | "warn" | "danger" | "textMuted" }> = {
  idle: { label: "Not connected", tone: "textMuted" },
  discovering: { label: "Finding Mac…", tone: "accent" },
  connecting: { label: "Connecting…", tone: "accent" },
  pairing: { label: "Pairing", tone: "warn" },
  authenticating: { label: "Authenticating…", tone: "accent" },
  connected: { label: "Connected", tone: "ok" },
  reconnecting: { label: "Reconnecting…", tone: "warn" },
  offline: { label: "Offline", tone: "danger" },
};

function inboxSubtitle(sessions: number, needing: number): string {
  const base = countOf(sessions, "session");
  if (needing === 0) return base;
  return `${base}, ${needing} ${needing === 1 ? "needs" : "need"} you`;
}

export default function Home() {
  const router = useRouter();
  const status = useConnectionStore((state) => state.status);
  const macName = useConnectionStore((state) => state.macName);
  const pairing = useConnectionStore((state) => state.pairing);
  const agentsAvailable = useConnectionStore((state) => state.mac?.agentsAvailable === true);
  const sessionCount = useAgentsStore((state) => state.order.length);
  const needingCount = useAgentsStore((state) => state.order.filter((id) => {
    const session = state.sessions[id];
    return session !== undefined && needsAttention(session);
  }).length);
  const dropCount = useDropsStore((state) => state.drops.length);
  const pill = pillFor[status];

  return (
    <Screen title={macName ?? "Relay"} headerRight={<Pill label={pill.label} tone={pill.tone} />}>
      {status === "offline" && (
        <View style={{ paddingBottom: spacing.lg }}>
          <Banner tone="danger" message="Can't reach your Mac on this network." />
        </View>
      )}
      {status === "pairing" && (
        <View style={{ paddingBottom: spacing.lg }}>
          <Banner
            tone="warn"
            message={
              pairing.pinRequired
                ? "Enter the PIN shown on your Mac."
                : `${macName ?? "Your Mac"} is nearby but not paired.`
            }
            actionLabel={pairing.pinRequired ? "Enter PIN" : "Pair"}
            onAction={() => {
              if (!pairing.pinRequired) actions.startPairing();
              router.push("/pairing");
            }}
          />
        </View>
      )}
      <Separator />
      <Row
        title="Trackpad"
        subtitle="Move, click, and scroll on your Mac"
        leading={<SymbolView name="cursor.rays" size={22} tintColor={colors.accent} />}
        onPress={() => {
          router.push("/trackpad");
        }}
      />
      <Separator />
      {agentsAvailable && (
        <>
          <Row
            title="Agent Inbox"
            subtitle={inboxSubtitle(sessionCount, needingCount)}
            leading={<SymbolView name="tray" size={22} tintColor={needingCount > 0 ? colors.warn : colors.accent} />}
            onPress={() => {
              router.push("/agents");
            }}
          />
          <Separator />
        </>
      )}
      <Row
        title="Drops"
        subtitle={countOf(dropCount, "drop")}
        leading={<SymbolView name="tray.and.arrow.down" size={22} tintColor={colors.accent} />}
        onPress={() => {
          router.push("/drops");
        }}
      />
      <Separator />
      <View style={{ flex: 1 }} />
      <Separator />
      <Row
        title="Settings"
        leading={<SymbolView name="gearshape" size={22} tintColor={colors.textMuted} />}
        onPress={() => {
          router.push("/settings");
        }}
      />
    </Screen>
  );
}
