import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { loadSkia, type SkiaModule } from "@/dictation/skia";
import { colors } from "@/theme";

/** A pill (circle when `width === height`) bitten out of the surface, centered at (`cx`, `cy`) in its coordinates; `cy` may lie on or past an edge. `cx` defaults to the middle. */
export interface Notch {
  cx?: number;
  cy: number;
  width: number;
  height: number;
}

export interface NotchedSurfaceProps {
  color: string;
  radius: number;
  notches: readonly Notch[];
  style?: StyleProp<ViewStyle>;
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}

/**
 * A bordered card whose outline genuinely wraps whatever straddles its edge: the fill and the
 * hairline are one Skia path (the rounded rectangle minus every notch), so the border runs along
 * the concave arc instead of stopping under an overlay. The fill sits under the children and the
 * hairline over them, so content scrolled up to a notch never paints across the outline. Without
 * Skia in the build it degrades to the plain bordered card.
 */
export function NotchedSurface({ color, radius, notches, style, onLayout, children }: NotchedSurfaceProps) {
  const sk = loadSkia();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    onLayout?.(event);
  };
  if (sk === null) {
    return (
      <View style={[styles.fallback, { borderRadius: radius, backgroundColor: color }, style]} onLayout={onLayout}>
        {children}
      </View>
    );
  }
  return (
    <View style={[styles.surface, { borderRadius: radius }, style]} onLayout={measure}>
      {size.width > 0 && <Outline sk={sk} size={size} color={color} radius={radius} notches={notches} layer="fill" />}
      {children}
      {size.width > 0 && <Outline sk={sk} size={size} color={color} radius={radius} notches={notches} layer="stroke" />}
    </View>
  );
}

interface OutlineProps {
  sk: SkiaModule;
  size: { width: number; height: number };
  color: string;
  radius: number;
  notches: readonly Notch[];
  layer: "fill" | "stroke";
}

function Outline({ sk, size, color, radius, notches, layer }: OutlineProps) {
  const { Canvas, Path, Skia, PathOp } = sk;
  // The stroke is centered on the path, so the outer edge is pulled in half a point and every
  // notch pushed out half a point; the whole hairline then lands inside the card and outside
  // the ring, where nothing else paints.
  const inset = layer === "stroke" ? 0.5 : 0;
  const path = useMemo(() => {
    const shape = Skia.Path.Make();
    shape.addRRect(Skia.RRectXY(Skia.XYWHRect(inset, inset, size.width - inset * 2, size.height - inset * 2), radius - inset, radius - inset));
    for (const notch of notches) {
      const width = notch.width + inset * 2;
      const height = notch.height + inset * 2;
      const cx = notch.cx ?? size.width / 2;
      const bite = Skia.Path.Make();
      bite.addRRect(Skia.RRectXY(Skia.XYWHRect(cx - width / 2, notch.cy - height / 2, width, height), height / 2, height / 2));
      shape.op(bite, PathOp.Difference);
    }
    return shape;
  }, [Skia, PathOp, inset, size.width, size.height, radius, notches]);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {layer === "fill" ? <Path path={path} color={color} /> : <Path path={path} color={colors.hairline} style="stroke" strokeWidth={1} />}
    </Canvas>
  );
}

const styles = StyleSheet.create({
  surface: { overflow: "hidden" },
  fallback: { overflow: "hidden", borderWidth: 1, borderColor: colors.hairline },
});
