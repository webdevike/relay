import { View } from "react-native";
import { useColors, type ToneToken } from "@/theme";

const HEIGHT = 6;

export interface ProgressBarProps {
  /** Filled share of the track, 0..1; values outside are clamped. */
  fraction: number;
  tone?: ToneToken;
}

/** A thin rounded track on the raised surface, filled from the left in the tone's color. */
export function ProgressBar({ fraction, tone = "accent" }: ProgressBarProps) {
  const colors = useColors();
  const share = Math.min(Math.max(fraction, 0), 1);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}
      style={{
        height: HEIGHT,
        borderRadius: HEIGHT / 2,
        backgroundColor: colors.surfaceRaised,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${share * 100}%`,
          height: HEIGHT,
          borderRadius: HEIGHT / 2,
          backgroundColor: colors[tone],
        }}
      />
    </View>
  );
}
