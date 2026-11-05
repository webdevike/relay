import { StyleSheet, View } from "react-native";
import { withAlpha } from "@/theme";

const BANDS = 8;

/**
 * A fade from `color` (a `#RRGGBB`, the page behind) to clear along the left or right edge of a
 * sideways-scrolling row, drawn as thin bands of rising opacity so it needs no gradient module. It
 * is laid over the row (`pointerEvents` none) and only drawn while the row has more to scroll that way.
 */
export function SideFade({ side, color, width = 28 }: { side: "left" | "right"; color: string; width?: number }) {
  const band = width / BANDS;
  return (
    <View pointerEvents="none" style={[styles.fade, side === "left" ? styles.left : styles.right, { width }]}>
      {Array.from({ length: BANDS }, (_, i) => {
        // Opaque at the edge, clear at the inner side.
        const alpha = ((side === "left" ? BANDS - i : i + 1) / (BANDS + 1)) * 0.95;
        return <View key={i} style={{ width: band, backgroundColor: withAlpha(color, alpha) }} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: "absolute", top: 0, bottom: 0, flexDirection: "row" },
  left: { left: 0 },
  right: { right: 0 },
});
