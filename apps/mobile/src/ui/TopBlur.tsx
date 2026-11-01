import { StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { useScheme } from "@/theme";

/** Stacked layers, each a fraction shorter than the last, so blur strength ramps down away from the edge. */
const LAYERS = 4;
const LAYER_INTENSITY = 10;

export interface TopBlurProps {
  height: number;
  /** The edge it sits on: `top` under a floating header (default), `bottom` under floating bottom controls. */
  edge?: "top" | "bottom";
  /** Extra layers for the strongest blur at the edge (bottom controls sit over text that must not read through). */
  strength?: number;
}

/**
 * Blurs whatever scrolls under the top (or bottom) `height` points. Several thin blurs of
 * decreasing height stack into a gradient, since one `BlurView` has a hard edge. Touches pass through.
 */
export function TopBlur({ height, edge = "top", strength = 1 }: TopBlurProps) {
  const scheme = useScheme();
  const layers = LAYERS * strength;
  return (
    <View pointerEvents="none" style={[styles.root, edge === "top" ? styles.top : styles.bottom, { height }]}>
      {Array.from({ length: layers }, (_, i) => (
        <BlurView
          key={i}
          intensity={LAYER_INTENSITY}
          tint={scheme}
          style={[styles.layer, edge === "top" ? styles.top : styles.bottom, { height: (height * (layers - i)) / layers }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", left: 0, right: 0 },
  layer: { position: "absolute", left: 0, right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
