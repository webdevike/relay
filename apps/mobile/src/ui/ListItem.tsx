import type { ReactNode } from "react";
import { View } from "react-native";
import { spacing } from "@/theme";

export interface ListItemProps {
  /** Bullet, number, or check, drawn in a fixed-width column so item text lines up. */
  marker: ReactNode;
  markerWidth?: number;
  children: ReactNode;
}

/**
 * One list item: the content indented by the marker column, the marker pinned in that indent (it
 * adds no height, so it must fit the content's first line). The content is a plain stretched
 * column, like a paragraph, not a `flex: 1` row child: inside a shrink-to-fit parent (the
 * assistant's chat bubble) that hid the item text's width, so the bubble sized itself to its
 * other blocks, came out shorter than its wrapped items, and their text spilled over the next message.
 */
export function ListItem({ marker, markerWidth = 16, children }: ListItemProps) {
  return (
    <View style={{ paddingLeft: markerWidth }}>
      <View style={{ position: "absolute", left: 0, top: 0, width: markerWidth }}>{marker}</View>
      <View style={{ gap: spacing.xs }}>{children}</View>
    </View>
  );
}
