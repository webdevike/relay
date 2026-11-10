import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { STATE_META, statusText, type MotionState } from "@relay/portrait-motion";
import type { AssistantPortrait } from "@relay/protocol";
import { useColors } from "@/theme";
import { AnimatedPortrait } from "./AnimatedPortrait";
import type { PortraitMotion } from "./AvatarRing";
import { Text } from "./Text";

/** The portrait's diameter in a compact header row. */
export const AVATAR_TITLE_SIZE = 34;
const STATUS_FADE_MS = 180;

export interface AvatarTitleProps {
  name: string;
  portrait: AssistantPortrait;
  /** Animate the portrait from these signals; the status words under the name follow its face. */
  motion: PortraitMotion;
}

/**
 * An assistant's identity for a one-row header: a small animated portrait, the name, and under it
 * the face's status words (`statusText`: "is thinking", "needs you", ...) only while there are
 * some. The compact sibling of `AvatarRing`, which stacks a large ring over a name pill.
 */
export function AvatarTitle({ name, portrait, motion }: AvatarTitleProps) {
  const colors = useColors();
  const [state, setState] = useState<MotionState | null>(null);
  const words = motion.signals.waiting ? "needs you" : motion.signals.failed ? "the last turn failed" : null;
  const label = state === null ? name : [name, STATE_META[state].status, words].filter((part) => part !== null).join(", ");
  const text = state === null ? null : statusText(state, motion.signals);
  const status = text === (motion.except ?? null) ? null : text;
  return (
    <View accessible accessibilityLabel={label} style={styles.root}>
      <AnimatedPortrait name={name} portrait={portrait} size={AVATAR_TITLE_SIZE} signals={motion.signals} paused={motion.paused ?? false} onState={setState} />
      <View style={styles.text}>
        <Text variant="title" numberOfLines={1}>
          {name}
        </Text>
        {status !== null && (
          <Animated.Text
            key={status}
            numberOfLines={1}
            entering={FadeIn.duration(STATUS_FADE_MS).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(STATUS_FADE_MS).reduceMotion(ReduceMotion.System)}
            style={[styles.status, { color: colors.textMuted }]}
          >
            {status}
          </Animated.Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
  text: { flexShrink: 1, minWidth: 0 },
  status: { fontSize: 12, lineHeight: 15, fontWeight: "500" },
});
