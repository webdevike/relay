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
  /** Which edge of the parent the fade hugs. Default `top`. */
  edge?: "top" | "bottom";
}

/**
 * An edge fade: `color` at the top (or bottom) edge easing to transparent, laid over a scrolling
 * list so rows passing under a floating header dim out. Touches pass through.
 */
export function EdgeFade({ color, height, strength = 1, solid = DEFAULT_SOLID, edge = "top" }: EdgeFadeProps) {
  const sk = loadSkia();
  const bottom = edge === "bottom";
  return (
    <View pointerEvents="none" style={[styles.root, bottom ? styles.bottom : styles.top, { height }]}>
      {sk === null ? (
        Array.from({ length: BANDS }, (_, i) => {
          const t = ((bottom ? BANDS - 1 - i : i) + 0.5) / BANDS;
          const opacity = strength * (t <= solid ? 1 : 1 - (t - solid) / (1 - solid));
          return <View key={i} style={{ height: height / BANDS, backgroundColor: color, opacity }} />;
        })
      ) : (
        <sk.Canvas style={StyleSheet.absoluteFill}>
          <sk.Fill>
            <sk.LinearGradient
              start={sk.vec(0, bottom ? height : 0)}
              end={sk.vec(0, bottom ? 0 : height)}
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
  root: { position: "absolute", left: 0, right: 0 },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
