/**
 * The agent's cursor, drawn inside the page it drives (a native page paints over anything the
 * shell draws, so the cursor can't live in the shell). PageControl.cursor runs CURSOR_SCRIPT in an
 * isolated world: page scripts never see its code or state, only an inert host element
 * (`#relay-agent-cursor`, pointer-events none) whose closed shadow root holds the drawing.
 * Styles go through a constructed sheet and the avatar through DOMParser, so a page's inline
 * style and script rules never block it; an avatar the page's Trusted Types refuse falls back to
 * the agent's initial.
 */

/** One cursor step, in viewport CSS px. */
export interface CursorOp {
  op: 'show' | 'move' | 'click' | 'hide'
  x?: number
  y?: number
  /** The agent's accent color (`#86efac`). */
  color?: string
  /** The agent's portrait as SVG text, drawn in a rounded square beside the arrow. */
  avatar?: string
  /** Its initial, when there is no portrait (or the page refuses it). */
  initial?: string
  /** Ms to show the dotted route and target before the cursor travels (move only). */
  lead?: number
}

/** Shown a beat before each move: the dotted route and target marker (op.lead, ms). */
export const CURSOR_LEAD_MS = 260

/** `function (op) { ... }` run in the isolated world (see PageControl.cursor). */
export const CURSOR_SCRIPT = String(function (op: CursorOp) {
  const SVG = 'http://www.w3.org/2000/svg'
  interface Cursor {
    host: HTMLElement
    root: ShadowRoot
    pointer: HTMLElement
    face: HTMLElement
    mark: HTMLElement
    trail: SVGSVGElement
    segs: Array<{ g: SVGGElement; line: SVGPathElement; halo: SVGPathElement }>
    glide: Glide | null
    x: number
    y: number
  }
  interface Glide {
    x: number
    y: number
    g: SVGGElement
    timer: number
    anim: Animation | null
  }
  const w = globalThis as unknown as { __relayAgentCursor?: Cursor }
  let c = w.__relayAgentCursor
  if (!c || !c.host.isConnected) {
    const host = document.createElement('div')
    host.id = 'relay-agent-cursor'
    host.setAttribute('aria-hidden', 'true')
    host.style.setProperty('all', 'initial')
    host.style.setProperty('position', 'fixed')
    host.style.setProperty('inset', '0')
    host.style.setProperty('pointer-events', 'none')
    host.style.setProperty('z-index', '2147483647')
    const root = host.attachShadow({ mode: 'closed' })
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(`
      .t { position: fixed; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; }
      .m { position: fixed; left: 0; top: 0; width: 0; height: 0; opacity: 0; transition: opacity .15s ease; }
      .m.on { opacity: 1; }
      .m::before { content: ''; position: absolute; left: -9px; top: -9px; width: 16px; height: 16px;
        border-radius: 50%; border: 2px solid var(--c); background: color-mix(in srgb, var(--c) 25%, #fff);
        box-shadow: 0 0 0 2px #fff; }
      .m::after { content: ''; position: absolute; left: -2px; top: -2px; width: 4px; height: 4px;
        border-radius: 50%; background: var(--c); }
      .p { position: fixed; left: 0; top: 0; opacity: 0; will-change: transform; transition: opacity .2s ease; }
      .p.on { opacity: 1; }
      .a { position: absolute; left: -3px; top: -2px; width: 20px; height: 20px;
        filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
      .f { position: absolute; left: 14px; top: 16px; width: 20px; height: 20px; border-radius: 6px;
        overflow: hidden; background: var(--c); box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.25);
        font: 600 11px/20px -apple-system, system-ui, sans-serif; color: #111; text-align: center; }
      .f svg { width: 100%; height: 100%; display: block; }
      .r { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
        border: 2px solid var(--c); box-shadow: 0 0 0 2px #fff, inset 0 0 0 2px #fff; opacity: 0; transform: scale(.4); }
      .r.go { animation: ripple .5s ease-out; }
      @keyframes ripple { 0% { opacity: .9; transform: scale(.4) } 100% { opacity: 0; transform: scale(1.6) } }
    `)
    root.adoptedStyleSheets = [sheet]
    const pointer = document.createElement('div')
    pointer.className = 'p'
    const ripple = document.createElement('div')
    ripple.className = 'r'
    const arrow = document.createElementNS(SVG, 'svg')
    arrow.setAttribute('viewBox', '0 0 20 20')
    arrow.setAttribute('class', 'a')
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', 'M3 2 L3 16.5 L7 12.8 L9.6 18.4 L12.2 17.2 L9.7 11.8 L15 11.6 Z')
    path.setAttribute('fill', 'var(--c)')
    path.setAttribute('stroke', '#fff')
    path.setAttribute('stroke-width', '1.4')
    path.setAttribute('stroke-linejoin', 'round')
    arrow.append(path)
    const face = document.createElement('div')
    face.className = 'f'
    pointer.append(ripple, arrow, face)
    const trail = document.createElementNS(SVG, 'svg')
    trail.setAttribute('class', 't')
    const mark = document.createElement('div')
    mark.className = 'm'
    root.append(trail, mark, pointer)
    document.documentElement.append(host)
    c = { host, root, pointer, face, mark, trail, segs: [], glide: null, x: -1, y: -1 }
    w.__relayAgentCursor = c
  }
  const cur = c
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  /** Ends an in-flight glide where it was headed, then lets that segment fade out. */
  const land = (): void => {
    const g = cur.glide
    if (!g) return
    cur.glide = null
    window.clearTimeout(g.timer)
    g.anim?.cancel()
    cur.pointer.style.offsetPath = 'none'
    cur.pointer.style.transform = `translate(${g.x}px, ${g.y}px)`
    cur.x = g.x
    cur.y = g.y
    cur.mark.classList.remove('on')
    // The trail lingers for several seconds; older segments are fainter (ranked on each move).
    const fade = g.g.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 6000,
      easing: 'ease-in',
      fill: 'forwards',
    })
    fade.onfinish = () => {
      g.g.remove()
      cur.segs = cur.segs.filter((s) => s.g !== g.g)
    }
  }
  if (op.color) cur.host.style.setProperty('--c', op.color)
  if (op.avatar !== undefined || op.initial !== undefined) {
    cur.face.replaceChildren()
    let drawn = false
    if (op.avatar) {
      try {
        const doc = new DOMParser().parseFromString(op.avatar, 'image/svg+xml')
        const svg = doc.documentElement
        if (svg.nodeName.toLowerCase() === 'svg') {
          cur.face.append(document.importNode(svg, true))
          drawn = true
        }
      } catch {
        // The page's Trusted Types refuse parsing: the initial stands in.
      }
    }
    if (!drawn) cur.face.textContent = (op.initial ?? '').slice(0, 1).toUpperCase()
  }
  if (op.op === 'hide') {
    land()
    cur.pointer.classList.remove('on')
    cur.mark.classList.remove('on')
    return 0
  }
  let wait = 0
  if (op.x !== undefined && op.y !== undefined) {
    land()
    const shown = cur.pointer.classList.contains('on') && cur.x >= 0
    const dist = shown ? Math.hypot(op.x - cur.x, op.y - cur.y) : 0
    if (op.op !== 'move' || !shown || dist < 4 || reduce) {
      // The first placement appears where it is; reduced motion and tiny steps jump, no trail.
      cur.pointer.style.transform = `translate(${op.x}px, ${op.y}px)`
      cur.x = op.x
      cur.y = op.y
    } else {
      const dur = Math.round(Math.min(600, Math.max(300, 300 + dist * 0.4)))
      const x0 = cur.x
      const y0 = cur.y
      const x1 = op.x
      const y1 = op.y
      // A shallow bow, so the path reads as a path and not a ruler line.
      const bow = Math.min(60, dist * 0.12) * (x1 >= x0 ? -1 : 1)
      const cx = (x0 + x1) / 2 - ((y1 - y0) / dist) * bow
      const cy = (y0 + y1) / 2 + ((x1 - x0) / dist) * bow
      const d = `M ${x0} ${y0} Q ${cx} ${cy} ${x1} ${y1}`
      const line = document.createElementNS(SVG, 'path')
      line.setAttribute('d', d)
      line.setAttribute('fill', 'none')
      line.setAttribute('stroke', 'var(--c)')
      line.setAttribute('stroke-width', '4')
      line.setAttribute('stroke-linecap', 'round')
      line.setAttribute('stroke-dasharray', '0.1 9')
      // A white underlay keeps the dots readable on dark buttons and busy pages.
      const halo = line.cloneNode() as SVGPathElement
      halo.setAttribute('stroke', '#fff')
      halo.setAttribute('stroke-width', '7')
      halo.setAttribute('opacity', '.8')
      const g = document.createElementNS(SVG, 'g')
      g.style.opacity = '0'
      g.style.transition = 'opacity .15s ease'
      g.append(halo, line)
      cur.trail.append(g)
      cur.segs.push({ g, line, halo })
      while (cur.segs.length > 5) cur.segs.shift()?.g.remove()
      const ranks = [1, 0.7, 0.5, 0.35, 0.25]
      cur.segs.forEach((s, i) => {
        const rank = ranks[cur.segs.length - 1 - i] ?? 0.2
        s.line.style.opacity = String(rank)
        s.halo.style.opacity = String(rank * 0.8)
      })
      // The lookahead: the dotted route and a target marker show a beat before the cursor goes.
      cur.mark.style.transform = `translate(${x1}px, ${y1}px)`
      cur.mark.classList.add('on')
      void g.getBoundingClientRect()
      g.style.opacity = '.55'
      const glide: Glide = { x: x1, y: y1, g, timer: 0, anim: null }
      glide.timer = window.setTimeout(() => {
        g.style.opacity = '1'
        cur.pointer.style.offsetPath = `path('${d}')`
        cur.pointer.style.offsetRotate = '0deg'
        cur.pointer.style.offsetAnchor = '0 0'
        cur.pointer.style.transform = 'none'
        glide.anim = cur.pointer.animate(
          { offsetDistance: ['0%', '100%'] },
          { duration: dur, easing: 'cubic-bezier(.45,.05,.2,1)', fill: 'forwards' },
        )
        glide.anim.onfinish = land
        glide.timer = window.setTimeout(land, dur + 80)
      }, op.lead ?? 260)
      cur.glide = glide
      wait = (op.lead ?? 260) + dur
    }
  }
  cur.pointer.classList.add('on')
  if (op.op === 'click') {
    const ripple = cur.pointer.querySelector('.r')
    if (ripple) {
      ripple.classList.remove('go')
      void (ripple as HTMLElement).offsetWidth
      ripple.classList.add('go')
    }
  }
  return wait
})
