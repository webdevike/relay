import {
  FX_REACH,
  STATE_META,
  Timeline,
  frame,
  geometry,
  type Director,
  type Frame,
  type MotionSignals,
  type MotionState,
  type Rig,
} from '@relay/portrait-motion'
import { motionLive, onMotionGate, pageHidden } from './motion-gate'

/** The card animates at most this many frames a second. */
export const PORTRAIT_FPS = 24
/** While it cannot animate, time-only edges (Hello and Done ending, Snoozing) show within this long. */
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
  /** Hears each state change (the card's state dot). */
  onState: (state: MotionState) => void
}

const n2 = (v: number): string => v.toFixed(2)

/**
 * Draws a portrait-motion rig into `host` as inline SVG: the figure's part groups on the disc,
 * the accent overlays (ring dots, sound waves, z z z, "?" bubble, sweat drop, confetti) in a
 * second SVG reaching `FX_REACH` past it. Each frame only sets `transform` and `opacity`
 * attributes; a part group's markup is swapped only when its part key changes. Animates at
 * `PORTRAIT_FPS` while `motionLive()`; with motion off it holds the resting face (and the ring,
 * still, in a ring state); while the page is hidden it does nothing at all.
 */
export class PortraitPainter {
  private readonly timeline: Timeline
  private readonly figure: SVGSVGElement
  private readonly groups: SVGGElement[] = []
  /** Part key and transform each pooled group shows, so unchanged ones are left alone. */
  private readonly drawn: { part: string; m: string }[] = []
  private readonly dots: SVGCircleElement[]
  private readonly waves: SVGCircleElement[]
  private readonly zs: SVGTextElement[]
  private readonly quiz: SVGGElement
  private readonly drop: SVGGElement
  private readonly confetti: SVGRectElement[]
  private readonly over: number
  private state: MotionState
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
      `<g class="eva-pmc-conf">${`<rect rx="${n2(size * 0.006)}" opacity="0"/>`.repeat(CONFETTI)}</g>` +
      `</svg>`
    const all = <T extends Element>(sel: string): T[] => [...host.querySelectorAll<T>(sel)]
    this.figure = host.querySelector<SVGSVGElement>('.eva-pmc-disc svg')!
    this.waves = all('.eva-pmc-waves circle')
    this.dots = all('.eva-pmc-ring circle')
    this.zs = all('.eva-pmc-zzz text')
    this.quiz = host.querySelector<SVGGElement>('.eva-pmc-quiz')!
    this.drop = host.querySelector<SVGGElement>('.eva-pmc-drop')!
    this.confetti = all('.eva-pmc-conf rect')
    const now = Date.now()
    this.state = o.director.next(o.signals(), now)
    this.timeline = new Timeline(this.state, now)
    o.onState(this.state)
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
    this.paint(frame(this.o.rig, this.timeline.clip(this.advance()), this.o.size))
    const wait = Math.max(0, 1000 / PORTRAIT_FPS - (performance.now() - started) - 4)
    this.timer = window.setTimeout(() => {
      this.raf = requestAnimationFrame(this.step)
    }, wait)
  }

  /** The director's state now, moved into the timeline; returns the time used. */
  private advance(): number {
    const now = Date.now()
    const state = this.o.director.next(this.o.signals(), now)
    this.timeline.set(state, now)
    if (state !== this.state) {
      this.state = state
      this.o.onState(state)
    }
    return now
  }

  /** Motion off: the resting face, and the ring held still in a ring state. */
  private still(): void {
    this.advance()
    const f = frame(
      this.o.rig,
      { state: 'idle', lt: 0, gt: 0, prev: null, prevDur: 0 },
      this.o.size,
    )
    const ring = STATE_META[this.state].ring ? 0.8 : 0
    f.fx.dots = f.fx.dots.map(() => ring)
    f.fx.waves = f.fx.waves.map((w) => ({ ...w, o: 0 }))
    f.fx.zs = f.fx.zs.map((z) => ({ ...z, o: 0 }))
    f.fx.quiz = { ...f.fx.quiz, o: 0 }
    f.fx.drop = { ...f.fx.drop, o: 0 }
    f.fx.confetti = []
    this.paint(f)
  }

  private paint({ layers, fx }: Frame): void {
    const { rig } = this.o
    while (this.groups.length < layers.length) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      this.figure.append(g)
      this.groups.push(g)
      this.drawn.push({ part: '', m: '' })
    }
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i]!
      const was = this.drawn[i]!
      const l = layers[i]
      const part = l?.part ?? ''
      if (was.part !== part) {
        g.innerHTML = l === undefined ? '' : (rig.parts[part] ?? '')
        was.part = part
      }
      if (l === undefined) continue
      const m = `matrix(${l.m.map((v) => v.toFixed(3)).join(' ')})`
      if (was.m !== m) {
        g.setAttribute('transform', m)
        was.m = m
      }
    }
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
}

/** Sets an attribute only when it changes (most overlays sit at 0 in most states). */
function set(el: Element | undefined, name: string, value: string): void {
  if (el !== undefined && el.getAttribute(name) !== value) el.setAttribute(name, value)
}
