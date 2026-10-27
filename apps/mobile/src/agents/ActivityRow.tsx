/** The same quiet live activity indicator used by every phone transcript. */
import { View } from "react-native";
import { spacing } from "@/theme";
import { TypingBubble } from "@/ui/TypingBubble";

export interface ActivityRowProps {
  /** What the agent is on: "Thinking", "Running bash", "Starting omp". */
  label: string;
}

/**
 * Carries the space above it, so a `GrowIn` around it opens and closes that space with the row.
 * No layout animations of its own: an exiting copy fading where the row used to be drew over the
 * reply that had just moved into its place.
 */
export function ActivityRow({ label }: ActivityRowProps) {
  return (
    <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.sm }}>
      <TypingBubble label={label} />
    </View>
  );
}
