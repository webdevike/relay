import { useEffect, useState, type ReactNode } from "react";
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
import { colors, motion } from "@/theme";
import { micLevel, sendLift } from "./signals";
import { useDictation } from "./useDictation";
import { ORB_FADE_MS, ORB_FLIGHT_MS, type OrbState } from "./machine";

const ORB = 140;
const CANVAS = ORB * 1.6; // room for the glow

/**
 * Centered dictation orb. Renders the statechart's `orb` region: shown while listening (breathing
 * with the mic, rising with the finger), held lifted once the swipe has armed a submit, flying off
 * the top after release, or collapsing into the check after a plain send. Skia shader when the
 * native module is present; a layered-View fallback keeps older dev clients working.
 */
export function ListeningOrb() {
  const { orb } = useDictation();
  if (orb === "hidden" || orb === "gone") return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <OrbBody orb={orb} />
      </View>
    </View>
  );
}

function OrbBody({ orb }: { orb: OrbState }) {
  const { height } = useWindowDimensions();

  // Each shared value is a tween toward what the current orb state prescribes.
  const presence = useSharedValue(0);
  const collapse = useSharedValue(0);
  const held = useSharedValue(0);
  const flight = useSharedValue(0);
  useEffect(() => {
    presence.value = withTiming(orb === "fading" ? 0 : 1, { duration: ORB_FADE_MS, easing: Easing.out(Easing.cubic) });
    collapse.value = withTiming(orb === "collapsing" ? 1 : 0, { duration: motion.duration.base, easing: Easing.inOut(Easing.cubic) });
    held.value = withTiming(orb === "lifted" || orb === "flying" ? 1 : 0, { duration: motion.duration.fast });
    flight.value = orb === "flying" ? withTiming(1, { duration: ORB_FLIGHT_MS, easing: Easing.in(Easing.cubic) }) : 0;
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
  const lift = useDerivedValue(() => Math.max(tracksFinger ? sendLift.value : 0, held.value), [tracksFinger]);
  const scale = useDerivedValue(() => {
    const breathe = 1 + smoothed.value * 0.22;
    return (
      presence.value *
      (0.6 + 0.4 * presence.value) *
      breathe *
      (1 - collapse.value * 0.55) *
      (1 - lift.value * 0.12) *
      (1 - flight.value * 0.5)
    );
  });
  const glow = useDerivedValue(() => Math.max(smoothed.value, lift.value * 0.9));
  const orbStyle = useAnimatedStyle(() => {
    const travel = height * 0.5 + CANVAS;
    return {
      opacity: presence.value * (1 - collapse.value) * (1 - Math.max(0, flight.value - 0.6) / 0.4),
      transform: [{ translateY: -lift.value * 56 - flight.value * travel }, { scale: scale.value }],
    };
  });

  return (
    <View style={{ width: CANVAS, height: CANVAS, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={[{ width: CANVAS, height: CANVAS, alignItems: "center", justifyContent: "center" }, orbStyle]}>
        <OrbSurface level={glow} />
      </Animated.View>
      {orb === "collapsing" && <SentCheck />}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Skia surface with a View fallback
// ---------------------------------------------------------------------------------------------


function OrbSurface({ level }: { level: SharedValue<number> }): ReactNode {
  const sk = loadSkia();
  return sk === null ? <FallbackOrb /> : <SkiaOrb sk={sk} level={level} />;
}

// Glass ball. The view ray refracts into a sphere and samples a liquid interior: three colored
// lights drifting on slow orbits through a warped noise field, with parallax from the refraction
// so the contents shift as you look across the limb. Fresnel rim, a sharp and a soft window
// reflection, and slight chromatic dispersion at the edge sell the glass. `u_level` speeds the
// interior and brightens it; `u_time` in seconds.
const ORB_SHADER = `
uniform float2 u_res;
uniform float  u_time;
uniform float  u_level;

float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453123); }
float noise(float2 p) {
  float2 i = floor(p); float2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1, 0)), f.x), mix(hash(i + float2(0, 1)), hash(i + float2(1, 1)), f.x), f.y);
}
float fbm(float2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 1.9 + 11.7; a *= 0.45; }
  return v;
}

// What lives inside the glass, sampled at refracted point p.
half3 interior(float2 p, float t) {
  float2 c1 = float2(sin(t * 0.70), cos(t * 0.90)) * 0.38;
  float2 c2 = float2(cos(t * 0.50 + 1.7), sin(t * 0.80 + 0.4)) * 0.42;
  float2 c3 = float2(sin(t * 1.10 + 3.1), cos(t * 0.60 + 2.0)) * 0.30;
  float n = fbm(p * 1.7 + float2(t * 0.30, -t * 0.22));
  float2 w = float2(n, fbm(p * 1.7 + float2(4.2, 1.1) - t * 0.25)) - 0.5;
  float2 q = p + w * 0.55;
  float b1 = exp(-dot(q - c1, q - c1) * 6.0);
  float b2 = exp(-dot(q - c2, q - c2) * 5.0);
  float b3 = exp(-dot(q - c3, q - c3) * 9.0);
  half3 col = half3(0.05, 0.06, 0.14);                 // dark glass body
  col += half3(0.36, 0.46, 1.00) * b1 * 0.95;          // periwinkle
  col += half3(0.62, 0.40, 1.00) * b2 * 0.70;          // violet
  col += half3(0.42, 0.88, 1.00) * b3 * 0.65;          // cyan
  col += half3(0.45, 0.55, 1.00) * n * 0.14;           // faint haze
  return col;
}

half4 main(float2 xy) {
  float2 uv = (xy - u_res * 0.5) / (u_res.y * 0.5);   // -1..1, orb radius ~0.62
  uv -= float2(sin(u_time * 0.55), cos(u_time * 0.41)) * 0.035;   // the ball itself drifts lazily
  float r = length(uv);
  float radius = 0.62;
  float2 s = uv / radius;                               // unit-sphere coords
  float rr = length(s);
  float z = sqrt(max(0.0, 1.0 - dot(s, s)));
  float3 n = float3(s, z);
  float3 I = float3(0.0, 0.0, -1.0);                    // view ray into the screen

  // Refract into the ball, march to a mid plane, sample the interior per channel (dispersion).
  float depth = 0.85;
  float t = u_time * (0.45 + u_level * 0.70);
  float2 pR = s + refract(I, n, 1.0 / 1.42).xy * depth;
  float2 pG = s + refract(I, n, 1.0 / 1.45).xy * depth;
  float2 pB = s + refract(I, n, 1.0 / 1.49).xy * depth;
  half3 inner = half3(interior(pR, t).r, interior(pG, t).g, interior(pB, t).b);
  inner *= 1.0 + u_level * 0.7;

  // Glass surface: fresnel rim, thin bright edge, one sharp and one soft window reflection.
  float fres = pow(1.0 - z, 3.0);
  half3 rimCol = half3(0.74, 0.82, 1.00);
  half3 col = inner + rimCol * fres * 0.55;
  col += rimCol * smoothstep(0.90, 0.985, rr) * (1.0 - smoothstep(0.985, 1.0, rr)) * 0.28;
  float3 V = float3(0.0, 0.0, 1.0);
  float3 H1 = normalize(normalize(float3(-0.50, -0.62, 0.62)) + V);
  float3 H2 = normalize(normalize(float3(0.55, 0.70, 0.40)) + V);
  col += half3(1.0) * pow(max(dot(n, H1), 0.0), 140.0) * 0.95;
  col += rimCol * pow(max(dot(n, H2), 0.0), 28.0) * 0.22;
  col *= 0.86 + 0.14 * z;

  float body = 1.0 - smoothstep(radius - 0.012, radius + 0.004, r);
  float glowWidth = 0.22 + u_level * 0.22;
  float glow = (1.0 - smoothstep(radius, radius + glowWidth, r)) * (0.24 + u_level * 0.36);
  half3 glowCol = half3(0.50, 0.58, 1.00);

  half3 outCol = col * body + glowCol * glow * (1.0 - body);
  float alpha = max(body, glow * (1.0 - body));
  return half4(outCol * alpha, alpha);
}
`;

function SkiaOrb({ sk, level }: { sk: SkiaModule; level: SharedValue<number> }) {
  const { Canvas, Fill, Shader, Skia } = sk;
  const [effect] = useState(() => Skia.RuntimeEffect.Make(ORB_SHADER));
  const time = useSharedValue(0);
  useFrameCallback((frame) => {
    time.value += (frame.timeSincePreviousFrame ?? 16) / 1000;
  });
  const uniforms = useDerivedValue(() => ({ u_res: [CANVAS, CANVAS], u_time: time.value, u_level: level.value }));
  if (effect === null) return <FallbackOrb />;
  return (
    <Canvas style={{ width: CANVAS, height: CANVAS }}>
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}

/** Layered translucent discs: no shader, but the same silhouette and breathing. */
function FallbackOrb() {
  const layers = [
    { size: ORB * 1.5, color: colors.accent, opacity: 0.1 },
    { size: ORB * 1.2, color: colors.accent, opacity: 0.18 },
    { size: ORB, color: colors.accent, opacity: 0.9 },
    { size: ORB * 0.55, color: "#C7D6FF", opacity: 0.5 },
  ];
  return (
    <View style={{ width: CANVAS, height: CANVAS, alignItems: "center", justifyContent: "center" }}>
      {layers.map((layer, index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            width: layer.size,
            height: layer.size,
            borderRadius: layer.size / 2,
            backgroundColor: layer.color,
            opacity: layer.opacity,
            transform: index === 3 ? [{ translateX: -ORB * 0.12 }, { translateY: -ORB * 0.14 }] : undefined,
          }}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Sent check
// ---------------------------------------------------------------------------------------------

function SentCheck() {
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
  const style = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ scale: scale.value }] }));
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
