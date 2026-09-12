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
  /** Rendered above the outline layer: whatever sits in a notch of this surface (the mic in the panel). */
  overlay?: ReactNode;
}

/**
 * A bordered card whose outline genuinely wraps whatever straddles its edge: the fill and the
 * hairline are one Skia path (the rounded rectangle minus every notch), so the border runs along
 * the concave arc instead of stopping under an overlay. The fill sits under the children and the
 * hairline over them, so content scrolled up to a notch never paints across the outline. Without
 * Skia in the build it degrades to the plain bordered card.
 */
export function NotchedSurface({ color, radius, notches, style, onLayout, children, overlay }: NotchedSurfaceProps) {
  const sk = loadSkia();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    onLayout?.(event);
  };
  if (sk === null) {
    return (
      <View style={[styles.fallback, { borderRadius: radius, backgroundColor: color }, style]} onLayout={onLayout} collapsable={false}>
        <View style={[styles.content, { borderRadius: radius }]}>{children}</View>
        {overlay}
      </View>
    );
  }
  // Content is clipped by an inner view, not the surface itself, so the overlay may hang past the
  // edge. The outer view stays a real native view (a GestureDetector may be attached to it).
  return (
    <View style={style} onLayout={measure} collapsable={false}>
      {size.width > 0 && <Outline sk={sk} size={size} color={color} radius={radius} notches={notches} layer="fill" />}
      <View style={[styles.content, { borderRadius: radius }]}>{children}</View>
      {size.width > 0 && <Outline sk={sk} size={size} color={color} radius={radius} notches={notches} layer="stroke" />}
      {overlay}
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

/** The card shape: the rounded rectangle minus every notch, with the outline pulled `inset` points inward. */
function shapeOf(sk: SkiaModule, size: { width: number; height: number }, radius: number, notches: readonly Notch[], inset: number) {
  const { Skia, PathOp } = sk;
  const shape = Skia.Path.Make();
  shape.addRRect(Skia.RRectXY(Skia.XYWHRect(inset, inset, size.width - inset * 2, size.height - inset * 2), radius - inset, radius - inset));
  for (const notch of notches) shape.op(biteOf(sk, size, notch, inset), PathOp.Difference);
  return shape;
}

/** One notch, grown by `inset` on every side. */
function biteOf(sk: SkiaModule, size: { width: number; height: number }, notch: Notch, inset: number) {
  const width = notch.width + inset * 2;
  const height = notch.height + inset * 2;
  const cx = notch.cx ?? size.width / 2;
  const bite = sk.Skia.Path.Make();
  bite.addRRect(sk.Skia.RRectXY(sk.Skia.XYWHRect(cx - width / 2, notch.cy - height / 2, width, height), height / 2, height / 2));
  return bite;
}

function Outline({ sk, size, color, radius, notches, layer }: OutlineProps) {
  const { Canvas, Path } = sk;
  // Fill: the exact shape. Stroke: the hairline is centered on the path, so the shape is pulled in
  // half a point on every edge, outer and notch alike, and the whole line lands inside the card
  // like a border would. The notches themselves are painted screen background first, over the
  // children, so content scrolled into the gap is hidden and the hairline meets background there
  // exactly as it does along the outer edge.
  const shape = useMemo(() => shapeOf(sk, size, radius, notches, layer === "stroke" ? 0.5 : 0), [sk, size, radius, notches, layer]);
  const gaps = useMemo(() => {
    if (layer !== "stroke") return null;
    const all = sk.Skia.Path.Make();
    for (const notch of notches) all.addPath(biteOf(sk, size, notch, 0));
    return all;
  }, [sk, size, notches, layer]);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {layer === "fill" ? (
        <Path path={shape} color={color} />
      ) : (
        <>
          {gaps !== null && <Path path={gaps} color={colors.bg} />}
          <Path path={shape} color={colors.hairline} style="stroke" strokeWidth={1} />
        </>
      )}
    </Canvas>
  );
}

const styles = StyleSheet.create({
  // Grow to fill a sized surface (the chat card), but size to the children in an auto-height one
  // (the header): `flex: 1` would set a zero basis and collapse it.
  content: { flexGrow: 1, flexShrink: 1, overflow: "hidden" },
  fallback: { borderWidth: 1, borderColor: colors.hairline },
});
