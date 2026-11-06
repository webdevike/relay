import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { failed, textOf, type Driver, type Reply } from './driver'

/** One on-screen window as cua-driver lists it; `bounds` in global points, top-left origin. */
export interface WindowInfo {
  windowId: number
  pid: number
  app: string
  title: string
  bounds: Frame
  /** Stacking order, higher is nearer the front; null when WindowServer did not say. */
  z: number | null
}

export interface Frame {
  x: number
  y: number
  w: number
  h: number
}

/** A control from the latest read of a window: its ref, the tree line the model saw, its frame. */
export interface Control {
  ref: number
  token: string | null
  role: string
  label: string
  line: string
  frame: Frame | null
}

export interface Snapshot {
  windowId: number
  pid: number
  app: string
  title: string
  /** The accessibility tree as numbered refs (`- [12] AXButton "Save"`), trimmed of noise. */
  tree: string
  controls: Map<number, Control>
  truncated: boolean
  /** PNG of the window when asked for. */
  image: Buffer | null
}

/**
 * A picture of a window as WindowServer draws it (`screencapture -l`), for the vision fallback.
 * It can be bigger than the window: an attached child window (Calculator's "Mode Menu" tip,
 * 2026-11-06) is drawn with it, which cua-driver's own capture squeezes into the window's frame,
 * so its pixels did not map back and clicks landed on the wrong keys.
 */
export interface Shot {
  windowId: number
  pid: number
  app: string
  image: Buffer
  /** Pixel size of `image`. */
  width: number
  height: number
  /** The window on screen, global points. */
  bounds: Frame
  /** The global point of the picture's top-left pixel, and its pixels per point. */
  origin: { x: number; y: number }
  scale: number
}

/**
 * Where a window's picture sits on screen: the window's own frame when the size matches it,
 * else the window together with the app's windows touching it (attached children), when that
 * matches; pixels per point from the width, checked against the height.
 */
export function pictureFrame(
  win: Frame,
  others: readonly Frame[],
  size: { width: number; height: number },
): { origin: { x: number; y: number }; scale: number } {
  const fits = (f: Frame): number | null => {
    const k = size.width / f.w
    return Math.abs(size.height / f.h - k) < 0.02 * k ? k : null
  }
  const own = fits(win)
  if (own !== null) return { origin: { x: win.x, y: win.y }, scale: own }
  const touching = others.filter(
    (o) =>
      o.x <= win.x + win.w + 1 &&
      o.x + o.w >= win.x - 1 &&
      o.y <= win.y + win.h + 1 &&
      o.y + o.h >= win.y - 1,
  )
  const x = Math.min(win.x, ...touching.map((o) => o.x))
  const y = Math.min(win.y, ...touching.map((o) => o.y))
  const union = {
    x,
    y,
    w: Math.max(win.x + win.w, ...touching.map((o) => o.x + o.w)) - x,
    h: Math.max(win.y + win.h, ...touching.map((o) => o.y + o.h)) - y,
  }
  const k = fits(union)
  return k !== null
    ? { origin: { x, y }, scale: k }
    : { origin: { x: win.x, y: win.y }, scale: size.width / win.w }
}

/** A click step's target: a control of the latest read, or something only the picture shows. */
export type ClickTarget =
  | { kind: 'ax'; control: Control }
  | { kind: 'vision'; target: string }
  | { kind: 'error'; why: string }

/** Containers, menus and window chrome: present in every tree, never what a step is about. */
const NOT_A_TARGET =
  /^AX(Window|Group|ScrollArea|SplitGroup|Unknown|Application|MenuBar|MenuBarItem|Menu|MenuItem|LayoutArea)$/
const WINDOW_CHROME = /_XCUI:|close (panel )?button|minimi[sz]e button|zoom button|full ?screen/i

/** A control a step can act on: it has a token and a real frame, and is not a container or chrome. */
export function isTarget(c: Control): boolean {
  return (
    c.token !== null &&
    !!c.frame &&
    c.frame.w >= 2 &&
    c.frame.h >= 2 &&
    !NOT_A_TARGET.test(c.role) &&
    !WINDOW_CHROME.test(c.line)
  )
}

/**
 * True when the read has no control a step could act on: custom-drawn windows (Bambu Studio's
 * wx/OpenGL UI, games, canvases) answer an empty tree or only the menu bar and window chrome.
 */
export const drawnOnly = (snap: Snapshot): boolean => ![...snap.controls.values()].some(isTarget)

/**
 * What a click step acts on: its `ref` when that is a control of the latest read; else the control
 * whose label is exactly its `target`; else the picture (vision) finds `target`.
 */
export function clickTarget(step: Step, snap: Snapshot): ClickTarget {
  if (step.ref !== undefined) {
    const c = snap.controls.get(step.ref)
    if (c?.token) return { kind: 'ax', control: c }
    if (!step.target)
      return { kind: 'error', why: `ref ${step.ref} is not a control in the latest read` }
  }
  const target = step.target?.trim()
  if (!target) return { kind: 'error', why: `${step.type} needs a ref or a target` }
  const want = target.toLowerCase()
  const byLabel = [...snap.controls.values()].find(
    (c) => isTarget(c) && c.label.trim().toLowerCase() === want,
  )
  return byLabel ? { kind: 'ax', control: byLabel } : { kind: 'vision', target }
}

/** One of an app's on-screen windows at any level, from WindowServer, front to back. */
export interface Layered {
  windowId: number
  pid: number
  /** 0 for normal windows; panels float above (Quick Look is 3 while its app is active). */
  layer: number
  title: string
  bounds: Frame
}

/**
 * The window keys meant for `named` land in: a floating window of the same app in front of it
 * (Quick Look, an inspector, a popover), else `named` itself. `stack` is the app's windows front to
 * back. A normal-level window in front, titled or not, is not taken for a panel: Calculator keeps
 * an invisible untitled one over its window (2026-11-06), and Quick Look only floats while its app
 * is active, which live makes sure of first.
 */
export function keyWindow(stack: readonly Layered[], named: WindowInfo): WindowInfo {
  for (const w of stack) {
    if (w.windowId === named.windowId) return named
    if (w.pid === named.pid && w.layer > 0)
      return { ...named, windowId: w.windowId, title: w.title, bounds: w.bounds, z: null }
  }
  return named
}

/** A picture's pixel as a global screen point (for the cursor and the click). */
export function toScreen(shot: Shot, x: number, y: number): { x: number; y: number } {
  return { x: shot.origin.x + x / shot.scale, y: shot.origin.y + y / shot.scale }
}

export type StepType =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'type'
  | 'set_value'
  | 'key'
  | 'hotkey'
  | 'menu'
  | 'scroll'
  | 'wait'

export const StepSchema = z.object({
  type: z.enum([
    'click',
    'double_click',
    'right_click',
    'type',
    'set_value',
    'key',
    'hotkey',
    'menu',
    'scroll',
    'wait',
  ]),
  ref: z.number().int().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  modifiers: z.array(z.string()).optional(),
  keys: z.array(z.string()).optional(),
  path: z.array(z.string()).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().optional(),
  ms: z.number().int().optional(),
  /** A click without a usable ref: what the control shows ("Slice plate"), found in the picture. */
  target: z.string().optional(),
})
export type Step = z.infer<typeof StepSchema>

const WindowSchema = z.object({
  app_name: z.string(),
  title: z.string().catch(''),
  pid: z.number(),
  window_id: z.number(),
  is_on_screen: z.boolean().catch(false),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  z_index: z.number().nullable().optional().catch(null),
})
const FrameSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const ElementSchema = z.object({
  element_index: z.number(),
  element_token: z.string().optional(),
  role: z.string().catch(''),
  label: z.string().optional().catch(undefined),
  frame: FrameSchema.optional().catch(undefined),
})

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** A one-line description of a step for the chat and the log ("click “Save”"). */
export function describeStep(step: Step, control: Control | undefined): string {
  const what = control
    ? `“${control.label || control.role.replace(/^AX/, '')}”`
    : step.target
      ? `“${step.target}”`
      : ''
  switch (step.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${step.type.replace('_', ' ')} ${what}`.trim()
    case 'type':
      return `type “${(step.text ?? '').slice(0, 60)}”${what ? ` into ${what}` : ''}`
    case 'set_value':
      return `set ${what} to “${(step.text ?? '').slice(0, 60)}”`
    case 'key':
      return `press ${[...(step.modifiers ?? []), step.key ?? ''].join('+')}`
    case 'hotkey':
      return `press ${(step.keys ?? []).join('+')}`
    case 'menu':
      return `choose ${(step.path ?? []).join(' > ')}`
    case 'scroll':
      return `scroll ${step.direction ?? 'down'}`
    case 'wait':
      return `wait ${step.ms ?? 500} ms`
  }
}

/**
 * Desktop control over cua-driver: windows, reads as numbered refs, batches of actions against
 * those refs, and pictures for windows without them. Background, except where a step runs with
 * `inFront` (live: Isaac is watching and the window is in front); only `front()` raises a window.
 */
export class Desktop {
  private latest = new Map<number, Snapshot>()

  constructor(
    private driver: Driver,
    private reopen: (app: string) => Promise<void> = (app) => openInBackground(app),
    private openLink: (url: string) => Promise<void> = (url) => openInBackground(url, 'url'),
    private openDoc: (file: string, app: string | undefined) => Promise<void> = (file, app) =>
      openInBackground(file, 'file', app),
    /** WindowServer's side: an app's windows at every level, and pictures that leave refs alone. */
    private screen: Screen = MAC_SCREEN,
  ) {}

  get backend(): string {
    return this.driver.backend
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Reply> {
    const r = await this.driver.call(name, args)
    if (failed(r)) throw new Error(`${name}: ${textOf(r).slice(0, 300)}`)
    return r
  }

  /** On-screen, real-sized windows, front to back. */
  async windows(): Promise<WindowInfo[]> {
    const r = await this.call('list_windows', {})
    const raw = r.result?.structuredContent?.windows
    const list = Array.isArray(raw) ? raw : []
    const wins = list.flatMap((w) => {
      const p = WindowSchema.safeParse(w)
      if (!p.success || !p.data.is_on_screen) return []
      const b = p.data.bounds
      if (b.width <= 80 || b.height <= 60) return []
      return [
        {
          windowId: p.data.window_id,
          pid: p.data.pid,
          app: p.data.app_name,
          title: p.data.title,
          bounds: { x: b.x, y: b.y, w: b.width, h: b.height },
          z: p.data.z_index ?? null,
        },
      ]
    })
    // Stable: windows without a z keep the driver's order, after the ones with one.
    return wins.sort((a, b) => (b.z ?? -Infinity) - (a.z ?? -Infinity) || 0)
  }

  /** Launches or reuses `app` without activating it; reopens a running app that has no window. */
  async openApp(app: string): Promise<{ pid: number; windows: WindowInfo[] }> {
    const byBundle = /^[\w-]+(\.[\w-]+){2,}$/.test(app)
    const r = await this.call('launch_app', byBundle ? { bundle_id: app } : { name: app })
    const pid = r.result?.structuredContent?.pid
    if (typeof pid !== 'number') throw new Error(`${app} did not start`)
    for (let i = 0; i < 15; i++) {
      const wins = (await this.windows()).filter((w) => w.pid === pid)
      if (wins.length > 0) return { pid, windows: wins }
      if (i === 3) await this.reopen(app)
      await sleep(200)
    }
    return { pid, windows: [] }
  }

  /**
   * Opens a web or app link in the background (`open -g`): an https page in the default browser, a
   * Linear issue in Linear. Answers the windows on screen once the link had a moment to land, and the
   * window it landed in (new, or retitled), when one changed.
   */
  async openUrl(url: string): Promise<{ windows: WindowInfo[]; landed: WindowInfo | null }> {
    const scheme = /^([a-z][\w+.-]*):/i.exec(url)?.[1]?.toLowerCase()
    if (!scheme || !Object.hasOwn(URL_SCHEMES, scheme))
      throw new Error(`only ${Object.keys(URL_SCHEMES).join(', ')} links open`)
    return this.landing(() => this.openLink(url))
  }

  /**
   * Opens a document in the background (`open -g`, in `app` when given, else its default app):
   * a regular file only, never a program, script or installer. `~/` is the home folder.
   */
  async openFile(
    file: string,
    app?: string,
  ): Promise<{ windows: WindowInfo[]; landed: WindowInfo | null }> {
    const full = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file
    if (!path.isAbsolute(full)) throw new Error('give the full path of the file')
    const st = fs.statSync(full, { throwIfNoEntry: false })
    if (!st?.isFile()) throw new Error(`${full} is not a file`)
    if ((st.mode & 0o111) !== 0 || RUNNABLE.test(full))
      throw new Error('only documents open, never programs or scripts')
    return this.landing(() => this.openDoc(full, app))
  }

  /** Runs `open`, then answers the windows once it had a moment to land, and the one that changed. */
  private async landing(
    open: () => Promise<void>,
  ): Promise<{ windows: WindowInfo[]; landed: WindowInfo | null }> {
    const before = new Set((await this.windows()).map((w) => `${w.windowId}:${w.title}`))
    await open()
    let windows: WindowInfo[] = []
    for (let i = 0; i < 10; i++) {
      await sleep(300)
      windows = await this.windows()
      const landed = windows.find((w) => !before.has(`${w.windowId}:${w.title}`))
      if (landed) return { windows, landed }
    }
    return { windows, landed: null }
  }

  async read(
    windowId: number,
    opts: { query?: string; screenshot?: boolean } = {},
  ): Promise<Snapshot> {
    const win = (await this.windows()).find((w) => w.windowId === windowId)
    if (!win) throw new Error(`window ${windowId} is not on screen any more`)
    const r = await this.call('get_window_state', {
      pid: win.pid,
      window_id: windowId,
      include_screenshot: opts.screenshot === true,
      timeout_ms: 5000,
      max_image_dimension: 1280,
      ...(opts.query ? { query: opts.query } : {}),
    })
    const sc = r.result?.structuredContent ?? {}
    const tree = String(sc.tree_markdown ?? '')
      .replace(/,?\b(showmenu|scrolltovisible|raise|cancel)\b/g, '')
      .replace(/\[actions=\[,?/g, '[')
      .replace(/ \[\]/g, '')
    const lines = new Map<number, string>()
    for (const line of tree.split('\n')) {
      const m = /^\s*- \[(\d+)\] (.*)$/.exec(line)
      if (m) lines.set(Number(m[1]), m[2]!)
    }
    const controls = new Map<number, Control>()
    for (const raw of Array.isArray(sc.elements) ? sc.elements : []) {
      const e = ElementSchema.safeParse(raw)
      if (!e.success) continue
      const ref = e.data.element_index
      controls.set(ref, {
        ref,
        token: e.data.element_token ?? null,
        role: e.data.role,
        label: e.data.label ?? '',
        line: lines.get(ref) ?? `${e.data.role} ${e.data.label ?? ''}`.trim(),
        frame: e.data.frame ?? null,
      })
    }
    const png = (r.result?.content ?? []).find((b) => b.type === 'image' && b.data)
    const snap: Snapshot = {
      windowId,
      pid: win.pid,
      app: typeof sc.app_name === 'string' ? sc.app_name : win.app,
      title: typeof sc.window_title === 'string' ? sc.window_title : win.title,
      tree,
      controls,
      truncated: sc.truncated === true,
      image: png?.data ? Buffer.from(png.data, 'base64') : null,
    }
    this.latest.set(windowId, snap)
    return snap
  }

  /** The latest read of a window, for refs; null before the first read. */
  last(windowId: number): Snapshot | null {
    return this.latest.get(windowId) ?? null
  }

  /**
   * Brings the window forward (live and walk only: Isaac asked to watch). Best effort: cua-driver
   * fails it when it cannot verify the exact window is the front one even though the app activated
   * and took focus (seen with Calculator under the overlay, 2026-11-06), and a run must not end over
   * where a window sits. Answers whether the driver confirmed it.
   */
  async front(windowId: number): Promise<boolean> {
    const win = (await this.windows()).find((w) => w.windowId === windowId)
    if (!win) return false
    return this.call('bring_to_front', { pid: win.pid, window_id: windowId }).then(
      () => true,
      () => false,
    )
  }

  /**
   * A picture of the window as WindowServer draws it, and where it sits on screen. Not a
   * cua-driver capture: that would stale the refs of the latest read, and it squeezes a window
   * with an attached child into the window's frame (`Shot`).
   */
  async shot(win: WindowInfo | number): Promise<Shot> {
    const w = typeof win === 'number' ? (await this.windows()).find((x) => x.windowId === win) : win
    if (!w) throw new Error(`window ${String(win)} is not on screen any more`)
    const [image, app] = await Promise.all([
      this.screen.picture(w.windowId),
      this.screen.app(w.pid).catch(() => null),
    ])
    const size = pngSize(image)
    const others = (app?.windows ?? []).filter((o) => o.windowId !== w.windowId)
    return {
      windowId: w.windowId,
      pid: w.pid,
      app: w.app,
      image,
      width: size.width,
      height: size.height,
      bounds: w.bounds,
      ...pictureFrame(
        w.bounds,
        others.map((o) => o.bounds),
        size,
      ),
    }
  }

  /**
   * Clicks a pixel of `shot` (vision: the window has no control to press there) at its point in
   * the window. cua-driver takes pixels only after a capture of its own on this connection, and
   * reads them as the window's points scaled to that capture's size (even when its picture
   * squeezed an attached child in: Calculator's tip, 2026-11-06), so it captures first and the
   * point is scaled to it; that capture stales the refs of the latest read. Posted to the app in the
   * background, without the mouse; cua-driver refuses that for windows it cannot resolve (Bambu
   * Studio's), and with `inFront` (live: the window is in front, Isaac watching) the refusal
   * becomes a real click in front, where such windows take it. A refusal delivered nothing, so the
   * second try never clicks twice. Answers how it clicked.
   */
  async clickAt(
    shot: Shot,
    x: number,
    y: number,
    type: 'click' | 'double_click' | 'right_click',
    inFront: boolean,
  ): Promise<'background' | 'in front'> {
    const ctx = await this.call('get_window_state', {
      pid: shot.pid,
      window_id: shot.windowId,
      include_accessibility_tree: false,
    })
    const sc = ctx.result?.structuredContent ?? {}
    const ratio =
      typeof sc.screenshot_width === 'number' && sc.screenshot_width > 0
        ? sc.screenshot_width / shot.bounds.w
        : shot.scale
    const at = toScreen(shot, x, y)
    const args = {
      pid: shot.pid,
      window_id: shot.windowId,
      x: Math.round((at.x - shot.bounds.x) * ratio),
      y: Math.round((at.y - shot.bounds.y) * ratio),
      ...(type === 'double_click' ? { count: 2 } : {}),
      ...(type === 'right_click' ? { button: 'right' } : {}),
    }
    const r = await this.driver.call('click', args)
    if (!failed(r)) return 'background'
    const why = `${textOf(r)} ${JSON.stringify(r.result?.structuredContent ?? {})}`
    if (!inFront || !REFUSED.test(why)) throw new Error(`click: ${why.slice(0, 300)}`)
    await this.call('click', { ...args, delivery_mode: 'foreground' })
    return 'in front'
  }

  /**
   * What a key press should change: the app's windows (a panel opening or closing) and the
   * picture. The picture comes from WindowServer, not cua-driver: a cua-driver capture is a new
   * snapshot and stales the refs the rest of the batch uses.
   */
  private async look(
    into: WindowInfo,
  ): Promise<{ windows: string; image: Buffer | null; gone: boolean }> {
    const stack = (await this.screen.app(into.pid).catch(() => null))?.windows ?? []
    const windows = stack.map((w) => `${w.windowId}@${w.layer}`).join('|')
    const gone = stack.length > 0 && !stack.some((w) => w.windowId === into.windowId)
    const image = gone ? null : await this.screen.picture(into.windowId).catch(() => null)
    return { windows, image, gone }
  }

  /**
   * A key or chord, sent where Isaac would see it land: the panel in front of the window when one
   * is up (`keyWindow`: Quick Look over Finder), else the window, posted in the background to that
   * exact window as before. With `inFront` (live) the app comes forward first unless it is the
   * frontmost app already (raising the window again would take the keys from its panel), and when
   * cua-driver refuses the exact post because the app has a second window
   * (`same_pid_keyboard_ambiguity`: the Quick Look panel, 2026-11-06, which is why Down and Right
   * never stepped it), the key goes to the app itself, whose key window in front (the panel) takes
   * it. Headless keeps the refusal: it must not type into a window Isaac may be using. Answers
   * where it went and whether anything changed after.
   */
  private async press(windowId: number, step: Step, inFront: boolean): Promise<string> {
    const named = (await this.windows()).find((w) => w.windowId === windowId)
    if (!named) throw new Error(`window ${windowId} is not on screen any more`)
    let app = await this.screen.app(named.pid).catch(() => null)
    if (inFront && !app?.front) {
      await this.front(windowId)
      // Panels float only while their app is active: look again now that it is.
      app = await this.screen.app(named.pid).catch(() => app)
    }
    const into = keyWindow(app?.windows ?? [], named)
    const before = await this.look(into)
    const tool = step.type === 'key' ? 'press_key' : 'hotkey'
    const keys =
      step.type === 'key'
        ? { key: step.key, ...(step.modifiers ? { modifiers: step.modifiers } : {}) }
        : { keys: step.keys }
    const r = await this.driver.call(tool, { pid: into.pid, window_id: into.windowId, ...keys })
    let toApp = false
    if (failed(r)) {
      const why = `${textOf(r)} ${JSON.stringify(r.result?.structuredContent ?? {})}`
      if (!inFront || !AMBIGUOUS.test(why)) throw new Error(`${tool}: ${why.slice(0, 300)}`)
      await this.call(tool, { pid: into.pid, ...keys })
      toApp = true
    }
    await sleep(KEY_SETTLE_MS)
    const after = await this.look(into)
    const where =
      into.windowId !== windowId
        ? `sent to the ${into.app} panel in front of it (window_id=${into.windowId})`
        : toApp
          ? `sent to ${into.app}'s window in front`
          : ''
    const changed =
      before.windows !== after.windows || after.gone
        ? 'the windows changed'
        : before.image && after.image
          ? before.image.equals(after.image)
            ? 'NOTHING CHANGED on screen after it: the key did not land or did nothing'
            : 'the window changed'
          : 'could not check the window after it'
    return [where, changed].filter(Boolean).join('; ')
  }

  /**
   * Runs one step against the window's latest read; throws with the reason on failure. Answers a
   * note for the log when there is one (keys: where they went and whether the window changed).
   * `inFront`: live, the window is in front and Isaac is watching.
   */
  async act(windowId: number, step: Step, opts: { inFront?: boolean } = {}): Promise<string> {
    const snap = this.latest.get(windowId)
    if (!snap) throw new Error(`read window ${windowId} first`)
    const target = { pid: snap.pid, window_id: windowId }
    const token = (): string => {
      const c = step.ref === undefined ? undefined : snap.controls.get(step.ref)
      if (!c?.token) throw new Error(`ref ${String(step.ref)} is not a control in the latest read`)
      return c.token
    }
    switch (step.type) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        const t = clickTarget(step, snap)
        if (t.kind === 'error') throw new Error(t.why)
        if (t.kind === 'vision')
          throw new Error(`“${t.target}” is not a control: find it in the picture`)
        await this.call(step.type, { ...target, element_token: t.control.token })
        return ''
      }
      case 'type':
        if (step.text === undefined) throw new Error('type needs text')
        await this.call(
          'type_text',
          step.ref !== undefined
            ? { pid: snap.pid, element_token: token(), text: step.text }
            : { ...target, text: step.text },
        )
        return ''
      case 'set_value':
        if (step.text === undefined) throw new Error('set_value needs text')
        await this.call('set_value', { pid: snap.pid, element_token: token(), value: step.text })
        return ''
      case 'key':
        if (!step.key) throw new Error('key needs key')
        return this.press(windowId, step, opts.inFront === true)
      case 'hotkey':
        if (!step.keys?.length) throw new Error('hotkey needs keys')
        return this.press(windowId, step, opts.inFront === true)
      case 'menu':
        if (!step.path?.length) throw new Error('menu needs path')
        await this.call('invoke_menu', { ...target, path: step.path })
        return ''
      case 'scroll':
        await this.call('scroll', {
          ...target,
          direction: step.direction ?? 'down',
          amount: step.amount ?? 3,
          ...(step.ref !== undefined ? { element_token: token() } : {}),
        })
        return ''
      case 'wait':
        await sleep(Math.min(Math.max(step.ms ?? 500, 0), 5000))
        return ''
    }
  }
}

/** A key's effect has a moment to show (Quick Look slides to the next file). */
const KEY_SETTLE_MS = 350
/** `screencapture` writes its picture to a file; one per call, removed after reading. */
let pictureN = 0
/** cua-driver's refusal of a background pixel click it cannot deliver (an unresolved window). */
const REFUSED = /refus|unresolved|foreground/i
/** cua-driver's refusal of a key that could land in another window of the same app. */
const AMBIGUOUS = /same_pid_keyboard_ambiguity/

const LayeredSchema = z.object({
  kCGWindowNumber: z.number(),
  kCGWindowOwnerPID: z.number(),
  kCGWindowLayer: z.number(),
  kCGWindowName: z.string().catch(''),
  kCGWindowBounds: z.object({
    X: z.number(),
    Y: z.number(),
    Width: z.number(),
    Height: z.number(),
  }),
})

/** JXA over AppKit and CoreGraphics: the frontmost app and every on-screen window (~0.1 s). */
const SCREEN_JXA =
  'ObjC.import("CoreGraphics"); ObjC.import("AppKit"); JSON.stringify({front: $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, windows: ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)))})'

const ScreenSchema = z.object({
  front: z.number().nullable().catch(null),
  windows: z.array(z.unknown()).catch([]),
})

/** What WindowServer says about one app: is it frontmost, and its windows at every level. */
export interface AppWindows {
  front: boolean
  /** Front to back; real windows only (below the status bar level, bigger than a sliver). */
  windows: Layered[]
}

/** WindowServer, asked directly: what cua-driver does not list, and pictures without snapshots. */
export interface Screen {
  app(pid: number): Promise<AppWindows>
  /** A PNG of one window by id (panels too); same content, same bytes. */
  picture(windowId: number): Promise<Buffer>
}

const run = (bin: string, args: string[]): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  execFile(bin, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
    err ? reject(err) : resolve(stdout),
  )
  return promise
}

/**
 * The Mac's WindowServer: `osascript` (JXA over AppKit and CoreGraphics, ~0.1 s) for the frontmost
 * app and every window at every level (cua-driver lists level 0 only, and Quick Look floats at
 * level 3 while Finder is active), `screencapture -l` for a window's picture (~0.1 s). Both run as
 * Relay's children, under its Screen Recording grant.
 */
export const MAC_SCREEN: Screen = {
  async app(pid) {
    const screen = ScreenSchema.parse(
      JSON.parse(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCREEN_JXA])),
    )
    const windows = screen.windows.flatMap((raw) => {
      const w = LayeredSchema.safeParse(raw)
      if (!w.success || w.data.kCGWindowOwnerPID !== pid) return []
      const b = w.data.kCGWindowBounds
      if (w.data.kCGWindowLayer < 0 || w.data.kCGWindowLayer >= 25) return []
      if (b.Width <= 80 || b.Height <= 60) return []
      return [
        {
          windowId: w.data.kCGWindowNumber,
          pid,
          layer: w.data.kCGWindowLayer,
          title: w.data.kCGWindowName,
          bounds: { x: b.X, y: b.Y, w: b.Width, h: b.Height },
        },
      ]
    })
    return { front: screen.front === pid, windows }
  },
  async picture(windowId) {
    const file = path.join(os.tmpdir(), `relay-computer-${process.pid}-${++pictureN}.png`)
    try {
      await run('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), '-t', 'png', file])
      return await fs.promises.readFile(file)
    } finally {
      fs.rmSync(file, { force: true })
    }
  },
}

/** Width and height from a PNG's IHDR. */
function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('the window picture is not a PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** Links the agent may open: web pages and the app links Isaac's tools use. */
export const URL_SCHEMES: Record<string, true> = {
  https: true,
  http: true,
  linear: true,
  'x-apple.systempreferences': true,
}

/** Files `open_file` refuses even when not executable: they run or install something when opened. */
const RUNNABLE =
  /\.(app|command|sh|bash|zsh|fish|tool|terminal|scpt|scptd|applescript|workflow|action|pkg|mpkg|dmg|jar|py|rb|pl|js|mjs|cjs|ts|exe|bin|webloc|inetloc|fileloc)$/i

/** `open -g`: the Dock's reopen event, a link or a document, without activating the app. */
export function openInBackground(
  target: string,
  kind: 'app' | 'url' | 'file' = 'app',
  app?: string,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const args =
    kind === 'url'
      ? ['-g', target]
      : kind === 'file'
        ? ['-g', ...(app ? ['-a', app] : []), target]
        : ['-g', /^[\w-]+(\.[\w-]+){2,}$/.test(target) ? '-b' : '-a', target]
  execFile('/usr/bin/open', args, () => resolve())
  return promise
}
