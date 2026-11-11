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
}

/** How long a move glides, so the drive waits this long before it clicks. */
export const CURSOR_GLIDE_MS = 550

/** `function (op) { ... }` run in the isolated world (see PageControl.cursor). */
export const CURSOR_SCRIPT = String(function (op: CursorOp) {
  const SVG = 'http://www.w3.org/2000/svg'
  interface Cursor {
    host: HTMLElement
    root: ShadowRoot
    pointer: HTMLElement
    face: HTMLElement
    x: number
    y: number
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
      .p { position: fixed; left: 0; top: 0; opacity: 0; will-change: transform;
        transition: transform .55s cubic-bezier(.22,.8,.26,1), opacity .2s ease; }
      .p.on { opacity: 1; }
      .a { position: absolute; left: -3px; top: -2px; width: 20px; height: 20px;
        filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
      .f { position: absolute; left: 14px; top: 16px; width: 20px; height: 20px; border-radius: 6px;
        overflow: hidden; background: var(--c); box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.25);
        font: 600 11px/20px -apple-system, system-ui, sans-serif; color: #111; text-align: center; }
      .f svg { width: 100%; height: 100%; display: block; }
      .r { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
        border: 2px solid var(--c); opacity: 0; transform: scale(.4); }
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
    root.append(pointer)
    document.documentElement.append(host)
    c = { host, root, pointer, face, x: -1, y: -1 }
    w.__relayAgentCursor = c
  }
  const cur = c
  if (op.color) cur.pointer.style.setProperty('--c', op.color)
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
    cur.pointer.classList.remove('on')
    return
  }
  if (op.x !== undefined && op.y !== undefined) {
    // The first placement appears where it is, later ones glide there.
    if (!cur.pointer.classList.contains('on')) cur.pointer.style.transition = 'opacity .2s ease'
    cur.pointer.style.transform = `translate(${op.x}px, ${op.y}px)`
    cur.x = op.x
    cur.y = op.y
    if (!cur.pointer.classList.contains('on')) {
      void cur.pointer.offsetWidth
      cur.pointer.style.transition = ''
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
})
