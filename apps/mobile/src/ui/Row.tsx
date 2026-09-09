import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { colors, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export interface RowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
}

export function Row({ title, subtitle, leading, trailing, onPress, disabled = false }: RowProps) {
  const content = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 44,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        gap: spacing.md,
      }}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="title" numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
        opacity: disabled ? 0.4 : 1,
      })}
    >
      {content}
    </Pressable>
  );
}
