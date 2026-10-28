import {
  FX_REACH,
  STATE_META,
  Timeline,
  extension,
  frame,
  geometry,
  type Box,
  type Director,
  type DrawPath,
  type Extension,
  type Frame,
  type FrameLayer,
  type MotionSignals,
  type Rig,
} from '@relay/portrait-motion'
import { motionLive, onMotionGate, pageHidden } from './motion-gate'
import { IDLE_VIEW, nextView, type PortraitView } from './motion-store'

/** The card animates at most this many frames a second. */
export const PORTRAIT_FPS = 24
/** While it cannot animate, time-only edges (Waking ending, Snoozing) show within this long. */
const STILL_TICK_MS = 1000
/** Confetti pieces a frame can hold (the engine's burst). */
const CONFETTI = 16

export interface PainterOptions {
  rig: Rig
  /** The disc's side in CSS px. */
  size: number
  director: Director
  /** The agent's signals now; read once per frame (or tick while still). */
  signals: () => MotionSignals
  /** Hears each change of face or status dot. */
  onView: (view: PortraitView) => void
}

const n2 = (v: number): string => v.toFixed(2)
const SVG_NS = 'http://www.w3.org/2000/svg'
let painters = 0

/**
 * One pooled figure layer: `<g transform=matrix>` around the art (the part, or a mouth mid-morph)
 * with its optional eyelid clip, then the lids' edges. The `*Key` fields say what it last drew, so
 * a frame only touches what changed.
 */
interface Slot {
  g: SVGGElement
  art: SVGGElement
  lids: SVGGElement
  clipPath: SVGClipPathElement
  clipId: string
  /** `part:<key>`, or the morph's markup while one draws. */
  artKey: string
  mKey: string
  clipKey: string
  lidsKey: string
}

/** Extended mode's shapes as SVG paths; strokes round, even-odd fills where asked. */
function pathsMarkup(paths: readonly DrawPath[]): string {
  return paths
    .map(
      (p) =>
        `<path d="${p.d}" fill="${p.fill ?? 'none'}" stroke="${p.stroke ?? 'none'}"` +
        ` stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"` +
        `${p.opacity < 1 ? ` opacity="${p.opacity.toFixed(3)}"` : ''}` +
        `${p.evenOdd ? ' fill-rule="evenodd"' : ''}/>`,
    )
    .join('')
}

/** Clip rects in the part's space; a zero height is a shut eye. */
function clipMarkup(boxes: readonly Box[]): string {
  return boxes
    .map(
      (b) =>
        `<rect x="${n2(b.x0)}" y="${n2(b.y0)}" width="${n2(Math.max(0, b.x1 - b.x0))}" height="${n2(Math.max(0, b.y1 - b.y0))}"/>`,
    )
    .join('')
}

/**
 * Draws a portrait-motion rig into `host` as inline SVG in Extended mode (the engine's brow turns,
 * head turns, mouth morphs and eyelids): the figure's part groups on the disc, the accent overlays
 * (ring dots, sound waves, z z z, "?" bubble, sweat drop, confetti, the researching magnifier) in a
 * second SVG reaching `FX_REACH` past it. Each frame sets `transform` and `opacity` attributes;
 * markup (a part, a morphing mouth, eyelid clips and edges) is swapped only when it changes.
 * Animates at `PORTRAIT_FPS` while `motionLive()`; with motion off it holds the plain resting face
 * (and the ring, still, in a ring state); while the page is hidden it does nothing at all.
 */
export class PortraitPainter {
  private readonly timeline: Timeline
  private readonly figure: SVGSVGElement
  private readonly defs: SVGDefsElement
  /** Pooled layer slots, each drawing what it last drew until a frame says otherwise. */
  private readonly slots: Slot[] = []
  /** Extended mode's memory (mouth morphs, blinks) for this one portrait. */
  private readonly ext: Extension = extension()
  /** Makes this painter's clip ids unique in the document. */
  private readonly uid = ++painters
  private readonly dots: SVGCircleElement[]
  private readonly waves: SVGCircleElement[]
  private readonly zs: SVGTextElement[]
  private readonly quiz: SVGGElement
  private readonly drop: SVGGElement
  private readonly lens: SVGGElement
  private readonly confetti: SVGRectElement[]
  private readonly over: number
  private view: PortraitView = IDLE_VIEW
  private raf = 0
  private timer: number | undefined
  private readonly offGate: () => void

  constructor(
    private readonly host: HTMLElement,
    private readonly o: PainterOptions,
  ) {
    const { rig, size } = o
    const g = geometry(size)
    const over = (this.over = Math.ceil(size * FX_REACH))
    const box = size + 2 * over
    const c = n2(size / 2 + over)
    host.innerHTML =
      `<div class="eva-pmc-disc"><svg viewBox="0 0 ${rig.size} ${rig.size}" fill="none"></svg></div>` +
      `<svg class="eva-pmc-fx" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" style="left:${-over}px;top:${-over}px" aria-hidden="true">` +
      `<g class="eva-pmc-waves">${`<circle cx="${c}" cy="${c}" r="0" stroke-width="${n2(g.stroke)}" opacity="0"/>`.repeat(3)}</g>` +
      `<g class="eva-pmc-ring">${g.dots.map(([x, y]) => `<circle cx="${n2(x + over)}" cy="${n2(y + over)}" r="${n2(g.dotR)}" opacity="0"/>`).join('')}</g>` +
      `<g class="eva-pmc-zzz">${'<text text-anchor="middle" opacity="0">z</text>'.repeat(3)}</g>` +
      `<g class="eva-pmc-quiz" opacity="0"><g>` +
      `<path d="${g.quizTail}" stroke-width="${n2(g.stroke)}" stroke-linejoin="round"/>` +
      `<circle r="${n2(g.quizR)}" stroke-width="${n2(g.stroke)}"/>` +
      `<rect x="${n2(g.quizPatch.x)}" y="${n2(g.quizPatch.y)}" width="${n2(g.quizPatch.w)}" height="${n2(g.quizPatch.h)}"/>` +
      `<text y="${n2(size * 0.065)}" font-size="${n2(g.quizFont)}" text-anchor="middle">?</text>` +
      `</g></g>` +
      `<g class="eva-pmc-drop" opacity="0"><path d="${g.drop}" stroke-width="${n2(g.dropStroke)}"/></g>` +
      `<g class="eva-pmc-lens" opacity="0" stroke-linecap="round">` +
      `<path d="${g.lensHandle}" stroke-width="${n2(g.lensStroke * 1.6)}"/>` +
      `<circle r="${n2(g.lensR)}" stroke-width="${n2(g.lensStroke)}"/></g>` +
      `<g class="eva-pmc-conf">${`<rect rx="${n2(size * 0.006)}" opacity="0"/>`.repeat(CONFETTI)}</g>` +
      `</svg>`
    const all = <T extends Element>(sel: string): T[] => [...host.querySelectorAll<T>(sel)]
    this.figure = host.querySelector<SVGSVGElement>('.eva-pmc-disc svg')!
    this.defs = document.createElementNS(SVG_NS, 'defs')
    this.figure.append(this.defs)
    this.waves = all('.eva-pmc-waves circle')
    this.dots = all('.eva-pmc-ring circle')
    this.zs = all('.eva-pmc-zzz text')
    this.quiz = host.querySelector<SVGGElement>('.eva-pmc-quiz')!
    this.drop = host.querySelector<SVGGElement>('.eva-pmc-drop')!
    this.lens = host.querySelector<SVGGElement>('.eva-pmc-lens')!
    this.confetti = all('.eva-pmc-conf rect')
    const now = Date.now()
    this.view = nextView(o.director, o.signals(), now, IDLE_VIEW)
    this.timeline = new Timeline(this.view.state, now)
    o.onView(this.view)
    this.offGate = onMotionGate(() => this.run())
    this.run()
  }

  /** The agent's signals may have moved (a store changed): matters only while still. */
  poke(): void {
    if (this.raf === 0 && !pageHidden()) this.still()
  }

  destroy(): void {
    this.offGate()
    this.halt()
    this.host.replaceChildren()
  }

  /** Animating, a still face, or nothing, as the gate says. */
  private run(): void {
    this.halt()
    if (pageHidden()) return
    if (motionLive()) {
      this.raf = requestAnimationFrame(this.step)
      return
    }
    this.still()
    this.timer = window.setInterval(() => this.still(), STILL_TICK_MS)
  }

  private halt(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    // Timeouts and intervals share one id list, so this clears the frame wait and the still tick.
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** One frame, then the next one 1/PORTRAIT_FPS s later, on the next animation frame after that. */
  private readonly step = (): void => {
    const started = performance.now()
    const now = this.advance()
    this.paint(frame(this.o.rig, this.timeline.clip(now), this.o.size, this.ext))
    const wait = Math.max(0, 1000 / PORTRAIT_FPS - (performance.now() - started) - 4)
    // One wait at a time, however the frame was reached.
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.raf = requestAnimationFrame(this.step)
    }, wait)
  }

  /** The director's face now, moved into the timeline; returns the time used. */
  private advance(): number {
    const now = Date.now()
    const view = nextView(this.o.director, this.o.signals(), now, this.view)
    this.timeline.set(view.state, now)
    if (view !== this.view) {
      this.view = view
      this.o.onView(view)
    }
    return now
  }

  /** Motion off: the resting face (plain, no Extended mode), and the ring held still in a ring state. */
  private still(): void {
    this.advance()
    const f = frame(
      this.o.rig,
      { state: 'idle', lt: 0, gt: 0, prev: null, prevDur: 0 },
      this.o.size,
    )
    const ring = STATE_META[this.view.state].ring ? 0.8 : 0
    f.fx.dots = f.fx.dots.map(() => ring)
    f.fx.waves = f.fx.waves.map((w) => ({ ...w, o: 0 }))
    f.fx.zs = f.fx.zs.map((z) => ({ ...z, o: 0 }))
    f.fx.quiz = { ...f.fx.quiz, o: 0 }
    f.fx.drop = { ...f.fx.drop, o: 0 }
    f.fx.lens = { ...f.fx.lens, o: 0 }
    f.fx.confetti = []
    this.paint(f)
  }

  private paint({ layers, fx }: Frame): void {
    while (this.slots.length < layers.length) this.slots.push(this.slot(this.slots.length))
    for (let i = 0; i < this.slots.length; i++) this.layer(this.slots[i]!, layers[i])
    const over = this.over
    const X = (v: number): string => n2(v + over)
    fx.dots.forEach((o, i) => set(this.dots[i], 'opacity', o.toFixed(3)))
    fx.waves.forEach((w, i) => {
      set(this.waves[i], 'r', n2(w.r))
      set(this.waves[i], 'opacity', w.o.toFixed(3))
    })
    fx.zs.forEach((z, i) => {
      const el = this.zs[i]
      set(el, 'opacity', z.o.toFixed(3))
      if (z.o <= 0) return
      set(el, 'x', X(z.x))
      set(el, 'y', X(z.y))
      set(el, 'font-size', n2(z.size))
    })
    set(this.quiz, 'opacity', fx.quiz.o.toFixed(3))
    if (fx.quiz.o > 0)
      set(
        this.quiz,
        'transform',
        `translate(${X(fx.quiz.x)} ${X(fx.quiz.y)}) scale(${fx.quiz.scale.toFixed(3)}) rotate(${n2(fx.quiz.rot)})`,
      )
    set(this.drop, 'opacity', fx.drop.o.toFixed(3))
    if (fx.drop.o > 0) set(this.drop, 'transform', `translate(${X(fx.drop.x)} ${X(fx.drop.y)})`)
    set(this.lens, 'opacity', fx.lens.o.toFixed(3))
    if (fx.lens.o > 0) set(this.lens, 'transform', `translate(${X(fx.lens.x)} ${X(fx.lens.y)})`)
    this.confetti.forEach((r, i) => {
      const k = fx.confetti[i]
      set(r, 'opacity', k === undefined ? '0' : k.o.toFixed(3))
      if (k === undefined) return
      set(r, 'class', `eva-pmc-t${k.tone}`)
      set(r, 'x', n2(-k.w / 2))
      set(r, 'y', n2(-k.h / 2))
      set(r, 'width', n2(k.w))
      set(r, 'height', n2(k.h))
      set(r, 'transform', `translate(${X(k.x)} ${X(k.y)}) rotate(${k.rot.toFixed(1)})`)
    })
  }

  private slot(i: number): Slot {
    const g = document.createElementNS(SVG_NS, 'g')
    const art = document.createElementNS(SVG_NS, 'g')
    const lids = document.createElementNS(SVG_NS, 'g')
    const clipPath = document.createElementNS(SVG_NS, 'clipPath')
    const clipId = `eva-pmc-${this.uid}-${i}`
    clipPath.id = clipId
    clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse')
    this.defs.append(clipPath)
    g.append(art, lids)
    this.figure.append(g)
    return { g, art, lids, clipPath, clipId, artKey: '', mKey: '', clipKey: '', lidsKey: '' }
  }

  /** Draws layer `l` (or nothing) into slot `s`, touching only what changed. */
  private layer(s: Slot, l: FrameLayer | undefined): void {
    // A morph draws instead of the part; its markup is its key (it changes every morph frame).
    const morph = l?.morph === undefined ? null : pathsMarkup(l.morph)
    const artKey = l === undefined ? '' : (morph ?? `part:${l.part}`)
    if (s.artKey !== artKey) {
      s.art.innerHTML = l === undefined ? '' : (morph ?? this.o.rig.parts[l.part] ?? '')
      s.artKey = artKey
    }
    if (l !== undefined) {
      const m = `matrix(${l.m.map((v) => v.toFixed(3)).join(' ')})`
      if (s.mKey !== m) {
        s.g.setAttribute('transform', m)
        s.mKey = m
      }
    }
    const clip = l?.clip === undefined ? '' : clipMarkup(l.clip)
    if (s.clipKey !== clip) {
      if (clip === '') s.art.removeAttribute('clip-path')
      else {
        s.clipPath.innerHTML = clip
        if (s.clipKey === '') s.art.setAttribute('clip-path', `url(#${s.clipId})`)
      }
      s.clipKey = clip
    }
    const lids = l?.lids === undefined ? '' : pathsMarkup(l.lids)
    if (s.lidsKey !== lids) {
      s.lids.innerHTML = lids
      s.lidsKey = lids
    }
  }
}

/** Sets an attribute only when it changes (most overlays sit at 0 in most states). */
function set(el: Element | undefined, name: string, value: string): void {
  if (el !== undefined && el.getAttribute(name) !== value) el.setAttribute(name, value)
}
