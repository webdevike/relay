import { View } from "react-native";
import { Text } from "./Text";
import { ProgressBar } from "./ProgressBar";
import { mediaClock } from "@/lib/format";
import { spacing, type ToneToken } from "@/theme";

export interface TimerReadoutProps {
  /** Seconds left; shown as m:ss. */
  seconds: number;
  /** Share of the timer already run, 0..1. */
  fraction: number;
  tone?: ToneToken;
}

/** A countdown: large tabular m:ss over a thin progress track. */
export function TimerReadout({ seconds, fraction, tone = "accent" }: TimerReadoutProps) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="largeTitle" tabular style={{ textAlign: "center" }} accessibilityLabel={`${Math.ceil(seconds / 60)} minutes left`}>
        {mediaClock(seconds)}
      </Text>
      <ProgressBar fraction={fraction} tone={tone} />
    </View>
  );
}
