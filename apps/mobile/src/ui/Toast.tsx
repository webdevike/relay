import { View } from "react-native";
import { Text } from "@/ui/Text";
import { radii, spacing } from "@/theme";

export interface ToastProps {
  message: string;
}

/** A short dark message over the page; the parent positions it and decides when it goes. */
export function Toast({ message }: ToastProps) {
  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={{
        alignSelf: "center",
        backgroundColor: "rgba(40,40,40,0.95)",
        borderRadius: radii.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
      }}
    >
      <Text variant="label" style={{ color: "#FFFFFF" }}>
        {message}
      </Text>
    </View>
  );
}
