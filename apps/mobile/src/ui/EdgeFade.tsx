import { StyleSheet, View } from "react-native";
import { loadSkia } from "@/dictation/skia";
import { withAlpha } from "@/theme";

/** Fraction of the height held at full strength before the fade begins, unless overridden. */
const DEFAULT_SOLID = 0.45;
/** Slices in the View fallback, for a build without Skia. */
const BANDS = 14;

export interface EdgeFadeProps {
  /** The page background as `#RRGGBB`; the fade runs from it to transparent. */
  color: string;
  height: number;
  /** Opacity of the color at the top edge, 0 to 1. Default 1. */
  strength?: number;
  /** Fraction of the height held at full strength before easing out. Default 0.45. */
  solid?: number;
}

/**
 * A top-edge fade: the page background at the top edge easing to transparent, laid over a
 * scrolling list so rows passing under a floating header dim out. Touches pass through.
 */
export function EdgeFade({ color, height, strength = 1, solid = DEFAULT_SOLID }: EdgeFadeProps) {
  const sk = loadSkia();
  return (
    <View pointerEvents="none" style={[styles.root, { height }]}>
      {sk === null ? (
        Array.from({ length: BANDS }, (_, i) => {
          const t = (i + 0.5) / BANDS;
          const opacity = strength * (t <= solid ? 1 : 1 - (t - solid) / (1 - solid));
          return <View key={i} style={{ height: height / BANDS, backgroundColor: color, opacity }} />;
        })
      ) : (
        <sk.Canvas style={StyleSheet.absoluteFill}>
          <sk.Fill>
            <sk.LinearGradient
              start={sk.vec(0, 0)}
              end={sk.vec(0, height)}
              colors={[withAlpha(color, strength), withAlpha(color, strength), withAlpha(color, 0)]}
              positions={[0, solid, 1]}
            />
          </sk.Fill>
        </sk.Canvas>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0 },
});
