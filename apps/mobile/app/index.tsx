/**
 * Home: iPhone-style widgets (`home/widgets`: usage, assistants, inbox, boards, and apps, the iOS
 * Settings-style list of everything the phone can do with the host; long-press to resize, remove
 * or edit, drag in jiggle mode), in pages one screen tall that swipe sideways once they outgrow
 * it. While the host's habit gate is locked its card leads. In jiggle mode the header holds Add
 * Widget and Done in place of the connection pill.
 */
import { useState } from "react";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Screen } from "@/ui/Screen";
import { Pill } from "@/ui/Pill";
import { Banner } from "@/ui/Banner";
import { spacing } from "@/theme";
import { useConnectionStore, type ConnectionStatus } from "@/state/connection";
import { useGateStore } from "@/state/gate";
import { HabitGate } from "@/gate/HabitGate";
import { actions } from "@/state/actions";
import { WidgetEditBar, WidgetGrid } from "@/home/widgets/WidgetGrid";
import { WidgetMenu } from "@/home/widgets/WidgetMenu";
import { useWidgetUi } from "@/home/widgets/ui";

const pillFor: Record<
  ConnectionStatus,
  { label: string; tone: "accent" | "ok" | "warn" | "danger" | "textMuted" }
> = {
  idle: { label: "Not connected", tone: "textMuted" },
  discovering: { label: "Finding host…", tone: "accent" },
  connecting: { label: "Connecting…", tone: "accent" },
  pairing: { label: "Pairing", tone: "warn" },
  authenticating: { label: "Authenticating…", tone: "accent" },
  connected: { label: "Connected", tone: "ok" },
  reconnecting: { label: "Reconnecting…", tone: "warn" },
  offline: { label: "Offline", tone: "danger" },
};

export default function Home() {
  const router = useRouter();
  const status = useConnectionStore((state) => state.status);
  const macName = useConnectionStore((state) => state.macName);
  const pairing = useConnectionStore((state) => state.pairing);
  const pill = pillFor[status];
  const gateLocked = useGateStore((state) => state.gate?.locked === true);
  // A held widget owns the finger; the page must not scroll under it.
  const holding = useWidgetUi((state) => state.holding);
  const editing = useWidgetUi((state) => state.editing);
  const [bodyHeight, setBodyHeight] = useState(0);

  return (
    <View style={styles.root}>
      <Screen
        title={macName ?? "Relay"}
        headerRight={editing ? <WidgetEditBar /> : <Pill label={pill.label} tone={pill.tone} />}
        scroll
        scrollEnabled={!holding}
        onBodyHeight={setBodyHeight}
      >
        {status === "offline" && (
          <View style={styles.banner}>
            <Banner tone="danger" message="Can't reach your host on this network." />
          </View>
        )}
        {status === "pairing" && (
          <View style={styles.banner}>
            <Banner
              tone="warn"
              message={
                pairing.pinRequired
                  ? "Enter the PIN shown on your host."
                  : `${macName ?? "Your host"} is nearby but not paired.`
              }
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
        <WidgetGrid viewportHeight={bodyHeight} />
      </Screen>
      <WidgetMenu />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: { paddingBottom: spacing.lg },
  gate: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg },
});
