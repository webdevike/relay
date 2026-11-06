import { execFile } from 'node:child_process'
import { z } from 'zod'
import { failed, textOf, type Driver, type Reply } from './driver'

/** One on-screen window as cua-driver lists it; `bounds` in global points, top-left origin. */
export interface WindowInfo {
  windowId: number
  pid: number
  app: string
  title: string
  bounds: Frame
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
})
export type Step = z.infer<typeof StepSchema>

const WindowSchema = z.object({
  app_name: z.string(),
  title: z.string().catch(''),
  pid: z.number(),
  window_id: z.number(),
  is_on_screen: z.boolean().catch(false),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
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
  const what = control ? `“${control.label || control.role.replace(/^AX/, '')}”` : ''
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
 * Background desktop control over cua-driver: windows, reads as numbered refs, and batches of
 * actions against those refs. Nothing here fronts a window except `front()`.
 */
export class Desktop {
  private latest = new Map<number, Snapshot>()

  constructor(
    private driver: Driver,
    private reopen: (app: string) => Promise<void> = (app) => openInBackground(app),
  ) {}

  get backend(): string {
    return this.driver.backend
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Reply> {
    const r = await this.driver.call(name, args)
    if (failed(r)) throw new Error(`${name}: ${textOf(r).slice(0, 300)}`)
    return r
  }

  /** On-screen, real-sized windows. */
  async windows(): Promise<WindowInfo[]> {
    const r = await this.call('list_windows', {})
    const raw = r.result?.structuredContent?.windows
    const list = Array.isArray(raw) ? raw : []
    return list.flatMap((w) => {
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
        },
      ]
    })
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

  async read(windowId: number, opts: { query?: string; screenshot?: boolean } = {}): Promise<Snapshot> {
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

  /** Brings the window forward (live and walk only: Isaac asked to watch). */
  async front(windowId: number): Promise<void> {
    const win = (await this.windows()).find((w) => w.windowId === windowId)
    if (!win) return
    await this.call('bring_to_front', { pid: win.pid, window_id: windowId })
  }

  /** Runs one step against the window's latest read; throws with the reason on failure. */
  async act(windowId: number, step: Step): Promise<void> {
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
      case 'right_click':
        await this.call(step.type, { ...target, element_token: token() })
        return
      case 'type':
        if (step.text === undefined) throw new Error('type needs text')
        await this.call(
          'type_text',
          step.ref !== undefined
            ? { pid: snap.pid, element_token: token(), text: step.text }
            : { ...target, text: step.text },
        )
        return
      case 'set_value':
        if (step.text === undefined) throw new Error('set_value needs text')
        await this.call('set_value', { pid: snap.pid, element_token: token(), value: step.text })
        return
      case 'key':
        if (!step.key) throw new Error('key needs key')
        await this.call('press_key', {
          ...target,
          key: step.key,
          ...(step.modifiers ? { modifiers: step.modifiers } : {}),
        })
        return
      case 'hotkey':
        if (!step.keys?.length) throw new Error('hotkey needs keys')
        await this.call('hotkey', { ...target, keys: step.keys })
        return
      case 'menu':
        if (!step.path?.length) throw new Error('menu needs path')
        await this.call('invoke_menu', { ...target, path: step.path })
        return
      case 'scroll':
        await this.call('scroll', {
          ...target,
          direction: step.direction ?? 'down',
          amount: step.amount ?? 3,
          ...(step.ref !== undefined ? { element_token: token() } : {}),
        })
        return
      case 'wait':
        await sleep(Math.min(Math.max(step.ms ?? 500, 0), 5000))
        return
    }
  }
}

/** `open -g`: the Dock's reopen event without activating the app. */
export function openInBackground(app: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const byBundle = /^[\w-]+(\.[\w-]+){2,}$/.test(app)
  execFile('/usr/bin/open', ['-g', byBundle ? '-b' : '-a', app], () => resolve())
  return promise
}
