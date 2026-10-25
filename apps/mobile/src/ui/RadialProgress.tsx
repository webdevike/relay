/**
 * A ring that fills clockwise from 12 o'clock as an Animated value goes 0 -> 1, with anything
 * (a glyph) centred inside. Built from plain views: each half of the ring is a half-arc that rotates
 * into a clipped half, so following a drag only changes two rotations, which the native Animated
 * driver applies straight to the views. (A Skia canvas here cost a GPU flush and a Metal drawable
 * on the main thread every frame, presented out of step with the card it sits on.)
 */
import type { ReactNode } from "react";
import { Animated, StyleSheet, View } from "react-native";

export interface RadialProgressProps {
  /** 0..1; values outside are clamped. */
  progress: Animated.AnimatedInterpolation<number> | Animated.Value;
  size: number;
  stroke?: number;
  color: string;
  trackColor: string;
  children?: ReactNode;
}

export function RadialProgress({ progress, size, stroke = 3, color, trackColor, children }: RadialProgressProps) {
  const half = size / 2;
  const ring = { width: size, height: size, borderRadius: half, borderWidth: stroke, borderColor: color };
  // First half: the left half-arc turns clockwise into the right clip (12 -> 6 o'clock).
  const first = progress.interpolate({ inputRange: [0, 0.5], outputRange: ["0deg", "180deg"], extrapolate: "clamp" });
  // Second half: the right half-arc turns clockwise into the left clip (6 -> 12 o'clock).
  const second = progress.interpolate({ inputRange: [0.5, 1], outputRange: ["0deg", "180deg"], extrapolate: "clamp" });
  return (
    <View style={[styles.root, { width: size, height: size }]}>
      <View style={[StyleSheet.absoluteFill, { borderRadius: half, borderWidth: stroke, borderColor: trackColor }]} />
      <View style={[styles.clip, { left: half, width: half, height: size }]}>
        <Animated.View style={[styles.spin, { left: -half, width: size, height: size, transform: [{ rotate: first }] }]}>
          <View style={[styles.clip, { left: 0, width: half, height: size }]}>
            <View style={ring} />
          </View>
        </Animated.View>
      </View>
      <View style={[styles.clip, { left: 0, width: half, height: size }]}>
        <Animated.View style={[styles.spin, { left: 0, width: size, height: size, transform: [{ rotate: second }] }]}>
          <View style={[styles.clip, { left: half, width: half, height: size }]}>
            <View style={[ring, { marginLeft: -half }]} />
          </View>
        </Animated.View>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center" },
  clip: { position: "absolute", top: 0, overflow: "hidden" },
  spin: { position: "absolute", top: 0 },
});
