import { useEffect, useMemo } from "react";
import { StyleSheet } from "react-native";
import { Easing, useDerivedValue, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { loadSkia } from "@/dictation/skia";

/** Distance between dot centres. */
const PITCH = 12;
const RADIUS = 1.4;
/** One sweep of the light band across the box. */
const SWEEP_MS = 1600;

export interface DotMatrixProps {
  width: number;
  height: number;
}

/**
 * A grid of small white dots over media with a band of light sweeping across it, the "working on
 * it" texture of Studio's generating overlay. Needs Skia; without it nothing is drawn.
 */
export function DotMatrix({ width, height }: DotMatrixProps) {
  const sk = loadSkia();
  const sweep = useSharedValue(0);
  useEffect(() => {
    sweep.value = withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }), -1, false);
  }, [sweep]);
  const dots = useMemo(() => {
    if (sk === null || width <= 0 || height <= 0) return null;
    const path = sk.Skia.Path.Make();
    for (let y = PITCH / 2; y < height; y += PITCH) for (let x = PITCH / 2; x < width; x += PITCH) path.addCircle(x, y, RADIUS);
    return path;
  }, [sk, width, height]);
  // The band runs from fully left of the box to fully right of it, so it enters and leaves clean.
  const start = useDerivedValue(() => ({ x: -width + sweep.value * width * 2, y: 0 }));
  const end = useDerivedValue(() => ({ x: sweep.value * width * 2, y: height * 0.4 }));
  if (sk === null || dots === null) return null;
  return (
    <sk.Canvas style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
      <sk.Group layer>
        <sk.Path path={dots} color="rgba(255,255,255,0.55)" />
        <sk.Rect x={0} y={0} width={width} height={height} blendMode="dstIn">
          <sk.LinearGradient start={start} end={end} colors={["transparent", "black", "transparent"]} />
        </sk.Rect>
      </sk.Group>
    </sk.Canvas>
  );
}
