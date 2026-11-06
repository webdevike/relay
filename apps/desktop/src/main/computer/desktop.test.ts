import { describe, expect, it } from 'vitest'
import {
  clickTarget,
  Desktop,
  drawnOnly,
  keyWindow,
  pictureFrame,
  type Layered,
  type Screen,
  type Snapshot,
  type WindowInfo,
} from './desktop'
import type { Driver } from './driver'

const win = (id: number, title: string) => ({
  window_id: id,
  pid: 7,
  app_name: 'Linear',
  title,
  is_on_screen: true,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
})

function fakeDriver(titles: () => string): Driver {
  return {
    backend: 'direct',
    close() {},
    async call(name) {
      if (name !== 'list_windows') throw new Error(`unexpected ${name}`)
      return { result: { structuredContent: { windows: [win(1, titles())] } } }
    },
  }
}

describe('Desktop.openUrl', () => {
  it('opens only web and app links, never files or scripts', async () => {
    const opened: string[] = []
    const d = new Desktop(
      fakeDriver(() => 'Inbox'),
      async () => {},
      async (u) => void opened.push(u),
    )
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ssh://host',
      '/Applications/Calculator.app',
      'constructor:x',
    ]) {
      await expect(d.openUrl(bad)).rejects.toThrow(/links open/)
    }
    expect(opened).toEqual([])
  })

  it('answers the window the link retitled', async () => {
    let title = 'Inbox'
    const d = new Desktop(
      fakeDriver(() => title),
      async () => {},
      async () => {
        title = 'ENG-6810 Card art'
      },
    )
    const r = await d.openUrl('linear://ecard-systems/issue/ENG-6810')
    expect(r.landed?.title).toBe('ENG-6810 Card art')
  })
})

const control = (ref: number, role: string, label: string, token: string | null = `t${ref}`) => ({
  ref,
  token,
  role,
  label,
  line: `${role} (${label})`,
  frame: { x: 10 * ref, y: 10, w: 40, h: 20 },
})

const snapOf = (controls: ReturnType<typeof control>[]): Snapshot => ({
  windowId: 1,
  pid: 7,
  app: 'Bambu Studio',
  title: 'plate',
  tree: '',
  controls: new Map(controls.map((c) => [c.ref, c])),
  truncated: false,
  image: null,
})

describe('clickTarget: accessible control first, else the picture', () => {
  const calc = snapOf([control(1, 'AXButton', '7'), control(2, 'AXButton', 'Equals')])

  it('takes the ref, or the control labelled exactly like the target', () => {
    expect(clickTarget({ type: 'click', ref: 2 }, calc)).toMatchObject({
      kind: 'ax',
      control: { ref: 2 },
    })
    expect(clickTarget({ type: 'click', target: 'equals' }, calc)).toMatchObject({
      kind: 'ax',
      control: { ref: 2 },
    })
  })

  it('falls back to the picture when no control carries the target', () => {
    expect(clickTarget({ type: 'click', target: 'Slice plate' }, calc)).toEqual({
      kind: 'vision',
      target: 'Slice plate',
    })
    // A stale ref with a target still has somewhere to go.
    expect(clickTarget({ type: 'click', ref: 9, target: 'Slice plate' }, calc).kind).toBe('vision')
  })

  it('is an error with neither a live ref nor a target', () => {
    expect(clickTarget({ type: 'click', ref: 9 }, calc).kind).toBe('error')
    expect(clickTarget({ type: 'click' }, calc).kind).toBe('error')
  })

  it('never matches a target to window chrome, menus or a control without a token', () => {
    const chrome = snapOf([
      control(1, 'AXWindow', 'Print plate'),
      control(2, 'AXMenuItem', 'Print plate'),
      control(3, 'AXButton', 'Print plate', null),
    ])
    expect(clickTarget({ type: 'click', target: 'Print plate' }, chrome).kind).toBe('vision')
  })
})

describe('drawnOnly', () => {
  it('is true for an empty tree or one with only the menu bar and window chrome', () => {
    expect(drawnOnly(snapOf([]))).toBe(true)
    expect(
      drawnOnly(
        snapOf([
          control(1, 'AXWindow', 'plate'),
          control(2, 'AXMenuBarItem', 'File'),
          { ...control(3, 'AXButton', ''), line: 'AXButton [id=_XCUI:CloseWindow]' },
        ]),
      ),
    ).toBe(true)
  })

  it('is false once one real control is there', () => {
    expect(drawnOnly(snapOf([control(1, 'AXButton', 'Slice plate')]))).toBe(false)
  })
})

const finder: WindowInfo = {
  windowId: 10,
  pid: 5,
  app: 'Finder',
  title: 'assembly',
  bounds: { x: 100, y: 100, w: 600, h: 400 },
  z: 3,
}

const layer = (windowId: number, level: number, title: string, pid = 5): Layered => ({
  windowId,
  pid,
  layer: level,
  title,
  bounds: { x: 0, y: 0, w: 500, h: 400 },
})

describe('pictureFrame', () => {
  const calc = { x: 1470, y: 539, w: 230, h: 408 }

  it('maps a picture of just the window, at any pixel density', () => {
    expect(pictureFrame(calc, [], { width: 230, height: 408 })).toEqual({
      origin: { x: 1470, y: 539 },
      scale: 1,
    })
    expect(pictureFrame(calc, [], { width: 460, height: 816 }).scale).toBe(2)
  })

  it('maps a picture that includes an attached child (Calculator with its tip above it)', () => {
    const tip = { x: 1440, y: 446, w: 468, h: 101 }
    const elsewhere = { x: 0, y: 0, w: 300, h: 200 }
    expect(pictureFrame(calc, [elsewhere, tip], { width: 468, height: 501 })).toEqual({
      origin: { x: 1440, y: 446 },
      scale: 1,
    })
  })
})

describe('keyWindow', () => {
  it('sends keys to the Quick Look panel floating over the Finder window', () => {
    expect(keyWindow([layer(11, 3, ''), layer(10, 0, 'assembly')], finder)).toMatchObject({
      windowId: 11,
      pid: 5,
      app: 'Finder',
    })
  })

  it('keeps the named window when a normal-level window of the app or a panel behind it is in front', () => {
    expect(keyWindow([layer(13, 0, 'Downloads'), layer(10, 0, 'assembly')], finder)).toBe(finder)
    // Calculator's invisible untitled helper over its window is not a panel.
    expect(keyWindow([layer(11, 0, ''), layer(10, 0, 'assembly')], finder)).toBe(finder)
    expect(keyWindow([layer(10, 0, 'assembly'), layer(11, 3, '')], finder)).toBe(finder)
    expect(keyWindow([layer(20, 3, '', 8), layer(10, 0, 'assembly')], finder)).toBe(finder)
    expect(keyWindow([], finder)).toBe(finder)
  })
})

/** A PNG header with the given size and a body byte that stands for what the window shows. */
const png = (w: number, h: number, look: number): Buffer => {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[32] = look
  return b
}

/**
 * Finder like on 2026-11-06: cua-driver lists only the browser window; Quick Look floats at level
 * 3 once Space opened it; a key posted to an exact window while the panel is up is refused as
 * ambiguous, a key posted to the app reaches the panel and steps it to the next picture. Finder is
 * in front once Quick Look is up (or once fronted).
 */
function finderWithQuickLook(panelUp: boolean) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let panel = panelUp
  let front = panelUp
  let shown = 1
  let snapshot = 0
  const ok = { result: { structuredContent: {} } }
  const driver: Driver = {
    backend: 'direct',
    close() {},
    async call(name, args) {
      calls.push({ name, args })
      if (name === 'list_windows')
        return {
          result: {
            structuredContent: {
              windows: [
                {
                  window_id: 10,
                  pid: 5,
                  app_name: 'Finder',
                  title: 'assembly',
                  is_on_screen: true,
                  z_index: 3,
                  bounds: { x: 100, y: 100, width: 600, height: 400 },
                },
              ],
            },
          },
        }
      // Every capture is a new snapshot and stales the tokens of the one before (cua-driver).
      if (name === 'get_window_state') {
        snapshot++
        return {
          result: {
            content: [{ type: 'image', data: png(600, 400, 0).toString('base64') }],
            structuredContent: {
              tree_markdown: '- [1] AXRow (step01.png)',
              elements: [
                {
                  element_index: 1,
                  element_token: `s${snapshot}:1`,
                  role: 'AXRow',
                  label: 'step01.png',
                },
              ],
            },
          },
        }
      }
      if (name === 'click' && args.element_token !== `s${snapshot}:1`)
        return {
          result: { isError: true, content: [{ type: 'text', text: 'element_token is stale' }] },
        }
      if (name === 'bring_to_front') front = true
      if (name === 'press_key') {
        if (panel && args.window_id !== undefined)
          return {
            result: {
              isError: true,
              content: [{ type: 'text', text: 'refused' }],
              structuredContent: { code: 'same_pid_keyboard_ambiguity', effect: 'refused' },
            },
          }
        if (args.key === 'space') panel = !panel
        else if (panel) shown++
      }
      return ok
    },
  }
  const screen: Screen = {
    app: async () => ({
      front,
      windows: panel ? [layer(11, 3, ''), layer(10, 0, 'assembly')] : [layer(10, 0, 'assembly')],
    }),
    picture: async (id) => png(600, 400, id === 11 ? shown : 0),
  }
  return {
    desktop: new Desktop(
      driver,
      async () => {},
      async () => {},
      async () => {},
      screen,
    ),
    calls,
  }
}

describe('Desktop keys', () => {
  it('live: Space opens Quick Look and says the windows changed', async () => {
    const { desktop, calls } = finderWithQuickLook(false)
    await desktop.read(10)
    const note = await desktop.act(10, { type: 'key', key: 'space' }, { inFront: true })
    expect(calls.find((c) => c.name === 'bring_to_front')?.args).toMatchObject({ window_id: 10 })
    expect(calls.find((c) => c.name === 'press_key')?.args).toMatchObject({
      pid: 5,
      window_id: 10,
      key: 'space',
    })
    expect(note).toBe('the windows changed')
  })

  it('live: Down with Quick Look up reaches the panel through the app and steps it', async () => {
    const { desktop, calls } = finderWithQuickLook(true)
    await desktop.read(10)
    const note = await desktop.act(10, { type: 'key', key: 'down' }, { inFront: true })
    const presses = calls.filter((c) => c.name === 'press_key').map((c) => c.args)
    // Finder is in front already: raising its window again would take the keys from the panel.
    expect(calls.some((c) => c.name === 'bring_to_front')).toBe(false)
    // The exact post to the panel is refused as ambiguous; the app takes it instead.
    expect(presses).toEqual([
      { pid: 5, window_id: 11, key: 'down' },
      { pid: 5, key: 'down' },
    ])
    expect(note).toMatch(/panel in front of it \(window_id=11\)/)
    expect(note).toMatch(/the window changed/)
  })

  it('headless: never fronts and never posts to the app past the refusal', async () => {
    const { desktop, calls } = finderWithQuickLook(true)
    await desktop.read(10)
    await expect(desktop.act(10, { type: 'key', key: 'down' })).rejects.toThrow(
      /same_pid_keyboard_ambiguity/,
    )
    expect(calls.some((c) => c.name === 'bring_to_front')).toBe(false)
    expect(calls.filter((c) => c.name === 'press_key')).toHaveLength(1)
  })

  it('keeps the refs of the batch alive: a key checks the window without a cua-driver capture', async () => {
    const { desktop } = finderWithQuickLook(false)
    await desktop.read(10)
    await desktop.act(10, { type: 'key', key: 'space' }, { inFront: true })
    await expect(desktop.act(10, { type: 'click', ref: 1 })).resolves.toBe('')
  })

  it('says NOTHING CHANGED when the window looks the same after the key', async () => {
    const { desktop } = finderWithQuickLook(false)
    await desktop.read(10)
    expect(await desktop.act(10, { type: 'key', key: 'down' }, { inFront: true })).toMatch(
      /NOTHING CHANGED/,
    )
  })
})
