import type { ReactNode } from "react";
import { View } from "react-native";
import { spacing, useColors } from "@/theme";

/** Quoted content set off by a bar in the hairline color down its left edge. */
export function BlockQuote({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: colors.hairline,
        paddingLeft: spacing.md,
        gap: spacing.sm,
      }}
    >
      {children}
    </View>
  );
}
