/**
 * The bottom-of-transcript sign of life while a session is working and nothing is streaming:
 * the thinking mark and what the agent is on ("Running bash", "Thinking"). Without it the phone
 * shows nothing between the user's message and the first tool row.
 */
import { View } from "react-native";
import { spacing } from "@/theme";
import { Text } from "@/ui/Text";
import { ThinkingMark } from "./ThinkingMark";

export interface ActivityRowProps {
  /** What the agent is on: "Thinking", "Running bash", "Starting omp". */
  label: string;
}

export function ActivityRow({ label }: ActivityRowProps) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.xs }}>
      <ThinkingMark />
      <Text variant="caption" color="textMuted" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
