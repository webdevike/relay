import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle } from "react-native-reanimated";
import type { AgentSkill } from "@relay/protocol";
import { Text } from "@/ui/Text";
import { colors, motion, radii, spacing } from "@/theme";
import { wheelSnap } from "./signals";
import { useDictation } from "./useDictation";

/** How far the finger turns around the mic per skill; the scrubbing feel, independent of the strip. */
export const WHEEL_STEP_RAD = (40 * Math.PI) / 180;
/** Horizontal distance (pt) between neighboring skill labels on the strip. */
const ITEM_SPACING = 132;
/** Labels beyond this many items from the center are fully faded. */
const VISIBLE_ITEMS = 2.2;
const LABEL_WIDTH = ITEM_SPACING - spacing.sm;
export const STRIP_HEIGHT = 48;

export interface SkillWheelProps {
  skills: AgentSkill[];
}

/**
 * Skill picker shown while the chart is in `choosing`. The finger scrubs in a circle around the
 * mic; the skills present as a strip that pans sideways with it, the centered one snapped. Panning
 * is driven by `wheelSnap` from the mic gesture (springing slot to slot), so the labels move on the UI thread. The
 * parent decides where the strip sits; it fills the width it is given.
 */
export function SkillWheel({ skills }: SkillWheelProps) {
  const { phase } = useDictation();
  if (phase !== "choosing") return null;
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(motion.duration.base)}
      exiting={FadeOut.duration(motion.duration.fast)}
      style={styles.strip}
    >
      {skills.map((skill, index) => (
        <StripLabel key={skill.name} index={index} name={skill.name} />
      ))}
      <View style={styles.marker} />
    </Animated.View>
  );
}

function StripLabel({ index, name }: { index: number; name: string }) {
  const style = useAnimatedStyle(() => {
    const offset = index - wheelSnap.value;
    const distance = Math.min(1, Math.abs(offset) / VISIBLE_ITEMS);
    return {
      opacity: 1 - distance * 0.85,
      transform: [{ translateX: offset * ITEM_SPACING }, { scale: 1 - 0.15 * distance }],
    };
  });
  return (
    <Animated.View style={[styles.label, style]}>
      <Text variant="label" numberOfLines={1} style={styles.labelText}>
        {name}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  strip: {
    height: STRIP_HEIGHT,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  marker: {
    position: "absolute",
    bottom: 0,
    width: spacing.xl,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.accent,
  },
  label: {
    position: "absolute",
    width: LABEL_WIDTH,
    alignItems: "center",
  },
  labelText: { textAlign: "center" },
});
