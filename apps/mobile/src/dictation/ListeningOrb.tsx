import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { SymbolView } from "expo-symbols";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { loadSkia, type SkiaModule } from "./skia";
import { motion, useColors } from "@/theme";
import { micLevel, sendLift } from "./signals";
import { useDictation } from "./useDictation";
import { ORB_FADE_MS, ORB_FLIGHT_MS, type OrbState } from "./machine";

const ORB = 140;
/** iPhone display corner radius (pt), so the glow hugs the glass. */
const SCREEN_RADIUS = 55;

/**
 * Dictation's listening glow, after Siri: a gradient light (orange, pink, violet, blue) wrapped
 * around the screen's rounded edge, swirling slowly and swelling with the mic. Renders the
 * statechart's `orb` region: shown while listening, brighter as the finger lifts and held bright
 * once the swipe has armed a submit, sweeping away after release, or fading into the check after a
 * plain send. Skia shader when the native module is present; a plain border keeps older dev
 * clients working.
 */
export function ListeningOrb() {
  const { orb } = useDictation();
  if (orb === "hidden" || orb === "gone") return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <EdgeBody orb={orb} />
    </View>
  );
}

/**
 * The whole window, wherever this overlay's parent sits (inside safe-area and keyboard insets),
 * so the glow reaches the physical edge of the glass.
 */
function useWindowFrame(): { ref: RefObject<View | null>; onLayout: () => void; offset: { x: number; y: number } } {
  const ref = useRef<View>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const onLayout = () => {
    ref.current?.measureInWindow((x, y) => {
      setOffset((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
    });
  };
  return { ref, onLayout, offset };
}

function EdgeBody({ orb }: { orb: OrbState }) {
  const { width, height } = useWindowDimensions();
  const frame = useWindowFrame();

  // Each shared value is a tween toward what the current orb state prescribes.
  const presence = useSharedValue(0);
  const collapse = useSharedValue(0);
  const held = useSharedValue(0);
  const flight = useSharedValue(0);
  useEffect(() => {
    presence.value = withTiming(orb === "fading" ? 0 : 1, {
      duration: ORB_FADE_MS,
      easing: Easing.out(Easing.cubic),
    });
    collapse.value = withTiming(orb === "collapsing" ? 1 : 0, {
      duration: motion.duration.base,
      easing: Easing.inOut(Easing.cubic),
    });
    held.value = withTiming(orb === "lifted" || orb === "flying" ? 1 : 0, {
      duration: motion.duration.fast,
    });
    flight.value =
      orb === "flying"
        ? withTiming(1, { duration: ORB_FLIGHT_MS, easing: Easing.in(Easing.cubic) })
        : 0;
  }, [orb, presence, collapse, held, flight]);

  // Smoothed level: fast attack, slow release, so speech reads as pulses not jitter.
  const smoothed = useSharedValue(0);
  useFrameCallback((frame) => {
    const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
    const target = micLevel.value;
    const rate = target > smoothed.value ? 14 : 4;
    smoothed.value += (target - smoothed.value) * Math.min(1, rate * dt);
  });

  // Lift: live with the finger while shown, then held at full once armed (the finger's own value
  // is only trusted in those two states, so a stale drag can never leak into the next dictation).
  const tracksFinger = orb === "shown" || orb === "lifted";
  const lift = useDerivedValue(
    () => Math.max(tracksFinger ? sendLift.value : 0, held.value),
    [tracksFinger],
  );
  // Swelling with the voice, flaring as a submit arms, flaring once more as it sends.
  const level = useDerivedValue(() => Math.min(1, Math.max(smoothed.value, lift.value * 0.9) + flight.value * 0.6));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: presence.value * (1 - collapse.value) * (1 - flight.value),
    // Breathes in from slightly outside the screen on appear.
    transform: [{ scale: 1 + (1 - presence.value) * 0.04 }],
  }));

  return (
    <View ref={frame.ref} onLayout={frame.onLayout} style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[{ position: "absolute", left: -frame.offset.x, top: -frame.offset.y, width, height }, glowStyle]}
      >
        <EdgeSurface width={width} height={height} level={level} />
      </Animated.View>
      {orb === "collapsing" && (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <SentCheck />
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Skia surface with a View fallback
// ---------------------------------------------------------------------------------------------

function EdgeSurface({ width, height, level }: { width: number; height: number; level: SharedValue<number> }): ReactNode {
  const sk = loadSkia();
  return sk === null ? <FallbackEdge /> : <SkiaEdge sk={sk} width={width} height={height} level={level} />;
}

// Edge light. Distance in from the screen's rounded rectangle sets brightness: a bright thin core
// against the glass and a wide soft haze falling off inward. Hue runs around the perimeter by
// angle and drifts with time; the band's width ripples along the edge and grows with `u_level`.
const EDGE_SHADER = `
uniform float2 u_res;
uniform float  u_time;
uniform float  u_level;
uniform float  u_radius;

float sdRoundRect(float2 p, float2 b, float r) {
  float2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float3 palette(float h) {
  float3 orange = float3(1.00, 0.56, 0.22);
  float3 pink   = float3(1.00, 0.30, 0.58);
  float3 violet = float3(0.66, 0.36, 1.00);
  float3 blue   = float3(0.30, 0.62, 1.00);
  float x = fract(h) * 4.0;
  if (x < 1.0) return mix(orange, pink, smoothstep(0.0, 1.0, x));
  if (x < 2.0) return mix(pink, violet, smoothstep(0.0, 1.0, x - 1.0));
  if (x < 3.0) return mix(violet, blue, smoothstep(0.0, 1.0, x - 2.0));
  return mix(blue, orange, smoothstep(0.0, 1.0, x - 3.0));
}

half4 main(float2 xy) {
  float2 p = xy - u_res * 0.5;
  float d = max(0.0, -sdRoundRect(p, u_res * 0.5, u_radius));   // points in from the edge
  float a = atan(p.y, p.x) / 6.2831853;
  float t = u_time * (1.0 + u_level * 1.2);

  float ripple = 0.5 + 0.5 * sin(a * 18.85 + t * 1.7) * sin(a * 31.4 - t * 1.1);
  float width = 10.0 + u_level * 34.0 + ripple * (6.0 + u_level * 18.0);
  float core = exp(-d / (width * 0.28));
  float haze = exp(-d / (width * 1.6)) * 0.55;
  float glow = (core + haze) * (0.75 + u_level * 0.5);

  float3 col = palette(a + t * 0.06 + 0.06 * sin(t * 0.7 + a * 12.566));
  col = mix(col, float3(1.0), core * 0.25);                       // whiter where it meets the glass
  float alpha = clamp(glow, 0.0, 1.0);
  return half4(half3(col * alpha), half(alpha));
}
`;

function SkiaEdge({ sk, width, height, level }: { sk: SkiaModule; width: number; height: number; level: SharedValue<number> }) {
  const { Canvas, Fill, Shader, Skia } = sk;
  const [effect] = useState(() => Skia.RuntimeEffect.Make(EDGE_SHADER));
  const time = useSharedValue(0);
  useFrameCallback((frame) => {
    time.value += (frame.timeSincePreviousFrame ?? 16) / 1000;
  });
  const uniforms = useDerivedValue(() => ({
    u_res: [width, height],
    u_time: time.value,
    u_level: level.value,
    u_radius: SCREEN_RADIUS,
  }));
  if (effect === null) return <FallbackEdge />;
  return (
    <Canvas style={{ width, height }}>
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}

/** A plain accent border along the screen's edge: no shader, same placement. */
function FallbackEdge() {
  const colors = useColors();
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        { borderWidth: 6, borderRadius: SCREEN_RADIUS, borderColor: colors.accent, opacity: 0.8 },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Sent check
// ---------------------------------------------------------------------------------------------

function SentCheck() {
  const colors = useColors();
  const scale = useSharedValue(0.3);
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(1, { duration: motion.duration.fast });
    scale.value = withSpring(1, { damping: 11, stiffness: 260 });
    return () => {
      cancelAnimation(scale);
      cancelAnimation(opacity);
    };
  }, [scale, opacity]);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  return (
    <Animated.View style={[{ position: "absolute" }, style]}>
      <View
        style={{
          width: ORB * 0.5,
          height: ORB * 0.5,
          borderRadius: ORB * 0.25,
          backgroundColor: colors.ok,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <SymbolView name="checkmark" size={ORB * 0.24} tintColor={colors.bg} weight="bold" />
      </View>
    </Animated.View>
  );
}
