import type { ReactNode } from "react";
import { View } from "react-native";
import { spacing, useColors } from "@/theme";

export interface BottomBarProps {
  children: ReactNode;
}

/**
 * The thumb-zone bar under a scrolling page: a hairline on top, the page background, the screen's
 * primary action inside. Put it below the scroll view inside a bottom-edge `SafeAreaView` (the
 * `Screen` primitive is one) so it clears the home indicator.
 */
export function BottomBar({ children }: BottomBarProps) {
  const colors = useColors();
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.hairline,
        backgroundColor: colors.bg,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.xs,
      }}
    >
      {children}
    </View>
  );
}
