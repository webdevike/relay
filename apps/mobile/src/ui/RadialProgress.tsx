/**
 * A ring that fills clockwise from 12 o'clock as a UI-thread value goes 0 -> 1, with anything
 * (a glyph) centred inside. Skia draws the arc straight from the shared value, so it follows a drag
 * frame by frame without React renders; a build without Skia shows the track and fades the
 * ring in with the value instead.
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue, type SharedValue } from "react-native-reanimated";
import { loadSkia } from "@/dictation/skia";

export interface RadialProgressProps {
  /** 0..1; values outside are clamped. */
  progress: SharedValue<number>;
  size: number;
  stroke?: number;
  color: string;
  trackColor: string;
  children?: ReactNode;
}

export function RadialProgress({ progress, size, stroke = 3, color, trackColor, children }: RadialProgressProps) {
  const skia = loadSkia();
  const end = useDerivedValue(() => Math.min(1, Math.max(0, progress.value)));
  const fallbackStyle = useAnimatedStyle(() => ({ opacity: end.value }));
  const inset = stroke / 2;
  const rect = { x: inset, y: inset, width: size - stroke, height: size - stroke };
  let ring: ReactNode;
  if (skia === null) {
    const circle = { borderRadius: size / 2, borderWidth: stroke };
    ring = (
      <>
        <View style={[StyleSheet.absoluteFill, circle, { borderColor: trackColor }]} />
        <Animated.View style={[StyleSheet.absoluteFill, circle, { borderColor: color }, fallbackStyle]} />
      </>
    );
  } else {
    const { Canvas, Path, Skia } = skia;
    const track = Skia.Path.Make();
    track.addOval(rect);
    // Starting at -90 degrees puts the trim's zero at the top; `end` trims the full circle.
    const arc = Skia.Path.Make();
    arc.addArc(rect, -90, 359.999);
    ring = (
      <Canvas style={StyleSheet.absoluteFill}>
        <Path path={track} style="stroke" strokeWidth={stroke} color={trackColor} />
        <Path path={arc} style="stroke" strokeWidth={stroke} strokeCap="round" color={color} start={0} end={end} />
      </Canvas>
    );
  }
  return (
    <View style={[styles.root, { width: size, height: size }]}>
      {ring}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center" },
});
