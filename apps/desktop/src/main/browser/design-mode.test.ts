import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageInput } from './browser-host'
import { DesignMode, type DesignContents } from './design-mode'
import type { DesignPage, InspectedElement, OverlayAnswer, OverlayCommand } from './design-page'

const el = (over: Partial<InspectedElement> = {}): InspectedElement => ({
  label: 'button.primary',
  text: 'Save',
  html: '<button class="primary">Save</button>',
  box: { x: 10, y: 20, width: 80, height: 30 },
  source: { file: 'src/Button.tsx', line: 12, column: 5, via: 'react-source' },
  component: 'Button',
  styles: { padding: '12px 16px', color: 'rgb(0, 0, 0)' },
  ...over,
})

/** A page whose overlay keeps a selection the way DESIGN_OVERLAY does. */
function fakePage() {
  const calls: string[] = []
  let selectors: string[] = []
  let sig = 'a'
  let ready = true
  const elements = new Map<string, InspectedElement | null>()
  const answer = (): OverlayAnswer => ({ ready, selectors, sig })
  const page: DesignPage = {
    overlay: async (cmd: OverlayCommand) => {
      calls.push(cmd.op === 'visible' ? `visible:${cmd.on}` : cmd.op)
      if (cmd.op === 'init') ready = true
      if (cmd.op === 'pick') {
        const at = `#e${cmd.x}`
        if (!cmd.add) selectors = [at]
        else if (selectors.includes(at)) selectors = selectors.filter((s) => s !== at)
        else selectors = [...selectors, at]
      }
      if (cmd.op === 'select') selectors = cmd.selectors
      return answer()
    },
    inspect: async (list) => ({
      width: 1000,
      height: 800,
      items: list.map((s) => (elements.has(s) ? elements.get(s)! : el())),
    }),
    preview: async (selector, property, value) => {
      calls.push(`preview:${selector}:${property}:${value}`)
    },
    settle: async () => {
      calls.push('settle')
    },
    capture: async (rect) => {
      calls.push(`capture:${rect.x},${rect.y},${rect.width},${rect.height}`)
      return { png: 'iVBOR', width: rect.width, height: rect.height }
    },
  }
  return {
    page,
    calls,
    elements,
    setSig: (next: string) => (sig = next),
    dropDocument: () => (ready = false),
  }
}

function fakeContents(url: string) {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  const wc = {
    getURL: () => url,
    on: (event: string, fn: (...a: unknown[]) => void) => {
      ;(handlers[event] ??= []).push(fn)
    },
    off: (event: string, fn: (...a: unknown[]) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((f) => f !== fn)
    },
    fire: (event: string, ...args: unknown[]) => {
      for (const fn of handlers[event] ?? []) fn(...args)
    },
    count: (event: string) => (handlers[event] ?? []).length,
  }
  return wc
}

function setup(url = 'http://127.0.0.1:5173/') {
  const p = fakePage()
  const wc = fakeContents(url)
  let intercept: (tabId: string, input: PageInput) => boolean = () => false
  let closed: (tab: { id: string }) => void = () => undefined
  const events: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const design = new DesignMode(
    {
      page: () => p.page,
      contents: (id) => (id === 't1' ? (wc as unknown as DesignContents) : undefined),
      onTabClosed: (cb) => (closed = cb),
      interceptInput: (fn) => (intercept = fn),
    },
    (channel, payload) => events.push({ channel, payload: payload as Record<string, unknown> }),
    100,
  )
  // Electron's before-mouse-event has no modifiers; Shift comes from key events.
  const mouse = (type: string, x = 0, y = 0) =>
    intercept('t1', {
      kind: 'mouse',
      mouse: { type, x, y, button: 'left', clickCount: 1 } as never,
    })
  const key = (k: string, type = 'keyDown', shift = false) =>
    intercept('t1', { kind: 'key', input: { type, key: k, shift } as never })
  const settled = () => vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
  return { design, p, wc, events, mouse, key, close: (id: string) => closed({ id }), settled }
}

describe('DesignMode', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }))
  afterEach(() => vi.useRealTimers())

  it('keeps the mouse from the page only while it is on, and lets the wheel scroll', async () => {
    const t = setup()
    expect(t.mouse('mouseDown', 5, 5)).toBe(false)
    await t.design.set('t1', true)
    expect(t.mouse('mouseMove', 5, 5)).toBe(true)
    expect(t.mouse('mouseUp', 5, 5)).toBe(true)
    expect(t.mouse('mouseWheel', 5, 5)).toBe(false)
    expect(t.key('a')).toBe(false)
    await t.design.set('t1', false)
    expect(t.mouse('mouseMove', 5, 5)).toBe(false)
    expect(t.p.calls).toContain('destroy')
  })

  it('Escape in the page asks to end the mode and never reaches the page', async () => {
    const t = setup()
    await t.design.set('t1', true)
    expect(t.key('Escape')).toBe(true)
    expect(t.events).toEqual([
      { channel: 'design.exit', payload: { tabId: 't1', reason: 'escape' } },
    ])
  })

  it('a click picks and sends the element with its crop taken with the highlight hidden', async () => {
    const t = setup()
    await t.design.set('t1', true)
    t.mouse('mouseDown', 1)
    await t.settled()
    const [e] = t.events
    expect(e!.channel).toBe('design.selection')
    expect(e!.payload['reason']).toBe('pick')
    const items = e!.payload['items'] as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      selector: '#e1',
      missing: false,
      source: { file: 'src/Button.tsx', line: 12 },
      component: 'Button',
      crop: { png: 'iVBOR' },
    })
    // Hidden, painted, captured with padding, shown again: the highlight is never in the crop.
    const order = t.p.calls.slice(t.p.calls.indexOf('pick') + 1).slice(0, 4)
    expect(order).toEqual(['visible:false', 'settle', 'capture:4,14,92,42', 'visible:true'])
  })

  it('shift-click adds and removes; a plain click replaces the selection', async () => {
    const t = setup()
    await t.design.set('t1', true)
    t.mouse('mouseDown', 1)
    // Shift held while the shell has the keyboard.
    t.design.keyState({ shift: true })
    t.mouse('mouseDown', 2)
    t.mouse('mouseDown', 3)
    t.mouse('mouseDown', 2)
    await vi.waitFor(() => expect(t.events).toHaveLength(4))
    const last = (n: number) =>
      (t.events[n]!.payload['items'] as Array<{ selector: string }>).map((i) => i.selector)
    expect(last(2)).toEqual(['#e1', '#e2', '#e3'])
    expect(last(3)).toEqual(['#e1', '#e3'])
    // Shift let go while the page has the keyboard: the key still reaches the page.
    expect(t.key('Shift', 'keyUp', false)).toBe(false)
    t.mouse('mouseDown', 4)
    await vi.waitFor(() => expect(t.events).toHaveLength(5))
    expect(last(4)).toEqual(['#e4'])
  })

  it('an element that is gone stays in the selection as missing, with no crop', async () => {
    const t = setup()
    t.p.elements.set('#gone:nth-of-type(2)', null)
    await t.design.set('t1', true)
    await t.design.select('t1', ['#gone:nth-of-type(2)'])
    const items = t.events[0]!.payload['items'] as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({ missing: true, label: '#gone', crop: null, source: null })
  })

  it('clips what the page answers to the contract sizes', async () => {
    const t = setup()
    t.p.elements.set('#big', el({ html: 'x'.repeat(5000), component: 'C'.repeat(500) }))
    await t.design.set('t1', true)
    await t.design.select('t1', ['#big'])
    const item = (t.events[0]!.payload['items'] as Array<{ html: string; component: string }>)[0]!
    expect(item.html).toHaveLength(2000)
    expect(item.component).toHaveLength(200)
  })

  it('reads the selection again when the page changes it (a hot update), not otherwise', async () => {
    const t = setup()
    await t.design.set('t1', true)
    t.mouse('mouseDown', 1)
    await t.settled()
    vi.advanceTimersByTime(100)
    await Promise.resolve()
    await vi.waitFor(() => expect(t.p.calls.filter((c) => c === 'status').length).toBe(1))
    expect(t.events).toHaveLength(1)
    t.p.setSig('b')
    vi.advanceTimersByTime(100)
    await vi.waitFor(() => expect(t.events).toHaveLength(2))
    expect(t.events[1]!.payload['reason']).toBe('refresh')
  })

  it('a reload of the same site draws again and finds the selection in the new document', async () => {
    const t = setup()
    await t.design.set('t1', true)
    t.mouse('mouseDown', 1)
    await t.settled()
    t.p.dropDocument()
    t.wc.fire('did-navigate', {}, 'http://127.0.0.1:5173/')
    t.wc.fire('dom-ready')
    await vi.waitFor(() => expect(t.events).toHaveLength(2))
    expect(t.events[1]!.payload['reason']).toBe('refresh')
    const tail = t.p.calls.slice(t.p.calls.lastIndexOf('init'))
    expect(tail.slice(0, 2)).toEqual(['init', 'select'])
    expect(t.design.isOn('t1')).toBe(true)
  })

  it('going to another site or closing the tab ends the mode', async () => {
    const t = setup()
    await t.design.set('t1', true)
    t.wc.fire('did-navigate', {}, 'https://example.com/')
    expect(t.design.isOn('t1')).toBe(false)
    expect(t.wc.count('dom-ready')).toBe(0)
    expect(t.events.at(-1)).toEqual({
      channel: 'design.exit',
      payload: { tabId: 't1', reason: 'navigated' },
    })
    await t.design.set('t1', true)
    t.close('t1')
    expect(t.design.isOn('t1')).toBe(false)
    expect(t.events.at(-1)!.payload['reason']).toBe('closed')
  })

  it('a style preview goes to the element and the selection is sent as it looks now', async () => {
    const t = setup()
    await t.design.set('t1', true)
    await t.design.style('t1', '#e1', 'padding', '8px')
    expect(t.p.calls).toContain('preview:#e1:padding:8px')
    expect(t.events.at(-1)!.payload['reason']).toBe('refresh')
  })

  it('refuses work in a page where it is off, and a page that is not open', async () => {
    const t = setup()
    await expect(t.design.style('t1', '#a', 'color', 'red')).rejects.toMatchObject({
      code: 'design-off',
    })
    await expect(t.design.set('t9', true)).rejects.toMatchObject({ code: 'no-page' })
  })
})
