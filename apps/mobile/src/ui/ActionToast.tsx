import { Pressable, View } from "react-native";
import { Text } from "@/ui/Text";
import { radii, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { useCoversContent } from "@/ui/covering";

export interface ActionToastProps {
  message: string;
  /** The one thing the toast offers, e.g. "Undo". */
  action: string;
  onAction: () => void;
}

/** `Toast` with a button: a short dark message and one action over the page; the parent positions it and decides when it goes. */
export function ActionToast({ message, action, onAction }: ActionToastProps) {
  useCoversContent(true);
  return (
    <View
      style={{
        alignSelf: "center",
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.lg,
        backgroundColor: "rgba(40,40,40,0.95)",
        borderRadius: radii.lg,
        paddingLeft: spacing.lg,
        paddingRight: spacing.sm,
        paddingVertical: spacing.xs,
      }}
    >
      <Text variant="label" style={{ color: "#FFFFFF" }}>
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action}
        hitSlop={8}
        onPress={() => {
          tapHaptic();
          onAction();
        }}
        style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
      >
        <Text variant="label" style={{ color: "#8AB4FF", fontWeight: "600" }}>
          {action}
        </Text>
      </Pressable>
    </View>
  );
}
