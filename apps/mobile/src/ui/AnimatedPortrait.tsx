/**
 * An assistant's portrait, alive: `@relay/portrait-motion` picks its state from the thread's
 * signals (`state/motion` `useMotionSignals`) and poses its DiceBear rig per frame; this draws
 * those frames with Skia. Each tick (24 fps, on the JS thread) records one `SkPicture` (the paper
 * disc, the rig's parts as `ImageSVG`s under the frame's matrices, then the accent overlays: dot
 * ring, magnifier, z z z, and the engine's other overlays) into a shared value that the canvas
 * draws on the UI thread, so React renders nothing per frame. The canvas is larger than the disc
 * by `FX_REACH` each side, laid over it and deaf to touches.
 *
 * It ticks only while seen (`useAnimationActive`: screen focused, app in the foreground, not
 * `paused`). With Reduce Motion it is the still portrait, plus a still dot ring while the agent
 * works. The rig is built after the first paint (the still portrait shows until then), and builds
 * without Skia keep the still one.
 */
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useReducedMotion, useSharedValue } from "react-native-reanimated";
import type { SkCanvas, SkFont, SkPaint, SkPath, SkPicture, SkSVG } from "@shopify/react-native-skia";
import {
  Director,
  FX_REACH,
  Timeline,
  buildRig,
  frame,
  geometry,
  partSvg,
  type Frame,
  type MotionSignals,
  type MotionState,
  type Rig,
} from "@relay/portrait-motion";
import type { AssistantPortrait } from "@relay/protocol";
import { loadSkia, type SkiaModule } from "@/dictation/skia";
import { mixHex, palettes, useColors } from "@/theme";
import { Portrait } from "./Portrait";
import { WorkingRing } from "./WorkingRing";
import { useAnimationActive } from "./useAnimationActive";

/** Frames per second while animating: smooth enough for these motions, half the JS work of 48. */
const FPS = 24;
/** The rig is built this long after mount: past a pushed screen's entrance. */
const RIG_DELAY_MS = 350;
// The line art is black, so a portrait without its own paper sits on the light palette's raised surface in both schemes.
const PAPER = palettes.light.surfaceRaised;
const BUBBLE = "#ffffff";

export interface AnimatedPortraitProps {
  /** Who it is: the accessibility label. */
  name: string;
  portrait: AssistantPortrait;
  size: number;
  /** What the thread is doing (`useMotionSignals`). */
  signals: MotionSignals;
  /** Hold still: it is covered (the call screen over the thread). */
  paused?: boolean;
  /** The state it moved to, for a status line or an accessibility label. */
  onState?: (state: MotionState) => void;
}

interface LoadedRig {
  rig: Rig;
  /** One parsed SVG per part key. */
  svgs: Map<string, SkSVG>;
}

/** Parsed parts per rig: a rig is memoized per portrait, so each part is parsed once per app run. */
const parsed = new WeakMap<Rig, Map<string, SkSVG>>();

function loadRig(sk: SkiaModule, portrait: AssistantPortrait): LoadedRig {
  const rig = buildRig(portrait);
  let svgs = parsed.get(rig);
  if (svgs === undefined) {
    svgs = new Map();
    for (const key of Object.keys(rig.parts)) {
      const svg = sk.Skia.SVG.MakeFromString(partSvg(rig, key));
      if (svg !== null) svgs.set(key, svg);
    }
    parsed.set(rig, svgs);
  }
  return { rig, svgs };
}

export function AnimatedPortrait({ name, portrait, size, signals, paused = false, onState }: AnimatedPortraitProps) {
  const sk = loadSkia();
  const colors = useColors();
  const reduced = useReducedMotion();
  const active = useAnimationActive(paused);
  const [loaded, setLoaded] = useState<LoadedRig | null>(null);
  const accent = portrait.colors?.accent ?? colors.accent;

  useEffect(() => {
    if (sk === null || reduced) return;
    // After the screen's first paint and its push transition, so opening a thread never waits on the rig.
    const timer = setTimeout(() => {
      setLoaded(loadRig(sk, portrait));
    }, RIG_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [sk, portrait, reduced]);

  if (sk === null || reduced || loaded === null) {
    return (
      <View style={{ width: size, height: size }}>
        <Portrait name={name} portrait={portrait} size={size} />
        {signals.running && <WorkingRing size={size} color={accent} spinning={false} />}
      </View>
    );
  }
  return (
    <MotionCanvas
      sk={sk}
      loaded={loaded}
      name={name}
      paper={portrait.colors?.paper ?? PAPER}
      accent={accent}
      size={size}
      signals={signals}
      active={active}
      onState={onState}
    />
  );
}

interface MotionCanvasProps {
  sk: SkiaModule;
  loaded: LoadedRig;
  name: string;
  paper: string;
  accent: string;
  size: number;
  signals: MotionSignals;
  active: boolean;
  onState: ((state: MotionState) => void) | undefined;
}

function MotionCanvas({ sk, loaded, name, paper, accent, size, signals, active, onState }: MotionCanvasProps) {
  const reach = Math.ceil(size * FX_REACH);
  const box = size + 2 * reach;
  const signalsRef = useRef(signals);
  signalsRef.current = signals;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const [clock] = useState(() => {
    const now = Date.now();
    const director = new Director();
    return { director, timeline: new Timeline(director.next(signals, now), now) };
  });
  const [painter] = useState(() => new Painter(sk, loaded, size, reach));
  painter.setColors(paper, accent);
  const draw = (): SkPicture => {
    const now = Date.now();
    const state = clock.director.next(signalsRef.current, now);
    if (state !== clock.timeline.current) {
      clock.timeline.set(state, now);
      onStateRef.current?.(state);
    }
    return painter.picture(frame(loaded.rig, clock.timeline.clip(now), size), box);
  };
  // The loop below outlives renders; it always runs the newest `draw`.
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const [first] = useState(draw);
  const picture = useSharedValue<SkPicture>(first);

  useEffect(() => {
    onStateRef.current?.(clock.timeline.current);
  }, [clock]);

  useEffect(() => {
    // Paused, it keeps the last pose; it repaints once so a colour change still shows.
    picture.value = drawRef.current();
    if (!active) return;
    const timer = setInterval(() => {
      picture.value = drawRef.current();
    }, 1000 / FPS);
    return () => {
      clearInterval(timer);
    };
  }, [active, paper, accent, picture]);

  return (
    <View accessible accessibilityLabel={name} style={{ width: size, height: size }}>
      <View pointerEvents="none" style={[styles.fx, { left: -reach, top: -reach, width: box, height: box }]}>
        <sk.Canvas style={{ width: box, height: box }}>
          <sk.Picture picture={picture} />
        </sk.Canvas>
      </View>
    </View>
  );
}

/** Records one frame: the disc with the rig's parts, then the overlays. Paints, paths and fonts are made once. */
class Painter {
  private readonly fill: SkPaint;
  private readonly stroke: SkPaint;
  private readonly layer: SkPaint;
  private readonly font: SkFont;
  private readonly tail: SkPath | null;
  private readonly drop: SkPath | null;
  private readonly handle: SkPath | null;
  private paper = PAPER;
  private tones: [string, string, string] = ["#000000", "#000000", "#000000"];

  constructor(
    private readonly sk: SkiaModule,
    private readonly loaded: LoadedRig,
    private readonly size: number,
    private readonly reach: number,
  ) {
    const g = geometry(size);
    this.fill = sk.Skia.Paint();
    this.fill.setAntiAlias(true);
    this.stroke = sk.Skia.Paint();
    this.stroke.setAntiAlias(true);
    this.stroke.setStyle(sk.PaintStyle.Stroke);
    this.stroke.setStrokeJoin(sk.StrokeJoin.Round);
    this.layer = sk.Skia.Paint();
    // One font at 100 px, scaled per glyph: the z z z grow as they rise.
    this.font = sk.matchFont({ fontFamily: "Helvetica Neue", fontSize: 100, fontWeight: "600" });
    this.tail = sk.Skia.Path.MakeFromSVGString(g.quizTail);
    this.drop = sk.Skia.Path.MakeFromSVGString(g.drop);
    this.handle = sk.Skia.Path.MakeFromSVGString(g.lensHandle);
  }

  setColors(paper: string, accent: string): void {
    this.paper = paper;
    // Accent, soft (toward white) and deep (toward black): the confetti's three tones.
    this.tones = [accent, mixHex(accent, "#ffffff", 0.45), mixHex(accent, "#000000", 0.25)];
  }

  picture(f: Frame, box: number): SkPicture {
    return this.sk.createPicture((canvas) => {
      canvas.translate(this.reach, this.reach);
      this.disc(canvas, f);
      this.overlays(canvas, f);
    }, this.sk.Skia.XYWHRect(0, 0, box, box));
  }

  private paint(paint: SkPaint, color: string, alpha = 1): SkPaint {
    paint.setColor(this.sk.Skia.Color(color));
    paint.setAlphaf(alpha);
    return paint;
  }

  private disc(canvas: SkCanvas, f: Frame): void {
    const { sk, size } = this;
    const { rig, svgs } = this.loaded;
    canvas.save();
    canvas.clipRRect(sk.Skia.RRectXY(sk.Skia.XYWHRect(0, 0, size, size), size / 2, size / 2), sk.ClipOp.Intersect, true);
    canvas.drawRect(sk.Skia.XYWHRect(0, 0, size, size), this.paint(this.fill, this.paper));
    const k = size / rig.size;
    canvas.scale(k, k);
    for (const { part, m } of f.layers) {
      const svg = svgs.get(part);
      if (svg === undefined) continue;
      canvas.save();
      canvas.concat(sk.Skia.Matrix([m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1]));
      canvas.drawSvg(svg, rig.size, rig.size);
      canvas.restore();
    }
    canvas.restore();
  }

  private text(canvas: SkCanvas, glyph: string, x: number, y: number, px: number, color: string, alpha: number): void {
    canvas.save();
    canvas.translate(x, y);
    canvas.scale(px / 100, px / 100);
    const width = this.font.measureText(glyph).width;
    canvas.drawText(glyph, -width / 2, 0, this.paint(this.fill, color, alpha), this.font);
    canvas.restore();
  }

  /** A group at opacity `o`, so its overlapping shapes fade as one. */
  private group(canvas: SkCanvas, o: number, body: () => void): void {
    this.layer.setAlphaf(o);
    canvas.saveLayer(this.layer);
    body();
    canvas.restore();
  }

  private overlays(canvas: SkCanvas, f: Frame): void {
    const { size } = this;
    const g = geometry(size);
    const [accent, soft] = this.tones;
    const { fx } = f;
    this.stroke.setStrokeWidth(g.stroke);
    for (const wave of fx.waves) {
      if (wave.o > 0.01) canvas.drawCircle(size / 2, size / 2, wave.r, this.paint(this.stroke, accent, wave.o));
    }
    fx.dots.forEach((o, i) => {
      const dot = g.dots[i];
      if (o > 0.01 && dot !== undefined) canvas.drawCircle(dot[0], dot[1], g.dotR, this.paint(this.fill, accent, o));
    });
    for (const z of fx.zs) {
      if (z.o > 0.01) this.text(canvas, "z", z.x, z.y, z.size, accent, z.o);
    }
    const { quiz, drop } = fx;
    if (quiz.o > 0.01 && this.tail !== null) {
      const tail = this.tail;
      this.group(canvas, quiz.o, () => {
        canvas.save();
        canvas.translate(quiz.x, quiz.y);
        canvas.scale(quiz.scale, quiz.scale);
        canvas.rotate(quiz.rot, 0, 0);
        canvas.drawPath(tail, this.paint(this.fill, BUBBLE));
        this.stroke.setStrokeWidth(g.stroke);
        canvas.drawPath(tail, this.paint(this.stroke, accent));
        canvas.drawCircle(0, 0, g.quizR, this.paint(this.fill, BUBBLE));
        this.stroke.setStrokeWidth(Math.max(1.2, size * 0.014));
        canvas.drawCircle(0, 0, g.quizR, this.paint(this.stroke, accent));
        const p = g.quizPatch;
        canvas.drawRect(this.sk.Skia.XYWHRect(p.x, p.y, p.w, p.h), this.paint(this.fill, BUBBLE));
        this.text(canvas, "?", 0, size * 0.065, g.quizFont, accent, 1);
        canvas.restore();
      });
    }
    if (drop.o > 0.01 && this.drop !== null) {
      const path = this.drop;
      this.group(canvas, drop.o, () => {
        canvas.save();
        canvas.translate(drop.x, drop.y);
        canvas.drawPath(path, this.paint(this.fill, soft));
        this.stroke.setStrokeWidth(g.dropStroke);
        canvas.drawPath(path, this.paint(this.stroke, accent));
        canvas.restore();
      });
    }
    // Researching: a magnifier following the gaze, a light lens in an accent rim with its handle.
    const { lens } = fx;
    if (lens.o > 0.01 && this.handle !== null) {
      const handle = this.handle;
      this.group(canvas, lens.o, () => {
        canvas.save();
        canvas.translate(lens.x, lens.y);
        this.stroke.setStrokeWidth(g.lensStroke * 1.6);
        this.stroke.setStrokeCap(this.sk.StrokeCap.Round);
        canvas.drawPath(handle, this.paint(this.stroke, accent));
        this.stroke.setStrokeWidth(g.lensStroke);
        canvas.drawCircle(0, 0, g.lensR, this.paint(this.fill, BUBBLE, 0.6));
        canvas.drawCircle(0, 0, g.lensR, this.paint(this.stroke, accent));
        this.stroke.setStrokeCap(this.sk.StrokeCap.Butt);
        canvas.restore();
      });
    }
    for (const c of fx.confetti) {
      if (c.o <= 0.01) continue;
      canvas.save();
      canvas.translate(c.x, c.y);
      canvas.rotate(c.rot, 0, 0);
      const rect = this.sk.Skia.XYWHRect(-c.w / 2, -c.h / 2, c.w, c.h);
      canvas.drawRRect(this.sk.Skia.RRectXY(rect, size * 0.006, size * 0.006), this.paint(this.fill, this.tones[c.tone], c.o));
      canvas.restore();
    }
  }
}

const styles = StyleSheet.create({
  fx: { position: "absolute" },
});
