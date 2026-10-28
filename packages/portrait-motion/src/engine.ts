/**
 * The portrait animation engine (ported from ~/Eva/work/avatar-animation/playground/engine.js):
 * eleven states, each a pose (continuous channels) and parts (abstract mouth / brows / eyes /
 * gesture picks) as functions of time; blending across a state change; and `frame`, which resolves
 * one moment of a rig into paint-order layers (a part key and a matrix each) plus the accent
 * overlays (dot ring, sound waves, z z z, "?" bubble, sweat drop, confetti) in pixels. Renderers
 * only draw what a frame says.
 */
import { apply, chain, invert, rotate, scaleAbout, translate, type Affine } from "./affine";
import { centre, type Box } from "./bbox";
import { curve, eyeBoxes, morph, shapeOf, type Shape, type Track } from "./extend";
import type { Feature, Rig } from "./rig";

export const STATE_IDS = [
  "hello",
  "idle",
  "listening",
  "thinking",
  "talking",
  "working",
  "researching",
  "confused",
  "error",
  "done",
  "snoozing",
  "waking",
] as const;
export type MotionState = (typeof STATE_IDS)[number];

/** What a state's small status dot shows: the accent, orange (needs Isaac), red (failed), or none. */
export type DotTone = "accent" | "orange" | "red" | null;

export interface StateMeta {
  label: string;
  /** Plain words for a status line or an accessibility label. */
  status: string;
  dot: DotTone;
  /** Seconds one pass of the state's choreography takes (it loops or holds after). */
  dur: number;
  /** The working ring (accent dots) runs in this state. */
  ring: boolean;
}

export const BLEND = 0.4; // seconds of pose blending at a state change
const GHIDE = 1100; // gesture offset when tucked below the frame (notionists units)
const GIN = 0.3; // a state's gesture starts rising after the previous one has sunk
const TAU = Math.PI * 2;

// ---------- helpers ----------
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x));
const smooth = (x: number): number => {
  x = clamp(x);
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, w: number): number => a + (b - a) * w;
const backOut = (x: number): number => {
  x = clamp(x);
  const c = 1.6;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};
const frac = (x: number): number => x - Math.floor(x);
/** Triangle 0 → 1 → 0 over `d` seconds from `t0`. */
const pulse = (t: number, t0: number, d: number): number =>
  t < t0 || t > t0 + d ? 0 : 1 - Math.abs((2 * (t - t0)) / d - 1);
type Key = readonly [number, number];
/** Piecewise-smooth keyframes [[t, value], ...]. */
function keys(t: number, ks: readonly Key[]): number {
  let prev: Key | undefined;
  for (const k of ks) {
    if (t <= k[0])
      return prev === undefined
        ? k[1]
        : lerp(prev[1], k[1], smooth((t - prev[0]) / (k[0] - prev[0])));
    prev = k;
  }
  return prev?.[1] ?? 0;
}
/** A gesture entering from below. */
const rise = (lt: number, t0 = GIN, d = 0.6): number => GHIDE * (1 - backOut((lt - t0) / d));

// Idle blinks: every 2.3–4.3 s, sometimes a double blink; the pattern repeats every BLINK_LOOP s.
const BLINK_LOOP = 900;
const BLINKS = ((): number[] => {
  const r = rng(17);
  const out: number[] = [];
  for (let t = 1.3; t < BLINK_LOOP - 1; t += 2.3 + r() * 2) {
    out.push(t);
    if (r() < 0.18) out.push(t + 0.3);
  }
  return out;
})();
function blink(gt: number): number {
  const t = gt % BLINK_LOOP;
  for (const t0 of BLINKS) {
    if (t0 > t) break;
    if (t < t0 + 0.17) return pulse(t, t0, 0.17);
  }
  return 0;
}

// Speech: 9 fps mouth frames of abstract shapes (open / mid / closed), each rig maps them to its own
// variants. A syllable is an open shape then a mid shape; words end on a closed mouth.
type MouthClass = "open" | "mid" | "closed";
interface SpeechFrame {
  cls: MouthClass;
  i: number;
  stress: number;
}
const FPS = 9;
const REST_MOUTH: SpeechFrame = { cls: "mid", i: 2, stress: 0 };
const OPENNESS: Record<MouthClass, readonly number[]> = {
  open: [1, 1, 0.75, 0.6],
  mid: [0.6, 0.3, 0.4],
  closed: [0],
};
const SPEECH = ((): SpeechFrame[] => {
  const r = rng(42);
  const frames: SpeechFrame[] = [{ cls: "mid", i: 2, stress: 0 }];
  const pick = (cls: MouthClass, n: number): number => {
    const last = frames.at(-1);
    let i;
    do i = Math.floor(r() * n);
    while (last?.cls === cls && last.i === i);
    return i;
  };
  let word = 0;
  while (frames.length < 12 * FPS + 2) {
    const syllables = 1 + Math.floor(r() * 3);
    const stress = word % 2 === 0 ? 1 : 0;
    for (let s = 0; s < syllables; s++) {
      frames.push({ cls: "open", i: pick("open", 4), stress: s === 0 ? stress : stress * 0.6 });
      frames.push({ cls: "mid", i: pick("mid", 3), stress: stress * 0.4 });
    }
    const rest = word === 4 ? 4 : 1 + Math.floor(r() * 2); // one longer breath mid-sentence
    for (let k = 0; k < rest; k++)
      frames.push(
        k === rest - 1 ? { cls: "mid", i: 2, stress: 0 } : { cls: "closed", i: 0, stress: 0 },
      );
    word++;
  }
  return frames;
})();
function speech(lt: number): { mouth: SpeechFrame; open: number; stress: number } {
  const f = Math.floor(lt * FPS) % (SPEECH.length - 1);
  const w = lt * FPS - Math.floor(lt * FPS);
  const a = SPEECH[f] ?? REST_MOUTH;
  const b = SPEECH[f + 1] ?? REST_MOUTH;
  return {
    mouth: a,
    open: lerp(OPENNESS[a.cls][a.i] ?? 0, OPENNESS[b.cls][b.i] ?? 0, w),
    stress: lerp(a.stress, b.stress, w),
  };
}
/** The caller's voice while an assistant listens: a smooth loudness envelope for the sound-wave rings. */
const voice = (lt: number): number =>
  clamp(
    0.55 +
      0.3 * Math.sin(TAU * lt * 1.9) +
      0.25 * Math.sin(TAU * lt * 4.3 + 1) -
      (lt % 3.6 > 2.1 && lt % 3.6 < 2.6 ? 0.8 : 0),
  );

// ---------- states ----------
// Channels (notionists units; each rig scales them, k.fig for body motion, k.face for eyes/brows):
// tilt° hx hy (head) · ex ey (eye glance) · eyeS (0 open → 1 shut) eyeO (eyes widen) happy (smiling eyes) ·
// by (brows) bFar bNear (one brow) · breathe breatheP · figY figS (figure bob/stretch) · gy grot (gesture) ·
// ring spinP (accent dot ring) · waves zzz quiz conf drop lens (accent overlays) ·
// Extended mode only: bRotN bRotF (near / far brow rotation, degrees, + = inner end up) · turn (head turn)
const REST = {
  tilt: 0,
  hx: 0,
  hy: 0,
  ex: 0,
  ey: 0,
  eyeS: 0,
  eyeO: 0,
  happy: 0,
  by: 0,
  bFar: 0,
  bNear: 0,
  bRotN: 0,
  bRotF: 0,
  turn: 0,
  breathe: 1,
  breatheP: 3.4,
  figY: 0,
  figS: 0,
  gy: GHIDE,
  grot: 0,
  ring: 0,
  spinP: 1.6,
  waves: 0,
  zzz: 0,
  quiz: 0,
  conf: 0,
  drop: 0,
  lens: 0,
  blinkOn: 1,
};
export type Pose = typeof REST;
type Channel = keyof Pose;
const CHANNELS = Object.keys(REST) as Channel[];
const NOBLEND: Partial<Record<Channel, true>> = { spinP: true, breatheP: true };

type MouthPick = string | SpeechFrame;
interface Parts {
  mouth: MouthPick;
  brows: string;
  eyes: string;
  gesture: string | null;
}
interface StateDef extends StateMeta {
  pose: (lt: number, gt: number) => Partial<Pose>;
  parts: (lt: number) => Partial<Parts>;
}

const idleSway = (gt: number): Partial<Pose> => ({
  tilt: 0.8 * Math.sin((TAU * gt) / 5.3),
  hy: -3 * Math.sin((TAU * gt) / 3.4 - 0.6),
});

const STATES: Record<MotionState, StateDef> = {
  hello: {
    label: "Hello",
    status: "Online",
    dot: "accent",
    dur: 3.6,
    ring: false,
    pose: (lt, gt) => ({
      ...idleSway(gt),
      tilt: 2.5 + 0.8 * Math.sin((TAU * lt) / 1.8),
      hy: -6 * pulse(lt, 0.5, 0.5) - 6 * pulse(lt, 1.6, 0.5),
      by: -10 * smooth(lt / 0.4),
      bRotN: 5,
      bRotF: 5,
      gy: rise(lt, 0.05, 0.55),
      grot:
        (-4 + 8 * Math.sin(TAU * (lt - 0.35) * 2.1)) *
        smooth((lt - 0.35) / 0.3) *
        (1 - smooth((lt - 2.9) / 0.5)),
    }),
    parts: (lt) => ({
      mouth: (lt > 0.45 && lt < 0.85) || (lt > 1.55 && lt < 1.95) ? "hi" : "rest",
      brows: "up",
      gesture: "wave",
    }),
  },
  idle: {
    label: "Idle",
    status: "Idle",
    dot: null,
    dur: 3.6,
    ring: false,
    pose: (_lt, gt) => idleSway(gt),
    parts: () => ({}),
  },
  listening: {
    label: "Listening",
    status: "Listening",
    dot: "accent",
    dur: 3.6,
    ring: false,
    pose: (lt, gt) => ({
      tilt: -5 + 0.5 * Math.sin((TAU * gt) / 4.1),
      hx: -6,
      hy:
        -3 * Math.sin((TAU * gt) / 3.4) +
        7 * pulse(lt % 3.6, 1.4, 0.35) +
        7 * pulse(lt % 3.6, 2.9, 0.35),
      ex: -5,
      by: -8,
      bRotN: 8,
      bRotF: 8,
      turn: -2,
      waves: smooth(lt / 0.5),
    }),
    parts: () => ({ mouth: "listen", brows: "listen" }),
  },
  thinking: {
    label: "Thinking",
    status: "Thinking",
    dot: "accent",
    dur: 3.6,
    ring: true,
    pose: (lt, gt) => {
      const u = lt % 3.6; // the glance repeats while a state is held
      const ex = keys(u, [
        [0, 0],
        [0.45, -16],
        [1.5, -16],
        [1.9, 14],
        [2.8, 14],
        [3.3, 2],
      ]);
      const ey = keys(u, [
        [0, 0],
        [0.45, -10],
        [1.5, -10],
        [1.9, -9],
        [2.8, -9],
        [3.3, -5],
      ]);
      return {
        ex,
        ey,
        tilt: -0.17 * ex + 0.3 * Math.sin((TAU * gt) / 5.3),
        hx: 0.35 * ex,
        by: -4,
        bRotN: -6 * smooth((lt - 0.1) / 0.3),
        bRotF: 12 * smooth((lt - 0.1) / 0.3),
        gy: rise(lt) - 8 * Math.sin(TAU * lt * 0.7),
        ring: smooth(lt / 0.5),
        spinP: 1.6,
      };
    },
    parts: (lt) => ({
      mouth: lt < 0.2 ? "rest" : lt % 3.6 < 2.3 ? "hmm" : "think2",
      brows: lt < 0.15 ? "rest" : "think",
      gesture: "point",
    }),
  },
  talking: {
    label: "Talking",
    status: "Replying",
    dot: "accent",
    dur: 3.6,
    ring: false,
    pose: (lt, gt) => {
      const s = speech(lt);
      return {
        tilt: 2.2 * Math.sin((TAU * lt) / 2.4 + 0.4) + 0.5,
        hy: -3 * Math.sin((TAU * gt) / 3.4 - 0.6) - 9 * s.open,
        by: -14 * smooth(s.stress),
        bRotN: 9 * smooth(s.stress),
        bRotF: 9 * smooth(s.stress),
        turn: 1.6 * Math.sin((TAU * lt) / 3.1),
      };
    },
    parts: (lt) => ({ mouth: speech(lt).mouth }),
  },
  working: {
    label: "Working",
    status: "Working",
    dot: "accent",
    dur: 3.6,
    ring: true,
    pose: (lt) => ({
      tilt: 2.5,
      hx: 4,
      hy: 8 + 4 * Math.abs(Math.sin(TAU * lt * 1.6)),
      ex: 10,
      ey: 14,
      by: 6,
      bRotN: -14,
      bRotF: -14,
      blinkOn: 0.6,
      gy: rise(lt) - 6 * Math.abs(Math.sin(TAU * lt * 3.2)),
      ring: smooth(lt / 0.4),
      spinP: 0.9,
    }),
    parts: () => ({ mouth: "focus", brows: "focus", gesture: "phone" }),
  },
  researching: {
    label: "Researching",
    status: "Researching",
    dot: "accent",
    dur: 2.4,
    ring: true,
    // Reading: the eyes sweep a line left to right and flick back, leaning in over a page, a small
    // magnifier following the gaze.
    pose: (lt, gt) => {
      const u = lt % 2.4;
      const ex = keys(u, [
        [0, -14],
        [1.7, 14],
        [1.95, -14],
        [2.4, -14],
      ]);
      const lean = smooth(lt / 0.5);
      return {
        ex,
        ey:
          9 +
          2 *
            keys(u, [
              [0, 0],
              [1.7, 1],
              [1.95, 0],
            ]),
        tilt: -2 * lean + 0.3 * Math.sin((TAU * gt) / 5.3),
        hx: 0.2 * ex + 3 * lean,
        hy: 7 * lean,
        bRotN: -6 * lean,
        bRotF: -6 * lean,
        figY: -3 * lean,
        figS: 0.01 * lean,
        by: 4,
        blinkOn: 0.7,
        ring: smooth(lt / 0.5),
        spinP: 2.4,
        lens: lean,
      };
    },
    parts: () => ({ mouth: "focus", brows: "focus" }),
  },
  confused: {
    label: "Confused",
    status: "Needs you",
    dot: "orange",
    dur: 3.6,
    ring: false,
    pose: (lt, gt) => ({
      tilt: -4 + 0.6 * Math.sin((TAU * gt) / 3),
      hx: -4,
      hy: -3 * Math.sin((TAU * gt) / 3.4),
      ex: keys(lt, [
        [0, 0],
        [0.5, 8],
        [2.0, 8],
        [2.4, -6],
      ]),
      ey: -6,
      bFar: -10 * smooth((lt - 0.15) / 0.4),
      bNear: -34 * backOut((lt - 0.15) / 0.45) + 8 * pulse(lt, 2.2, 0.4),
      bRotN: 10 * smooth((lt - 0.15) / 0.4),
      bRotF: -16 * smooth((lt - 0.15) / 0.4),
      quiz: smooth((lt - 0.35) / 0.25),
    }),
    parts: () => ({ mouth: "hmm", brows: "confused" }),
  },
  error: {
    label: "Error",
    status: "Something went wrong",
    dot: "red",
    dur: 3.6,
    ring: false,
    pose: (lt) => {
      const s = smooth(lt / 0.6);
      return {
        tilt: 3.5 * s,
        hy: 16 * s,
        figY: 12 * s,
        figS: -0.015 * s,
        ey: 9 * s,
        ex: -4 * s,
        by: 4 * s,
        bRotN: 18 * s,
        bRotF: 18 * s,
        breathe: 0.6,
        breatheP: 4.2,
        drop: smooth((lt - 0.7) / 0.3),
      };
    },
    parts: () => ({ mouth: "frown", brows: "worried" }),
  },
  done: {
    label: "Done",
    status: "Done",
    dot: "accent",
    dur: 3.6,
    ring: false,
    pose: (lt) => ({
      tilt: 1.5 * Math.sin(TAU * lt * 1.1),
      hy: -4,
      by: -22,
      bRotN: 6,
      bRotF: 6,
      happy: 1,
      figY: -34 * Math.abs(Math.sin(TAU * lt * 1.15)) * (1 - smooth((lt - 2.6) / 0.6)),
      gy: rise(lt, 0.05, 0.45) + 18 * Math.sin(TAU * lt * 2.3),
      conf: 1,
    }),
    parts: (lt) => ({ mouth: lt < 2.2 ? "smile" : "grin", brows: "up", gesture: "both" }),
  },
  snoozing: {
    label: "Snoozing",
    status: "Away",
    dot: null,
    dur: 4.2,
    ring: false,
    pose: (lt) => {
      const s = smooth(lt / 0.8);
      return {
        tilt: 7 * s + 0.6 * Math.sin((TAU * lt) / 4.2),
        hx: 6 * s,
        hy: 22 * s,
        eyeS: 0.9 * s,
        ey: 5 * s,
        by: 10 * s,
        bRotN: -4 * s,
        bRotF: -4 * s,
        breathe: 2.2,
        breatheP: 4.2,
        blinkOn: 0,
        zzz: smooth((lt - 0.6) / 0.6),
      };
    },
    parts: () => ({ mouth: "sleep", brows: "sleep" }),
  },
  waking: {
    label: "Waking",
    status: "Waking up",
    dot: "accent",
    dur: 4.2,
    ring: false,
    pose: (lt, gt) => {
      const stretch = keys(lt, [
        [0.3, 0],
        [1.0, 1],
        [1.7, 1],
        [2.1, 0],
      ]);
      const shut =
        keys(lt, [
          [0, 0.9],
          [1.9, 0.95],
          [2.15, 0],
        ]) +
        pulse(lt, 2.35, 0.18) +
        pulse(lt, 2.65, 0.18);
      return {
        tilt: keys(lt, [
          [0, 7],
          [0.9, -3],
          [1.8, -3],
          [2.3, 0],
        ]),
        hx: keys(lt, [
          [0, 6],
          [0.9, 0],
        ]),
        hy:
          keys(lt, [
            [0, 22],
            [0.9, -10],
            [1.8, -10],
            [2.3, 0],
          ]) -
          3 * Math.sin((TAU * gt) / 3.4),
        eyeS: clamp(shut),
        eyeO: pulse(lt, 2.9, 0.9),
        by: keys(lt, [
          [0, 10],
          [0.8, -6],
          [2.2, -4],
          [2.9, -18],
          [3.6, 0],
        ]),
        figS: 0.03 * stretch,
        breathe: 0.5,
        blinkOn: 0,
        gy: lt < 1.9 ? GHIDE * (1 - backOut((lt - 0.3) / 0.7)) : GHIDE * smooth((lt - 1.9) / 0.4),
        grot: -3 * stretch * Math.sin(TAU * lt * 0.8),
        zzz: 1 - smooth(lt / 0.5),
      };
    },
    parts: (lt) => ({
      mouth: lt > 0.5 && lt < 1.8 ? "yawn" : lt < 0.5 ? "sleep" : "rest",
      brows: lt < 0.4 ? "sleep" : "rest",
      eyes: lt > 2.8 && lt < 3.6 ? "wide" : "rest",
      gesture: lt < 2.4 ? "both" : null,
    }),
  },
};

/** Each state's label, status words, dot, choreography length and whether the working ring runs. */
export const STATE_META: Record<MotionState, StateMeta> = Object.fromEntries(
  STATE_IDS.map((id) => {
    const { label, status, dot, dur, ring } = STATES[id];
    return [id, { label, status, dot, dur, ring }];
  }),
) as Record<MotionState, StateMeta>;

const DEFAULT_PARTS: Parts = { mouth: "rest", brows: "rest", eyes: "rest", gesture: null };
const poseOf = (st: StateDef, lt: number, gt: number): Pose => ({ ...REST, ...st.pose(lt, gt) });
const partsOf = (st: StateDef, lt: number): Parts => ({ ...DEFAULT_PARTS, ...st.parts(lt) });

/** Where a portrait's timeline stands: the state, when it began, and the one it is blending from. */
export interface Clip {
  state: MotionState;
  /** Seconds since the state began. */
  lt: number;
  /** Seconds on the portrait's own clock (breathing, blinks, spins). */
  gt: number;
  prev: MotionState | null;
  /** How long `prev` ran before this state began. */
  prevDur: number;
}

/** Resolve a clip into its blended pose and abstract parts. */
export function resolve(clip: Clip): { pose: Pose; parts: Parts } {
  const st = STATES[clip.state];
  const { lt, gt } = clip;
  const pose = poseOf(st, lt, gt);
  let parts = partsOf(st, lt);
  const prev = clip.prev === null ? null : STATES[clip.prev];
  if (prev !== null && lt < BLEND) {
    const q = poseOf(prev, clip.prevDur + lt, gt);
    const w = smooth(lt / BLEND);
    for (const k of CHANNELS) {
      if (NOBLEND[k] !== true) pose[k] = lerp(q[k], pose[k], w);
      else if (w < 0.5) pose[k] = q[k];
    }
  }
  // The previous gesture sinks out before this state's own rises in.
  if (prev !== null && lt < GIN) {
    const pd = partsOf(prev, clip.prevDur + lt);
    if (pd.gesture !== null && pd.gesture !== parts.gesture) {
      const q = poseOf(prev, clip.prevDur, gt);
      parts = { ...parts, gesture: pd.gesture };
      pose.gy = lerp(q.gy, GHIDE, smooth(lt / GIN));
      pose.grot = q.grot;
    }
  }
  pose.eyeS = Math.max(pose.eyeS, blink(gt) * pose.blinkOn);
  return { pose, parts };
}

// ---------- frames ----------

/** A shape drawn this frame only (a mouth between two others, an eyelid), in rig part space. */
export interface DrawPath {
  d: string;
  fill: string | null;
  stroke: string | null;
  /** Stroke width; strokes have round caps and joins. */
  width: number;
  opacity: number;
  /** Fill with the even-odd rule (a mouth's teeth cut out of it). */
  evenOdd: boolean;
}

/**
 * One layer to paint: the rig part (`Rig.parts` key) under matrix `m`, both in rig units. Extended
 * mode adds shapes made for this frame, in the part's space under the same matrix:
 * - `morph`: a mouth between two others, drawn instead of the part (which names the mouth it is becoming);
 * - `clip` and `lids`: the part clipped to `clip` (closing eyelids), then the lids' edges over it.
 */
export interface FrameLayer {
  part: string;
  m: Affine;
  morph?: DrawPath[];
  clip?: Box[];
  lids?: DrawPath[];
}

export interface Confetto {
  x: number;
  y: number;
  /** Degrees. */
  rot: number;
  o: number;
  w: number;
  h: number;
  /** 0 accent, 1 soft, 2 deep. */
  tone: 0 | 1 | 2;
}

/** Accent overlays in pixels from the disc's top-left (overlays reach past the disc: see `FX_REACH`). */
export interface Overlays {
  /** Opacity of each working-ring dot (`geometry(size).dots`). */
  dots: number[];
  /** Sound-wave rings: radius from the disc centre and opacity. */
  waves: { r: number; o: number }[];
  zs: { x: number; y: number; size: number; o: number }[];
  quiz: { o: number; x: number; y: number; scale: number; rot: number };
  drop: { o: number; x: number; y: number };
  /** The researching magnifier's centre. */
  lens: { o: number; x: number; y: number };
  confetti: Confetto[];
}

export interface Frame {
  state: MotionState;
  layers: FrameLayer[];
  fx: Overlays;
}

/** How far past the disc (as a fraction of its size) a frame's overlays can reach on each side. */
export const FX_REACH = 0.35;

export interface Geometry {
  /** Working-ring dots: centres in px from the disc's top-left, and their radius. */
  dots: [number, number][];
  dotR: number;
  stroke: number;
  quizR: number;
  quizFont: number;
  /** The "?" bubble's tail, in the bubble's own space (its centre at 0 0). */
  quizTail: string;
  /** Covers the tail's join with the bubble. */
  quizPatch: { x: number; y: number; w: number; h: number };
  /** The sweat drop, in its own space. */
  drop: string;
  dropStroke: number;
  lensR: number;
  lensStroke: number;
  /** The magnifier's handle, in its own space (the lens centre at 0 0). */
  lensHandle: string;
}

const geometries = new Map<number, Geometry>();

/** Pixel geometry of the overlays at `size`, memoized per size. */
export function geometry(size: number): Geometry {
  let g = geometries.get(size);
  if (g !== undefined) return g;
  const pad = Math.max(6, Math.round(size * 0.07));
  const n = size < 64 ? 10 : size < 128 ? 14 : 20;
  const R = size / 2 + pad * 0.5;
  const s = (k: number): string => (size * k).toFixed(2);
  g = {
    dots: Array.from({ length: n }, (_, i) => {
      const a = (i / n) * TAU - Math.PI / 2;
      return [size / 2 + R * Math.cos(a), size / 2 + R * Math.sin(a)];
    }),
    dotR: Math.max(1.5, size * 0.014),
    stroke: Math.max(1.2, size * 0.012),
    quizR: size * 0.13,
    quizFont: size * 0.18,
    quizTail: `M ${s(-0.05)} ${s(0.1)} L ${s(-0.11)} ${s(0.17)} L ${s(0.01)} ${s(0.115)} Z`,
    quizPatch: { x: -size * 0.06, y: size * 0.085, w: size * 0.06, h: size * 0.04 },
    drop: `M 0 ${s(-0.035)} C ${s(0.02)} ${s(-0.005)} ${s(0.026)} ${s(0.008)} ${s(0.026)} ${s(0.02)} A ${s(0.026)} ${s(0.026)} 0 0 1 ${s(-0.026)} ${s(0.02)} C ${s(-0.026)} ${s(0.008)} ${s(-0.02)} ${s(-0.005)} 0 ${s(-0.035)} Z`,
    dropStroke: Math.max(0.8, size * 0.006),
    lensR: size * 0.075,
    lensStroke: Math.max(1.2, size * 0.016),
    lensHandle: `M ${s(0.053)} ${s(0.053)} L ${s(0.11)} ${s(0.11)}`,
  };
  geometries.set(size, g);
  return g;
}

const CONFETTI = ((): {
  a: number;
  v: number;
  spin: number;
  burst: number;
  tone: 0 | 1 | 2;
  w: number;
}[] => {
  const r = rng(7);
  return Array.from({ length: 16 }, (_, i) => ({
    a: -Math.PI / 2 + (r() - 0.5) * 1.9,
    v: 0.6 + r() * 0.5,
    spin: (r() - 0.5) * 14,
    burst: i % 2,
    tone: (i % 3) as 0 | 1 | 2,
    w: 0.035 + r() * 0.02,
  }));
})();

/** Working-ring dot opacities for a ring `on` (0–1) at spin phase `spin` radians; `sharp` narrows the bright arc. */
export function ringOpacities(n: number, on: number, spin: number, sharp: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const w = Math.pow(Math.max(0, Math.cos((i / n) * TAU - spin)), sharp);
    return on * (sharp > 3 ? 0.15 + 0.85 * w : 0.3 + 0.7 * w);
  });
}

/** Concrete rig parts for abstract picks. */
function concrete(
  rig: Rig,
  d: Parts,
  p: Pose,
): { mouth: string; flip: boolean; brows: string; eyes: string; gesture: string | null } {
  const e = rig.expr;
  const m = typeof d.mouth === "string" ? e.mouth[d.mouth] : e.mouth[d.mouth.cls];
  const mouth = Array.isArray(m)
    ? ((m[(typeof d.mouth === "string" ? 0 : d.mouth.i) % m.length] as string | undefined) ?? "")
    : typeof m === "string"
      ? m
      : String(e.mouth["rest"]);
  const happy = e.eyes["happy"];
  const eyes =
    p.happy > 0.5 && typeof happy === "string" ? happy : (e.eyes[d.eyes] ?? e.eyes["rest"] ?? "");
  return {
    mouth,
    flip: d.mouth === "frown" && e.frownFlip,
    brows: e.brows[d.brows] ?? e.brows["rest"] ?? "",
    eyes,
    gesture: d.gesture === null ? null : (e.gesture[d.gesture] ?? null),
  };
}

/**
 * Extended mode's memory for one drawn portrait: the mouth it shows and the morph into it. Make one
 * per portrait instance (`extension()`) and pass it to every `frame` of that instance.
 */
export interface Extension {
  mouth: string | null;
  start: number;
  tracks: Track[] | null;
}

/** A fresh Extended-mode memory for one portrait instance. */
export const extension = (): Extension => ({ mouth: null, start: 0, tracks: null });

/** Seconds a mouth takes to morph into the next. */
const MORPH = 0.22;

interface Measures {
  shapes: Map<string, Shape>;
  eyes: Map<string, Box[]>;
  centres: Map<string, [number, number] | null>;
}
const measured = new WeakMap<Rig, Measures>();

function measuresOf(rig: Rig): Measures {
  let m = measured.get(rig);
  if (m === undefined) {
    m = { shapes: new Map(), eyes: new Map(), centres: new Map() };
    measured.set(rig, m);
  }
  return m;
}

function shapeFor(rig: Rig, key: string): Shape {
  const m = measuresOf(rig);
  let shape = m.shapes.get(key);
  if (shape === undefined) {
    shape = shapeOf(rig.inner[key] ?? "");
    m.shapes.set(key, shape);
  }
  return shape;
}

function eyesFor(rig: Rig, key: string): Box[] {
  const m = measuresOf(rig);
  let boxes = m.eyes.get(key);
  if (boxes === undefined) {
    boxes = eyeBoxes(rig.inner[key] ?? "");
    m.eyes.set(key, boxes);
  }
  return boxes;
}

function centreFor(rig: Rig, key: string): [number, number] | null {
  const m = measuresOf(rig);
  let c = m.centres.get(key);
  if (c === undefined) {
    const art = rig.inner[key];
    c = art === undefined || art === "" ? null : centre(art);
    m.centres.set(key, c);
  }
  return c;
}

/** The in-between of a mouth morph at weight `w`, fills of one colour merged so teeth cut out. */
function morphPaths(tracks: Track[], w: number, t: Affine): DrawPath[] {
  const fills = new Map<string, DrawPath>();
  const out: DrawPath[] = [];
  for (const tr of tracks) {
    const buf = new Float64Array(tr.a.length);
    for (let i = 0; i < buf.length; i += 2) {
      const [x, y] = apply(
        t,
        (tr.a[i] ?? 0) + ((tr.b[i] ?? 0) - (tr.a[i] ?? 0)) * w,
        (tr.a[i + 1] ?? 0) + ((tr.b[i + 1] ?? 0) - (tr.a[i + 1] ?? 0)) * w,
      );
      buf[i] = x;
      buf[i + 1] = y;
    }
    const d = curve(buf, tr.closed);
    if (tr.fill !== null) {
      const same = fills.get(tr.fill);
      if (same !== undefined) same.d += d;
      else {
        const p: DrawPath = { d, fill: tr.fill, stroke: null, width: 0, opacity: 1, evenOdd: true };
        fills.set(tr.fill, p);
        out.push(p);
      }
    } else
      out.push({
        d,
        fill: null,
        stroke: tr.stroke,
        width: tr.width,
        opacity: tr.fade === 0 ? 1 : tr.fade < 0 ? 1 - w : w,
        evenOdd: false,
      });
  }
  return out;
}

/** Map a box through `t` (a translate / scale, as DiceBear's layer transforms are). */
function mapBox(t: Affine, b: Box): Box {
  const [x0, y0] = apply(t, b.x0, b.y0);
  const [x1, y1] = apply(t, b.x1, b.y1);
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

/**
 * One moment of `rig` on `clip`, for a disc `size` px across. With `ext` (Extended mode, the
 * playground's): mouths morph into each other, eyelids close over the eyes instead of squashing
 * them, each brow rotates about its own centre, and the face turns a little with the gaze.
 */
export function frame(rig: Rig, clip: Clip, size: number, ext?: Extension): Frame {
  const { pose: p, parts } = resolve(clip);
  const { gt } = clip;
  const kf = rig.k.fig;
  const kc = rig.k.face;
  const d = concrete(rig, parts, p);
  if (ext !== undefined) {
    // Brows keep their own shape and rotate instead of swapping; no mouth is flipped.
    d.brows = rig.expr.brows["rest"] ?? d.brows;
    d.flip = false;
  }
  const [bx, by0] = rig.pivots.base;
  const [nx, ny] = rig.pivots.neck;
  const breath = Math.sin((TAU * gt) / p.breatheP) * p.breathe;
  const s = 1 + 0.006 * (breath + p.breathe);
  const fig = chain(translate(0, (-5 * breath + p.figY) * kf), scaleAbout(s, s + p.figS, bx, by0));
  const head = chain(fig, translate(p.hx * kf, p.hy * kf), rotate(p.tilt, nx, ny));
  const shut = clamp(Math.max(p.eyeS, p.happy * rig.expr.happySquash));
  const [ecx, ecy] = rig.eyeC;
  // Head turn (Extended): face features slide sideways, the nose a little further, and narrow slightly.
  const turn = ext === undefined ? 0 : p.turn + 0.22 * p.ex;
  const feat = (f: Feature | undefined): Affine =>
    f === undefined || turn === 0
      ? head
      : chain(
          head,
          translate(turn * 5 * kc * (f === "nose" ? 1.5 : 1), 0),
          scaleAbout(1 - 0.012 * Math.abs(turn), 1, ecx, 0),
        );
  const face = feat("face");
  const eyes =
    ext === undefined
      ? chain(
          face,
          translate(p.ex * kc, (p.ey + 3 * shut) * kc),
          scaleAbout(
            1 + 0.08 * shut + 0.1 * p.eyeO,
            (1 - 0.92 * shut) * (1 + 0.35 * p.eyeO),
            ecx,
            ecy,
          ),
        )
      : chain(
          face,
          translate(p.ex * kc, p.ey * kc),
          scaleAbout(1 + 0.1 * p.eyeO, 1 + 0.35 * p.eyeO, ecx, ecy),
        );
  const brows = chain(
    face,
    translate(p.ex * 0.35 * kc, (p.by + (ext === undefined ? 20 : 6) * shut + p.ey * 0.4) * kc),
  );
  const [wx, wy] = rig.pivots.wave;
  const gest = chain(fig, translate(0, p.gy), rotate(p.grot, wx, wy));
  // The resting gesture sinks exactly as far as a state's gesture has risen, and comes back as it sinks.
  const restGest = chain(fig, translate(0, d.gesture !== null ? clamp(GHIDE - p.gy, 0, GHIDE) : 0));

  const layers: FrameLayer[] = [];
  for (const l of rig.layers) {
    switch (l.role) {
      case "body":
        if (l.part !== undefined) layers.push({ part: l.part, m: fig });
        break;
      case "head":
        if (l.part !== undefined) layers.push({ part: l.part, m: feat(l.feature) });
        break;
      case "restGesture":
        if (l.part !== undefined) layers.push({ part: l.part, m: restGest });
        break;
      case "mouth": {
        const key = `mouth:${d.mouth}`;
        if (ext !== undefined) {
          if (ext.mouth !== key) {
            ext.tracks =
              ext.mouth === null ? null : morph(shapeFor(rig, ext.mouth), shapeFor(rig, key));
            ext.mouth = key;
            ext.start = gt;
          }
          if (gt < ext.start) ext.start = gt - MORPH; // the clock went back: show the target
          const w = smooth((gt - ext.start) / MORPH);
          if (ext.tracks !== null && w < 1) {
            layers.push({ part: key, m: face, morph: morphPaths(ext.tracks, w, l.t) });
            break;
          }
        }
        let m = face;
        if (d.flip) {
          // Turned upside down about its own centre, inside the layer's transform.
          const cy = rig.mouthY[d.mouth] ?? 0;
          const flip = chain(translate(0, cy + 6 * kc), [1, 0, 0, -1, 0, 0], translate(0, -cy));
          m = chain(face, l.t, flip, invert(l.t));
        }
        layers.push({ part: key, m });
        break;
      }
      case "eyes": {
        const key = `eyes:${d.eyes}`;
        const c = clamp(shut / 0.9);
        if (ext === undefined || c <= 0) {
          layers.push({ part: key, m: eyes });
          break;
        }
        // Eyelids: per eye, a clip closing from the top (and a little from the bottom) onto a line
        // 62% down the eye, and the lid's edge as a curve that bows down as it closes.
        const lw = rig.style === "micah" ? 4 : 12;
        const clipBoxes: Box[] = [];
        const lids: DrawPath[] = [];
        for (const b of eyesFor(rig, key)) {
          const h = b.y1 - b.y0;
          const meet = b.y0 + h * 0.62;
          const up = lerp(b.y0 - lw, meet, c);
          const lo = Math.max(up, lerp(b.y1 + lw, meet, c));
          clipBoxes.push(mapBox(l.t, { x0: b.x0 - lw, y0: up, x1: b.x1 + lw, y1: lo }));
          const y = lerp(b.y0, meet, c);
          const bow = h * 0.3 * c + lw * 0.3 * c;
          const [ax, ay] = apply(l.t, b.x0 - lw * 0.3, y);
          const [qx, qy] = apply(l.t, (b.x0 + b.x1) / 2, y + 2 * bow);
          const [zx, zy] = apply(l.t, b.x1 + lw * 0.3, y);
          lids.push({
            d: `M${f2(ax)} ${f2(ay)}Q${f2(qx)} ${f2(qy)} ${f2(zx)} ${f2(zy)}`,
            fill: null,
            stroke: "#000",
            width: lw,
            opacity: clamp(c * 4),
            evenOdd: false,
          });
        }
        layers.push({ part: key, m: eyes, clip: clipBoxes, lids });
        break;
      }
      case "brows": {
        const inv = invert(l.t);
        const near = `near:${d.brows}`;
        const far = `far:${d.brows}`;
        const hasFar = rig.parts[far] !== undefined;
        const rot = (key: string, deg: number): Affine => {
          const c = ext === undefined || deg === 0 ? null : centreFor(rig, key);
          return c === null ? [1, 0, 0, 1, 0, 0] : rotate(deg, c[0], c[1]);
        };
        // + raises a brow's inner end: the near brow's right, the far brow's left.
        layers.push({
          part: near,
          m: chain(
            brows,
            l.t,
            translate(0, p.bNear * kc),
            rot(near, -(hasFar ? p.bRotN : p.bRotN * 0.3)),
            inv,
          ),
        });
        if (hasFar)
          layers.push({
            part: far,
            m: chain(brows, l.t, translate(0, -p.bFar * kc), rot(far, p.bRotF), inv),
          });
        break;
      }
      case "gesture":
        if (d.gesture !== null) layers.push({ part: `gesture:${d.gesture}`, m: gest });
        break;
    }
  }
  return { state: clip.state, layers, fx: overlays(p, clip, size) };
}

const f2 = (v: number): string => (Math.round(v * 100) / 100).toString();

function overlays(p: Pose, clip: Clip, size: number): Overlays {
  const { gt, lt } = clip;
  const c = size / 2;
  const sharp = p.spinP < 1.2 ? 8 : 3;
  const dots = ringOpacities(geometry(size).dots.length, p.ring, (gt * TAU) / p.spinP, sharp);
  const loud = clip.state === "listening" ? voice(lt) : 0.6;
  const waves = [0, 1, 2].map((i) => {
    const f = frac(gt / 1.5 + i / 3);
    return { r: c + size * 0.025 + f * size * 0.1, o: p.waves * (1 - f) * (0.25 + 0.75 * loud) };
  });
  const zs = [0, 1, 2].map((i) => {
    const f = frac(gt / 2.6 + i / 3);
    return {
      x: size * (0.74 + 0.2 * f + 0.03 * Math.sin(TAU * f * 1.5)),
      y: size * (0.2 - 0.36 * f),
      size: size * (0.09 + 0.09 * f),
      o: p.zzz * Math.sin(Math.PI * f),
    };
  });
  const df = frac(Math.max(0, gt) / 1.8);
  const ct = clip.state === "done" ? lt : 99;
  const confetti: Confetto[] = [];
  if (p.conf > 0)
    for (const k of CONFETTI) {
      const t = ct - (k.burst ? 1.75 : 0.25);
      const life = 1.3;
      if (t < 0 || t > life) continue;
      const v = size * k.v;
      confetti.push({
        x: c + Math.cos(k.a) * v * t,
        y: size * 0.16 + Math.sin(k.a) * v * t + 0.5 * size * 1.8 * t * t,
        rot: k.spin * t * 57,
        o: p.conf * (1 - smooth((t - life * 0.6) / (life * 0.4))),
        w: size * k.w,
        h: size * 0.024,
        tone: k.tone,
      });
    }
  return {
    dots,
    waves,
    zs,
    quiz: {
      o: clamp(p.quiz * 1.5),
      x: size * 0.88,
      y: size * 0.1,
      scale: backOut(p.quiz),
      rot: 8 * Math.sin(TAU * gt * 0.9) * p.quiz,
    },
    drop: {
      o: p.drop * clamp(Math.sin(Math.PI * df) * 1.6),
      x: size * 0.3,
      y: size * (0.27 + 0.09 * df),
    },
    lens: { o: p.lens, x: size * (0.8 + (0.05 * p.ex) / 14), y: size * 0.8 },
    confetti,
  };
}
