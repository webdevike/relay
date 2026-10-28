/**
 * The live (GPT-Live) call, full screen over whatever is open: mounted at the root, so a call the
 * Action Button started shows as soon as Relay opens. The assistant's portrait, where the call
 * stands, how long it has run, Isaac's latest words and the assistant's, Mute and End. A call
 * that ended on an error stays to say why until Close; one that ended cleanly or handed over to
 * the legacy call (whose own screen takes over on the thread) closes at once.
 */
import { Modal, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarRing } from "@/ui/AvatarRing";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { mediaClock } from "@/lib/format";
import { useSecondClock } from "@/lib/useSecondClock";
import { spacing, useColors, useScheme } from "@/theme";
import { agentPortrait, agentTitle, useAssistantStore } from "@/state/assistant";
import { useLiveCallStore } from "@/state/liveCall";
import { useMotionSignals } from "@/state/motion";
import type { LiveCallPhase, LiveCallSnapshot } from "../../modules/live-call";
import { endLiveCall, setLiveCallMuted } from "./live";

const LABEL: Record<LiveCallPhase, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};
const RING = 132;
/** Dark mode is pure black, like the call screen. */
const BG_DARK = "#000000";

export function LiveCallScreen() {
  const call = useLiveCallStore((store) => store.call);
  if (call === null) return null;
  return <LiveCall call={call} />;
}

function LiveCall({ call }: { call: LiveCallSnapshot }) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const insets = useSafeAreaInsets();
  const title = useAssistantStore((state) => agentTitle(state.agents, call.agent));
  const portrait = useAssistantStore((state) => agentPortrait(state.agents, call.agent));
  const signals = useMotionSignals(call.agent, false);
  const ended = call.state === "ended";
  const now = useSecondClock(!ended);
  const dismiss = useLiveCallStore((store) => store.dismiss);

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={ended ? dismiss : endLiveCall}>
      <View style={[styles.root, { backgroundColor: dark ? BG_DARK : colors.bg, paddingTop: insets.top + spacing.xxxl, paddingBottom: insets.bottom + spacing.xxl }]}>
        <View style={styles.top}>
          <View style={styles.ring}>
            <AvatarRing name={title} portrait={portrait} size={RING} motion={{ signals, except: call.state === "thinking" ? "is thinking" : null }} />
          </View>
          <Text variant="title" style={styles.center}>{call.state === "thinking" ? `${title} is thinking…` : LABEL[call.state]}</Text>
          <Text variant="label" color="textMuted" tabular style={styles.center}>
            {mediaClock((now - call.startedAt) / 1000)}
            {call.muted ? " · muted" : ""}
          </Text>
          <View style={styles.lines}>
            {call.you !== undefined && call.you.trim() !== "" && (
              <Text variant="body" color="textMuted" numberOfLines={3} style={styles.center}>
                {`You: ${call.you.trim()}`}
              </Text>
            )}
            {call.assistant !== undefined && call.assistant.trim() !== "" && (
              <Text variant="body" numberOfLines={4} style={styles.center}>
                {`${title}: ${call.assistant.trim()}`}
              </Text>
            )}
          </View>
        </View>
        {ended ? (
          <View style={styles.endedRow}>
            {call.error !== undefined && <Banner tone="danger" message={call.error} />}
            <Button label="Close" variant="secondary" onPress={dismiss} />
          </View>
        ) : (
          <View style={styles.controls}>
            <IconButton
              symbol={call.muted ? "mic.slash.fill" : "mic.fill"}
              size={72}
              glyphSize={28}
              {...(call.muted ? { backgroundColor: colors.text, tintColor: colors.bg } : {})}
              onPress={() => {
                setLiveCallMuted(!call.muted);
              }}
              accessibilityLabel={call.muted ? "Unmute" : "Mute"}
            />
            <IconButton
              symbol="phone.down.fill"
              size={72}
              glyphSize={30}
              backgroundColor={colors.danger}
              tintColor="#FFFFFF"
              onPress={endLiveCall}
              accessibilityLabel="End call"
            />
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "space-between", paddingHorizontal: spacing.xxl },
  top: { alignItems: "center", gap: spacing.sm },
  ring: { alignItems: "center", justifyContent: "flex-start", marginBottom: spacing.lg },
  center: { textAlign: "center" },
  lines: { marginTop: spacing.md, paddingHorizontal: spacing.lg, gap: spacing.sm },
  controls: { flexDirection: "row", justifyContent: "space-evenly", alignItems: "center" },
  endedRow: { gap: spacing.md },
});
