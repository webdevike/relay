import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
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
import type * as SkiaNamespace from "@shopify/react-native-skia";
import { colors, motion } from "@/theme";
import { micLevel, useDictationStore } from "./signals";
import type { DictationPhase } from "./machine";

const ORB = 140;
const CANVAS = ORB * 1.6; // room for the glow

/**
 * Centered dictation orb. Appears while listening, breathes with the mic level, collapses into a
 * checkmark when the transcript has been delivered, then fades. Rendered with a Skia shader when
 * the native module is present; a layered-View fallback keeps older dev clients working.
 */
export function ListeningOrb() {
  const phase = useDictationStore((s) => s.phase);
  const visible = phase === "listening" || phase === "finishing" || phase === "sending" || phase === "sent";
  const [mounted, setMounted] = useState(visible);

  // Keep mounted through the exit animation.
  useEffect(() => {
    if (visible) setMounted(true);
    else {
      const id = setTimeout(() => {
        setMounted(false);
      }, motion.duration.base + 60);
      return () => {
        clearTimeout(id);
      };
    }
    return undefined;
  }, [visible]);

  if (!mounted) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <OrbBody phase={phase} />
      </View>
    </View>
  );
}

function OrbBody({ phase }: { phase: DictationPhase }) {
  const listening = phase === "listening";
  const settling = phase === "finishing" || phase === "sending";
  const sent = phase === "sent";

  // Presence: 0 hidden, 1 shown. Sent collapses the orb to make room for the check.
  const presence = useSharedValue(0);
  const collapse = useSharedValue(0);
  useEffect(() => {
    presence.value = withTiming(listening || settling ? 1 : 0, {
      duration: motion.duration.base,
      easing: Easing.out(Easing.cubic),
    });
    collapse.value = withTiming(sent ? 1 : 0, { duration: motion.duration.base, easing: Easing.inOut(Easing.cubic) });
  }, [listening, settling, sent, presence, collapse]);

  // Smoothed level: fast attack, slow release, so speech reads as pulses not jitter.
  const smoothed = useSharedValue(0);
  useFrameCallback((frame) => {
    const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
    const target = micLevel.value;
    const rate = target > smoothed.value ? 14 : 4;
    smoothed.value += (target - smoothed.value) * Math.min(1, rate * dt);
  });

  const scale = useDerivedValue(() => {
    const breathe = 1 + smoothed.value * 0.22;
    return presence.value * (0.6 + 0.4 * presence.value) * breathe * (1 - collapse.value * 0.55);
  });
  const orbStyle = useAnimatedStyle(() => ({
    opacity: presence.value * (1 - collapse.value),
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={{ width: CANVAS, height: CANVAS, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={[{ width: CANVAS, height: CANVAS, alignItems: "center", justifyContent: "center" }, orbStyle]}>
        <OrbSurface level={smoothed} />
      </Animated.View>
      {sent && <SentCheck />}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Skia surface with a View fallback
// ---------------------------------------------------------------------------------------------

type SkiaModule = typeof SkiaNamespace;

let skia: SkiaModule | null | undefined;
function loadSkia(): SkiaModule | null {
  if (skia !== undefined) return skia;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module
    skia = require("@shopify/react-native-skia") as SkiaModule;
  } catch {
    skia = null;
  }
  return skia;
}

function OrbSurface({ level }: { level: SharedValue<number> }): ReactNode {
  const sk = loadSkia();
  return sk === null ? <FallbackOrb /> : <SkiaOrb sk={sk} level={level} />;
}

// Sphere-shaded disc, two-tone gradient swirled by domain-warped value noise, rim light,
// soft outer glow. `u_level` widens the glow and speeds the swirl; `u_time` in seconds.
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
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

half4 main(float2 xy) {
  float2 uv = (xy - u_res * 0.5) / (u_res.y * 0.5);   // -1..1, orb radius ~0.62
  float r = length(uv);
  float radius = 0.62;

  // Swirl: warp the lookup by a slowly rotating noise field.
  float t = u_time * (0.18 + u_level * 0.35);
  float2 q = uv * 1.6 + float2(t * 0.7, -t * 0.4);
  float2 warp = float2(fbm(q), fbm(q + float2(5.2, 1.3)));
  float n = fbm(uv * 2.2 + warp * 1.4 + float2(-t * 0.5, t * 0.3));

  // Palette: deep indigo -> periwinkle -> pale cyan highlight.
  half3 deep = half3(0.16, 0.20, 0.55);
  half3 mid  = half3(0.49, 0.61, 1.00);
  half3 hi   = half3(0.80, 0.92, 1.00);
  half3 col  = mix(deep, mid, smoothstep(0.25, 0.75, n));
  col = mix(col, hi, smoothstep(0.62, 0.95, n) * 0.75);

  // Sphere shading: light from upper-left, darker limb.
  float2 lightDir = normalize(float2(-0.55, -0.7));
  float z = sqrt(max(0.0, 1.0 - (r / radius) * (r / radius)));
  float lambert = clamp(dot(normalize(float3(uv / radius, z)), normalize(float3(lightDir, 0.9))), 0.0, 1.0);
  col *= 0.55 + 0.6 * lambert;
  col += hi * pow(lambert, 18.0) * 0.35;                       // specular
  col += mid * smoothstep(radius - 0.14, radius, r) * 0.35;    // rim

  float body = 1.0 - smoothstep(radius - 0.012, radius + 0.004, r);
  float glowWidth = 0.22 + u_level * 0.22;
  float glow = (1.0 - smoothstep(radius, radius + glowWidth, r)) * (0.28 + u_level * 0.35);
  half3 glowCol = mix(mid, hi, 0.3);

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
