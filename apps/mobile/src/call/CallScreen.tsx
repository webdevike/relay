/**
 * The call with an assistant, full screen over its thread (an RN `Modal`, so the thread below
 * stays focused and keeps following, and the words land in it as the call goes). The agent's ring
 * breathes while she thinks or talks and swells with Isaac's voice while she listens; under it,
 * where the call stands, how long it has run, and what was just heard or is being said. Mute and
 * hang up at the bottom. An ended call closes itself, unless it ended on an error worth reading.
 */
import { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { CallState } from "@relay/protocol";
import { AvatarRing } from "@/ui/AvatarRing";
import { Banner } from "@/ui/Banner";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { mediaClock } from "@/lib/format";
import { spacing, useColors, useScheme } from "@/theme";
import { useCallStore } from "@/state/call";
import { endCall, hangUp, setCallMuted } from "./controller";

const LABEL: Record<CallState, string> = {
  // Held until the host says its ears are warm (`call.state` listening); talking before that is lost.
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};
const RING = 132;
/** How long a cleanly ended call stays on screen. */
const CLOSE_AFTER_MS = 900;
/** Dark mode is pure black, like the thread under it. */
const BG_DARK = "#000000";

export function CallScreen({ title }: { title: string }) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const insets = useSafeAreaInsets();
  const call = useCallStore((store) => store.call);
  const now = useSecondClock(call !== null && call.state !== "ended");
  const voice = useSharedValue(1);
  const level = call?.state === "listening" || call?.state === "hearing" ? (call.level) : 0;

  useEffect(() => {
    voice.value = withTiming(1 + level * 0.35, { duration: 90 });
  }, [level, voice]);
  const halo = useAnimatedStyle(() => ({ transform: [{ scale: voice.value }] }));

  const ended = call?.state === "ended";
  const error = call?.error ?? null;
  useEffect(() => {
    if (!ended || error !== null) return;
    const timer = setTimeout(hangUp, CLOSE_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [ended, error]);

  if (call === null) return null;
  const busy = call.state === "thinking" || call.state === "speaking";
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => { endCall(); }}>
      <View style={[styles.root, { backgroundColor: dark ? BG_DARK : colors.bg, paddingTop: insets.top + spacing.xxxl, paddingBottom: insets.bottom + spacing.xxl }]}>
        <View style={styles.top}>
          <View style={styles.ring}>
            <Animated.View style={[styles.halo, { backgroundColor: colors.accent }, halo]} />
            <AvatarRing name={title} size={RING} breathing={busy} />
          </View>
          <Text variant="title" style={styles.center}>{LABEL[call.state]}</Text>
          <Text variant="label" color="textMuted" tabular style={styles.center}>
            {mediaClock((now - call.startedAt) / 1000)}
            {call.muted ? " · muted" : ""}
          </Text>
          {call.text !== null && call.text !== "" && (
            <Text variant="body" color="textMuted" numberOfLines={4} style={[styles.center, styles.said]}>
              {call.text}
            </Text>
          )}
        </View>
        {ended ? (
          <View style={styles.endedRow}>
            {error !== null && <Banner tone="danger" message={error} />}
            <Button label="Close" variant="secondary" onPress={hangUp} />
          </View>
        ) : (
          <View style={styles.controls}>
            <IconButton
              symbol={call.muted ? "mic.slash.fill" : "mic.fill"}
              size={72}
              glyphSize={28}
              {...(call.muted ? { backgroundColor: colors.text, tintColor: colors.bg } : {})}
              onPress={() => {
                setCallMuted(!call.muted);
              }}
              accessibilityLabel={call.muted ? "Unmute" : "Mute"}
            />
            <IconButton
              symbol="phone.down.fill"
              size={72}
              glyphSize={30}
              backgroundColor={colors.danger}
              tintColor="#FFFFFF"
              onPress={() => {
                endCall();
              }}
              accessibilityLabel="Hang up"
            />
          </View>
        )}
      </View>
    </Modal>
  );
}

/** `Date.now()`, refreshed every second while `running`. */
function useSecondClock(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  return now;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "space-between", paddingHorizontal: spacing.xxl },
  top: { alignItems: "center", gap: spacing.sm },
  ring: { alignItems: "center", justifyContent: "flex-start", marginBottom: spacing.lg },
  halo: { position: "absolute", top: 0, width: RING, height: RING, borderRadius: RING / 2, opacity: 0.18 },
  center: { textAlign: "center" },
  said: { marginTop: spacing.md, paddingHorizontal: spacing.lg },
  controls: { flexDirection: "row", justifyContent: "space-evenly", alignItems: "center" },
  endedRow: { gap: spacing.md },
});
