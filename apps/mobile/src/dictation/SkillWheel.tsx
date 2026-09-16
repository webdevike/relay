import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  interpolate,
  interpolateColor,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { AgentSkill, AgentSkillChoice } from "@relay/protocol";
import { colors, motion } from "@/theme";
import { wheelConfirm, wheelDetent, wheelPosition } from "./signals";
import { loadSkia, type SkiaModule } from "./skia";
import { useDictation } from "./useDictation";

/** How far the finger turns around the mic per entry; the scrubbing feel. */
export const WHEEL_STEP_RAD = (40 * Math.PI) / 180;
/** Angle between neighboring entries on the arc. */
const ARC_STEP_RAD = (34 * Math.PI) / 180;
/** Radius (pt) from the mic's center to the entries. */
const ITEM_RADIUS = 168;
/** The centered entry rises this far (pt) outward from the band. */
const RISE = 6;
/** The band the entries ride on. */
const BAND_OUTER = 228;
const BAND_INNER = 108;
/** Half-size of the square this view occupies; the mic's center is its middle. */
export const WHEEL_EXTENT = BAND_OUTER + 4;
/** Entries this many slots either side of the centered one are mounted; beyond is invisible anyway. */
const WINDOW = 3;
/** Pull toward the nearest slot while scrubbing: 0 is free-running, 1 is hard snapping. */
const MAGNET = 0.35;
/** After the lift the dial stays up this long (ms) for the lock and bloom before fading. */
const LINGER_MS = 520;
const ITEM_WIDTH = 108;
const ICON_SIZE = 28;
/** Notches ring both edges of the band all the way around, this far apart. */
const NOTCH_STEP_RAD = (5 * Math.PI) / 180;
const NOTCH_LENGTH = 7;
const TOP = -Math.PI / 2;
const CENTER = WHEEL_EXTENT;
const ACCENT_RGB = "124,156,255";

const iconFor: Record<string, SFSymbol> = {
  handoff: "arrowshape.turn.up.right",
  goal: "scope",
  "guided-goal": "scope",
  plan: "list.bullet.clipboard",
  vibe: "waveform",
  loop: "repeat",
  queue: "text.badge.plus",
  switch: "arrow.left.arrow.right",
  rename: "pencil",
  btw: "questionmark.bubble",
  tan: "arrow.triangle.branch",
  omfg: "exclamationmark.bubble",
  cleanse: "bandage",
  review: "doc.text.magnifyingglass",
  security: "lock.shield",
  green: "checkmark.seal",
  autoresearch: "magnifyingglass",
  force: "hammer",
  export: "square.and.arrow.up",
  compact: "arrow.down.right.and.arrow.up.left",
  shake: "wind",
  resume: "clock.arrow.circlepath",
  wt: "arrow.triangle.branch",
  git: "point.3.connected.trianglepath.dotted",
  todo: "checklist",
  memory: "brain",
  join: "person.2",
  collab: "person.2",
};
const SKILL_ICON: SFSymbol = "wand.and.stars";
const DEFAULT_ICON: SFSymbol = "command";
/** Subcommand verbs; anything else borrows its parent's icon. */
const choiceIconFor: Record<string, SFSymbol> = {
  set: "pencil.line",
  show: "eye",
  view: "eye",
  status: "info.circle",
  pause: "pause",
  resume: "play",
  start: "play",
  stop: "stop",
  drop: "trash",
  rm: "trash",
  remove: "minus.circle",
  add: "plus.circle",
  budget: "gauge.with.needle",
  on: "checkmark.circle",
  off: "xmark.circle",
  enable: "checkmark.circle",
  disable: "xmark.circle",
  list: "list.bullet",
  export: "square.and.arrow.up",
  import: "square.and.arrow.down",
  copy: "doc.on.doc",
  edit: "pencil",
  done: "checkmark",
  full: "doc.text",
  reset: "arrow.counterclockwise",
  info: "info.circle",
  delete: "trash",
};

function iconOf(skill: AgentSkill): SFSymbol {
  if (skill.command.startsWith("/skill:")) return SKILL_ICON;
  return iconFor[skill.name] ?? DEFAULT_ICON;
}

/** A ring's entries with their icons: the top ring, or one entry's choices under its icon. */
interface RingEntry {
  entry: AgentSkillChoice;
  icon: SFSymbol;
  hasChoices: boolean;
}

function ringOf(
  skills: AgentSkill[],
  parent: string | null,
): { name: string | null; entries: RingEntry[] } {
  if (parent !== null) {
    const owner = skills.find((skill) => skill.command === parent);
    if (owner !== undefined) {
      const fallback = iconOf(owner);
      const entries = (owner.choices ?? []).map((choice) => ({
        entry: choice,
        icon: choiceIconFor[choice.name] ?? fallback,
        hasChoices: false,
      }));
      return { name: owner.name, entries };
    }
  }
  return {
    name: null,
    entries: skills.map((skill) => ({
      entry: skill,
      icon: iconOf(skill),
      hasChoices: (skill.choices?.length ?? 0) > 0,
    })),
  };
}

/** Index into the list for an unbounded slot. */
function wrapIndex(slot: number, count: number): number {
  return ((slot % count) + count) % count;
}

export interface SkillWheelProps {
  skills: AgentSkill[];
}

/**
 * Arc dial centered on the mic under the thumb, up while the chart is `choosing` and for a beat
 * after the lift so the lock and its bloom play out. It shows whichever ring the chart says: the
 * top list, or one entry's choices with the entry's name by the inner marker. The list wraps
 * around an unbounded wheel position: slots `center ± WINDOW` are mounted, each showing the
 * entry at its index modulo the count, so there is no first or last. Every entry's look is one
 * continuous function of its angular distance from the selection axis at the top (`DialEntry`);
 * the marker, spotlight, and notches are the static light source the wheel turns under
 * (`SkiaBackdrop`).
 */
export function SkillWheel({ skills }: SkillWheelProps) {
  const { phase, skill, wheelParent } = useDictation();
  const choosing = phase === "choosing" || phase === "chosen";
  const [lingering, setLingering] = useState(false);
  const wasChoosing = useRef(false);
  useEffect(() => {
    if (choosing) {
      wasChoosing.current = true;
      setLingering(false);
      return;
    }
    if (!wasChoosing.current) return;
    wasChoosing.current = false;
    // Left the wheel with something picked: the lift locked it; let the confirmation play.
    if (skill === null) return;
    setLingering(true);
    const timer = setTimeout(() => {
      setLingering(false);
    }, LINGER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [choosing, skill]);

  // The centered slot, mirrored to React so only the entries around it are mounted.
  const [center, setCenter] = useState(() => Math.round(wheelPosition.value));
  useAnimatedReaction(
    () => Math.round(wheelPosition.value),
    (slot, previous) => {
      if (slot !== previous) scheduleOnRN(setCenter, slot);
    },
  );
  // The ring the lock is playing on: the chart drops `wheelParent` on the pick, the dial should not.
  const shownParent = useRef<string | null>(null);
  if (choosing) shownParent.current = wheelParent;
  const ring = ringOf(skills, shownParent.current);

  if (!(choosing || lingering) || ring.entries.length === 0) return null;
  const slots: number[] = [];
  for (let slot = center - WINDOW; slot <= center + WINDOW; slot += 1) slots.push(slot);
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(motion.duration.base)}
      exiting={FadeOut.duration(motion.duration.base)}
      style={styles.dial}
    >
      <Backdrop />
      <Animated.View
        key={ring.name ?? ""}
        entering={FadeIn.duration(motion.duration.base)}
        exiting={FadeOut.duration(motion.duration.fast)}
        style={styles.ring}
      >
        {slots.map((slot) => {
          const item = ring.entries[wrapIndex(slot, ring.entries.length)];
          return item === undefined ? null : <DialEntry key={slot} slot={slot} item={item} />;
        })}
        {ring.name !== null && (
          <View style={styles.parent}>
            <SymbolView name="chevron.down" size={9} tintColor={colors.textFaint} />
            <Text style={styles.parentLabel}>{ring.name}</Text>
          </View>
        )}
      </Animated.View>
    </Animated.View>
  );
}

/** Where the entries and notches sit for the raw position: drawn a little toward the nearest slot. */
function shownPosition(raw: number): number {
  "worklet";
  return raw + (Math.round(raw) - raw) * MAGNET;
}

/**
 * One slot on the dial. `proximity` is 1 under the marker and 0 a slot away; `presence` is how
 * much of the entry is there at all, gone three slots out. Scale, rise, icon whiteness and glow,
 * label color and weight of presence all follow those two, so an entry fades out exactly as the
 * next one emerges into the light. The detent tick and the lock's pulse ride on top.
 */
function DialEntry({ slot, item }: { slot: number; item: RingEntry }) {
  const style = useAnimatedStyle(() => {
    const offset = slot - shownPosition(wheelPosition.value);
    const distance = Math.abs(offset);
    const proximity = Math.max(0, 1 - distance);
    const presence = interpolate(distance, [0, 1, 2, 3], [1, 0.6, 0.22, 0], "clamp");
    const pulse = 1 + (0.03 * wheelDetent.value + 0.08 * wheelConfirm.value) * proximity;
    const shade = 1 - 0.3 * wheelConfirm.value * (1 - proximity);
    const angle = TOP - offset * ARC_STEP_RAD;
    const radius = ITEM_RADIUS + RISE * proximity;
    return {
      opacity: presence * shade,
      transform: [
        { translateX: radius * Math.cos(angle) },
        { translateY: radius * Math.sin(angle) },
        { rotate: `${angle + Math.PI / 2}rad` },
        { scale: (0.82 + 0.33 * proximity) * pulse },
      ],
    };
  });
  const litStyle = useAnimatedStyle(() => {
    const proximity = Math.max(0, 1 - Math.abs(slot - shownPosition(wheelPosition.value)));
    return {
      opacity: proximity,
      shadowOpacity: 0.45 * proximity + 0.4 * wheelConfirm.value * proximity,
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    const proximity = Math.max(0, 1 - Math.abs(slot - shownPosition(wheelPosition.value)));
    return {
      opacity: 0.3 + 0.7 * proximity,
      color: interpolateColor(proximity, [0, 1], [colors.textMuted, "#FFFFFF"]),
    };
  });
  return (
    <Animated.View style={[styles.entry, style]}>
      <View style={styles.hint}>
        {item.hasChoices && <SymbolView name="chevron.up" size={9} tintColor={colors.textFaint} />}
      </View>
      <View style={styles.icon}>
        <SymbolView
          name={item.icon}
          size={ICON_SIZE}
          tintColor={colors.textFaint}
          style={styles.iconLayer}
        />
        <Animated.View style={[styles.iconLayer, styles.iconLit, litStyle]}>
          <SymbolView name={item.icon} size={ICON_SIZE} tintColor="#FFFFFF" />
        </Animated.View>
      </View>
      <Animated.Text numberOfLines={1} style={[styles.entryLabel, labelStyle]}>
        {item.entry.name}
      </Animated.Text>
    </Animated.View>
  );
}

function Backdrop() {
  const sk = loadSkia();
  return sk === null ? <FallbackBackdrop /> : <SkiaBackdrop sk={sk} />;
}

/** SVG path of radial notches at `radius`, all the way around. */
function notchPath(radius: number, inward: boolean): string {
  const parts: string[] = [];
  const from = radius;
  const to = inward ? radius - NOTCH_LENGTH : radius + NOTCH_LENGTH;
  for (let angle = 0; angle < 2 * Math.PI - 1e-6; angle += NOTCH_STEP_RAD) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    parts.push(`M${CENTER + from * c} ${CENTER + from * s}L${CENTER + to * c} ${CENTER + to * s}`);
  }
  return parts.join("");
}

/** Arc at `radius` spanning `halfSpan` either side of the top. */
function topArcPath(radius: number, halfSpan: number): string {
  const a0 = TOP - halfSpan;
  const a1 = TOP + halfSpan;
  const x0 = CENTER + radius * Math.cos(a0);
  const y0 = CENTER + radius * Math.sin(a0);
  const x1 = CENTER + radius * Math.cos(a1);
  const y1 = CENTER + radius * Math.sin(a1);
  return `M${x0} ${y0}A${radius} ${radius} 0 0 1 ${x1} ${y1}`;
}

/** Wedge of the band under the marker, `halfSpan` either side of the top. */
function sectorPath(inner: number, outer: number, halfSpan: number): string {
  const a0 = TOP - halfSpan;
  const a1 = TOP + halfSpan;
  const point = (r: number, a: number): string =>
    `${CENTER + r * Math.cos(a)} ${CENTER + r * Math.sin(a)}`;
  return `M${point(inner, a0)}L${point(outer, a0)}A${outer} ${outer} 0 0 1 ${point(outer, a1)}L${point(inner, a1)}A${inner} ${inner} 0 0 0 ${point(inner, a0)}Z`;
}

/**
 * Black anodized dial lit by blue LEDs at the selection axis. Static: the ring's depth, the
 * outer notches, the spotlight wedge, the lit edges, the markers. Turning: the inner notches,
 * brightening as they pass under the light (the gradient that lights them counter-rotates so it
 * stays fixed to the axis). Pulsing: the marker and bloom on each detent and on the lock.
 */
function SkiaBackdrop({ sk }: { sk: SkiaModule }) {
  const { Canvas, Circle, Path, BlurMask, RadialGradient, RoundedRect, Group, vec, Skia } = sk;
  const paths = useMemo(
    () => ({
      innerNotches: Skia.Path.MakeFromSVGString(notchPath(BAND_INNER, false)),
      outerNotches: Skia.Path.MakeFromSVGString(notchPath(BAND_OUTER, true)),
      wedge: Skia.Path.MakeFromSVGString(sectorPath(BAND_INNER, BAND_OUTER, (16 * Math.PI) / 180)),
      topArc: Skia.Path.MakeFromSVGString(topArcPath(BAND_OUTER - 1, (26 * Math.PI) / 180)),
      bottomArc: Skia.Path.MakeFromSVGString(topArcPath(BAND_INNER + 1, (22 * Math.PI) / 180)),
    }),
    [Skia],
  );
  const origin = vec(CENTER, CENTER);
  const topPoint = vec(CENTER, CENTER - BAND_OUTER);
  const innerTop = vec(CENTER, CENTER - BAND_INNER);
  const notchTransform = useDerivedValue(() => [
    { rotate: shownPosition(wheelPosition.value) * ARC_STEP_RAD },
  ]);
  const notchLight = useDerivedValue(() => {
    const rot = shownPosition(wheelPosition.value) * ARC_STEP_RAD;
    return vec(
      CENTER + BAND_INNER * Math.cos(TOP - rot),
      CENTER + BAND_INNER * Math.sin(TOP - rot),
    );
  });
  const bloomTransform = useDerivedValue(() => [
    { scale: 1 + 0.18 * wheelDetent.value + 0.5 * wheelConfirm.value },
  ]);
  const spotOpacity = useDerivedValue(() => 0.7 + 0.3 * wheelConfirm.value);
  const flash = useDerivedValue(() =>
    Math.min(1, 0.4 * wheelDetent.value + 0.7 * wheelConfirm.value),
  );
  const size = WHEEL_EXTENT * 2;
  return (
    <Canvas style={{ position: "absolute", width: size, height: size }}>
      {/* The ring: near-black with a little depth, a darker cutout inside, hairlines on both edges. */}
      <Circle
        c={origin}
        r={(BAND_OUTER + BAND_INNER) / 2}
        style="stroke"
        strokeWidth={BAND_OUTER - BAND_INNER}
      >
        <RadialGradient
          c={origin}
          r={BAND_OUTER}
          colors={["#0E1018", "#161924", "#0A0B10"]}
          positions={[BAND_INNER / BAND_OUTER, 0.74, 1]}
        />
      </Circle>
      <Circle c={origin} r={BAND_INNER} color="rgba(0,0,0,0.3)" />
      <Circle
        c={origin}
        r={BAND_INNER + 0.5}
        style="stroke"
        strokeWidth={1}
        color="rgba(255,255,255,0.07)"
      />
      <Circle
        c={origin}
        r={BAND_OUTER}
        style="stroke"
        strokeWidth={1}
        color="rgba(255,255,255,0.08)"
      />
      {/* Spotlight: the wedge of band under the marker, lit from the outer edge inward. */}
      {paths.wedge !== null && (
        <Group opacity={spotOpacity}>
          <Path path={paths.wedge}>
            <RadialGradient
              c={topPoint}
              r={BAND_OUTER - BAND_INNER + 30}
              colors={[
                `rgba(${ACCENT_RGB},0.30)`,
                `rgba(${ACCENT_RGB},0.08)`,
                `rgba(${ACCENT_RGB},0)`,
              ]}
              positions={[0, 0.45, 1]}
            />
          </Path>
        </Group>
      )}
      {/* Bloom behind the centered entry; swells on each detent and on the lock. */}
      <Group transform={bloomTransform} origin={topPoint}>
        <Circle c={topPoint} r={150}>
          <RadialGradient
            c={topPoint}
            r={150}
            colors={[
              `rgba(${ACCENT_RGB},0.32)`,
              `rgba(${ACCENT_RGB},0.10)`,
              `rgba(${ACCENT_RGB},0)`,
            ]}
            positions={[0, 0.35, 1]}
          />
        </Circle>
      </Group>
      {/* Outer notches stay put; inner notches turn with the wheel and light up under the axis. */}
      {paths.outerNotches !== null && (
        <Path
          path={paths.outerNotches}
          style="stroke"
          strokeWidth={1.5}
          strokeCap="round"
          color="rgba(255,255,255,0.14)"
        />
      )}
      {paths.innerNotches !== null && (
        <Group transform={notchTransform} origin={origin}>
          <Path path={paths.innerNotches} style="stroke" strokeWidth={1.5} strokeCap="round">
            <RadialGradient
              c={notchLight}
              r={64}
              colors={[
                `rgba(${ACCENT_RGB},0.95)`,
                `rgba(${ACCENT_RGB},0.45)`,
                "rgba(255,255,255,0.14)",
              ]}
              positions={[0, 0.4, 1]}
            />
          </Path>
        </Group>
      )}
      {/* Lit edges under the slot: a soft haze, then the crisp line. */}
      {paths.topArc !== null && (
        <Group>
          <Path
            path={paths.topArc}
            style="stroke"
            strokeWidth={6}
            strokeCap="round"
            color={`rgba(${ACCENT_RGB},0.55)`}
          >
            <BlurMask blur={10} style="normal" />
          </Path>
          <Path
            path={paths.topArc}
            style="stroke"
            strokeWidth={2}
            strokeCap="round"
            color={`rgba(${ACCENT_RGB},0.95)`}
          />
        </Group>
      )}
      {paths.bottomArc !== null && (
        <Group>
          <Path
            path={paths.bottomArc}
            style="stroke"
            strokeWidth={5}
            strokeCap="round"
            color={`rgba(${ACCENT_RGB},0.45)`}
          >
            <BlurMask blur={8} style="normal" />
          </Path>
          <Path
            path={paths.bottomArc}
            style="stroke"
            strokeWidth={1.5}
            strokeCap="round"
            color={`rgba(${ACCENT_RGB},0.8)`}
          />
        </Group>
      )}
      {/* The two markers: a blurred copy underneath gives each its glow; a white flash on top for the tick and the lock. */}
      <Group>
        <RoundedRect
          x={CENTER - 2}
          y={CENTER - BAND_OUTER + 2}
          width={4}
          height={18}
          r={2}
          color={`rgba(${ACCENT_RGB},0.9)`}
        >
          <BlurMask blur={7} style="normal" />
        </RoundedRect>
        <RoundedRect
          x={CENTER - 1.25}
          y={CENTER - BAND_OUTER + 2}
          width={2.5}
          height={18}
          r={1.25}
          color="#DCE5FF"
        />
        <RoundedRect
          x={CENTER - 2}
          y={CENTER - BAND_INNER - 4}
          width={4}
          height={22}
          r={2}
          color={`rgba(${ACCENT_RGB},0.9)`}
        >
          <BlurMask blur={7} style="normal" />
        </RoundedRect>
        <RoundedRect
          x={CENTER - 1.25}
          y={CENTER - BAND_INNER - 4}
          width={2.5}
          height={22}
          r={1.25}
          color="#DCE5FF"
        />
      </Group>
      <Group opacity={flash}>
        <RoundedRect
          x={CENTER - 3}
          y={CENTER - BAND_OUTER}
          width={6}
          height={22}
          r={3}
          color="#FFFFFF"
        >
          <BlurMask blur={9} style="normal" />
        </RoundedRect>
        <RoundedRect
          x={CENTER - 3}
          y={CENTER - BAND_INNER - 6}
          width={6}
          height={26}
          r={3}
          color="#FFFFFF"
        >
          <BlurMask blur={9} style="normal" />
        </RoundedRect>
      </Group>
      {/* Faint pool of light around the inner marker, where the thumb is. */}
      <Circle c={innerTop} r={70}>
        <RadialGradient
          c={innerTop}
          r={70}
          colors={[`rgba(${ACCENT_RGB},0.22)`, `rgba(${ACCENT_RGB},0)`]}
        />
      </Circle>
    </Canvas>
  );
}

/** No Skia in this build: the band, edge notches, and plain markers, without the light. */
function FallbackBackdrop() {
  const notches: number[] = [];
  for (let angle = 0; angle < 2 * Math.PI - 1e-6; angle += NOTCH_STEP_RAD) notches.push(angle);
  return (
    <>
      <View style={styles.band} />
      <View style={styles.bandEdge} />
      {notches.map((angle) => (
        <View key={angle}>
          <Notch angle={angle} radius={BAND_INNER + NOTCH_LENGTH / 2} />
          <Notch angle={angle} radius={BAND_OUTER - NOTCH_LENGTH / 2} />
        </View>
      ))}
      <Marker radius={BAND_OUTER - 10} length={18} />
      <Marker radius={BAND_INNER + 8} length={22} />
    </>
  );
}

function Notch({ angle, radius }: { angle: number; radius: number }) {
  return (
    <View
      style={[
        styles.notch,
        {
          transform: [
            { translateX: radius * Math.cos(angle) },
            { translateY: radius * Math.sin(angle) },
            { rotate: `${angle + Math.PI / 2}rad` },
          ],
        },
      ]}
    />
  );
}

function Marker({ radius, length }: { radius: number; length: number }) {
  return <View style={[styles.marker, { height: length, transform: [{ translateY: -radius }] }]} />;
}

const styles = StyleSheet.create({
  dial: {
    width: WHEEL_EXTENT * 2,
    height: WHEEL_EXTENT * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  band: {
    position: "absolute",
    width: BAND_OUTER * 2,
    height: BAND_OUTER * 2,
    borderRadius: BAND_OUTER,
    borderWidth: BAND_OUTER - BAND_INNER,
    borderColor: "#111420",
  },
  bandEdge: {
    position: "absolute",
    width: BAND_OUTER * 2,
    height: BAND_OUTER * 2,
    borderRadius: BAND_OUTER,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  notch: {
    position: "absolute",
    width: 1.5,
    height: NOTCH_LENGTH,
    borderRadius: 1,
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  marker: {
    position: "absolute",
    width: 2.5,
    borderRadius: 1.5,
    backgroundColor: colors.accent,
  },
  ring: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  parent: {
    position: "absolute",
    alignItems: "center",
    gap: 2,
    transform: [{ translateY: -(BAND_INNER - 34) }],
  },
  parentLabel: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
  },
  entry: {
    position: "absolute",
    width: ITEM_WIDTH,
    alignItems: "center",
    gap: 4,
  },
  hint: {
    height: 10,
    justifyContent: "flex-end",
  },
  icon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
  iconLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    width: ICON_SIZE,
    height: ICON_SIZE,
  },
  iconLit: {
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 8,
  },
  entryLabel: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    textAlign: "center",
  },
});
