/** The same quiet live activity indicator used by every phone transcript. */
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { spacing } from "@/theme";
import { TypingBubble } from "@/ui/TypingBubble";

export interface ActivityRowProps {
  /** What the agent is on: "Thinking", "Running bash", "Starting omp". */
  label: string;
}

export function ActivityRow({ label }: ActivityRowProps) {
  return (
    <Animated.View entering={FadeIn.duration(180).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)} style={{ paddingHorizontal: spacing.xl }}>
      <TypingBubble label={label} />
    </Animated.View>
  );
}
