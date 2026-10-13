import type { ReactNode } from "react";
import { View } from "react-native";
import { spacing } from "@/theme";

export interface ListItemProps {
  /** Bullet, number, or check, drawn in a fixed-width column so item text lines up. */
  marker: ReactNode;
  markerWidth?: number;
  children: ReactNode;
}

/** One list row: the marker column beside the item's content. */
export function ListItem({ marker, markerWidth = 16, children }: ListItemProps) {
  return (
    <View style={{ flexDirection: "row" }}>
      <View style={{ width: markerWidth }}>{marker}</View>
      <View style={{ flex: 1, gap: spacing.xs }}>{children}</View>
    </View>
  );
}
