import { StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { useScheme } from "@/theme";

/** Stacked layers, each a fraction shorter than the last, so blur strength ramps down toward the bottom edge. */
const LAYERS = 4;
const LAYER_INTENSITY = 10;

export interface TopBlurProps {
  height: number;
}

/**
 * Blurs whatever scrolls under the top `height` points. Several thin blurs of decreasing height
 * stack into a gradient, since one `BlurView` has a hard bottom edge. Touches pass through.
 */
export function TopBlur({ height }: TopBlurProps) {
  const scheme = useScheme();
  return (
    <View pointerEvents="none" style={[styles.root, { height }]}>
      {Array.from({ length: LAYERS }, (_, i) => (
        <BlurView
          key={i}
          intensity={LAYER_INTENSITY}
          tint={scheme}
          style={[styles.layer, { height: (height * (LAYERS - i)) / LAYERS }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0 },
  layer: { position: "absolute", top: 0, left: 0, right: 0 },
});
