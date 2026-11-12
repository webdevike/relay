import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PickBox, PickResult } from './annotate-picker'
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
  /** While set, the next init waits for it (and fails when it rejects). */
  let initGate: Promise<void> | null = null
  let previewAnswer: 'ok' | 'missing' | 'rejected' = 'ok'
  const elements = new Map<string, InspectedElement | null>()
  const answer = (): OverlayAnswer => ({ ready, selectors, sig })
  /** The picker's open pick (annotate-picker.ts, mode design), answered by the test. */
  let open: PromiseWithResolvers<PickResult> | null = null
  const page: DesignPage = {
    overlay: async (cmd: OverlayCommand) => {
      calls.push(cmd.op === 'visible' ? `visible:${cmd.on}` : cmd.op)
      if (cmd.op === 'init') {
        const gate = initGate
        initGate = null
        if (gate) await gate
        ready = true
      }
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
      return previewAnswer
    },
    settle: async () => {
      calls.push('settle')
    },
    capture: async (rect) => {
      calls.push(`capture:${rect.x},${rect.y},${rect.width},${rect.height}`)
      return { png: 'iVBOR', width: rect.width, height: rect.height }
    },
    pick: async (op) => {
      calls.push(op.op === 'clear' ? 'picker:clear' : `picker:${op.mode}`)
      // A new pick or a clear closes the open one, which answers cancelled.
      open?.resolve({ cancelled: true })
      open = null
      if (op.op === 'clear') return { cancelled: true }
      open = Promise.withResolvers<PickResult>()
      return open.promise
    },
  }
  /** Answers the open pick once Design Mode has one open. */
  const answerPick = async (r: PickResult | Error): Promise<void> => {
    await vi.waitFor(() => expect(open).not.toBeNull())
    const p = open!
    open = null
    if (r instanceof Error) p.reject(r)
    else p.resolve(r)
  }
  return {
    page,
    calls,
    elements,
    answerPick,
    isPicking: () => open !== null,
    setSig: (next: string) => (sig = next),
    dropDocument: () => (ready = false),
    holdInit: (gate: Promise<void>) => (initGate = gate),
    answerPreview: (a: 'ok' | 'missing' | 'rejected') => (previewAnswer = a),
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
  let intercept: (tabId: string, input: never) => boolean = () => false
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
    5,
  )
  const viewport = { width: 1000, height: 800 }
  /** Isaac's click on element `#e<x>` (the fake overlay names what is at x so). */
  const click = (x: number, shift = false) =>
    p.answerPick({
      cancelled: false,
      element: { tag: 'button' },
      box: { x, y: 0, w: 10, h: 10 },
      viewport,
      shift,
      at: { x, y: 0 },
    })
  const drag = (box: PickBox, shift = false) =>
    p.answerPick({
      cancelled: false,
      box,
      viewport,
      shift,
      at: { x: box.x + box.w, y: box.y + box.h },
    })
  const key = (k: string, type = 'keyDown', shift = false, meta = false) =>
    intercept('t1', {
      type,
      key: k,
      code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
      shift,
      meta,
      control: false,
      alt: false,
    } as never)
  const selection = (n: number) =>
    (events[n]!.payload['items'] as Array<{ selector: string }>).map((i) => i.selector)
  const settled = () => vi.waitFor(() => expect(events.length).toBeGreaterThan(0))
  return {
    design,
    p,
    wc,
    events,
    click,
    drag,
    key,
    selection,
    close: (id: string) => closed({ id }),
    settled,
  }
}

describe('DesignMode', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }))
  afterEach(() => vi.useRealTimers())

  it('keeps keys from the page only while it is on, Relay shortcuts pass; the picker takes the pointer', async () => {
    const t = setup()
    expect(t.key('a')).toBe(false)
    await t.design.set('t1', true)
    await vi.waitFor(() => expect(t.p.isPicking()).toBe(true))
    expect(t.p.calls).toContain('picker:design')
    expect(t.key('a')).toBe(true)
    // Paste never reaches the page; Cmd+L (Relay's address field) goes on to BrowserHost.
    expect(t.key('v', 'keyDown', false, true)).toBe(true)
    expect(t.key('l', 'keyDown', false, true)).toBe(false)
    await t.design.set('t1', false)
    expect(t.key('a')).toBe(false)
    expect(t.p.calls).toContain('destroy')
    // The picker closed with it, and no new pick opens.
    expect(t.p.calls.at(-1)).toBe('picker:clear')
    expect(t.p.isPicking()).toBe(false)
  })

  it('Escape in the page asks to end the mode and never reaches the page', async () => {
    const t = setup()
    await t.design.set('t1', true)
    expect(t.key('Escape')).toBe(true)
    expect(t.events).toEqual([
      { channel: 'design.exit', payload: { tabId: 't1', reason: 'escape' } },
    ])
  })

  it('a click picks and sends the element with its crop taken with the outlines hidden', async () => {
    const t = setup()
    await t.design.set('t1', true)
    await t.click(1)
    await t.settled()
    const [e] = t.events
    expect(e!.channel).toBe('design.selection')
    expect(e!.payload['reason']).toBe('pick')
    const items = e!.payload['items'] as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'element',
      selector: '#e1',
      missing: false,
      source: { file: 'src/Button.tsx', line: 12 },
      component: 'Button',
      crop: { png: 'iVBOR' },
    })
    // Hidden, painted, captured with padding, shown again: the outlines are never in the crop.
    const order = t.p.calls.slice(t.p.calls.indexOf('pick') + 1).slice(0, 4)
    expect(order).toEqual(['visible:false', 'settle', 'capture:4,14,92,42', 'visible:true'])
    // The picker opens again for the next click.
    await vi.waitFor(() => expect(t.p.isPicking()).toBe(true))
  })

  it('shift-click adds and removes; a plain click replaces the selection', async () => {
    const t = setup()
    await t.design.set('t1', true)
    await t.click(1)
    await t.click(2, true)
    await t.click(3, true)
    await t.click(2, true)
    await vi.waitFor(() => expect(t.events).toHaveLength(4))
    expect(t.selection(2)).toEqual(['#e1', '#e2', '#e3'])
    expect(t.selection(3)).toEqual(['#e1', '#e3'])
    await t.click(4)
    await vi.waitFor(() => expect(t.events).toHaveLength(5))
    expect(t.selection(4)).toEqual(['#e4'])
  })

  it('a drag picks a region with its crop; Shift keeps the rest, a plain drag or click replaces it', async () => {
    const t = setup()
    await t.design.set('t1', true)
    await t.click(1)
    await t.drag({ x: 10, y: 20, w: 50, h: 40 }, true)
    await vi.waitFor(() => expect(t.events).toHaveLength(2))
    expect(t.selection(1)).toEqual(['#e1', 'region-1'])
    const region = (t.events[1]!.payload['items'] as Array<Record<string, unknown>>)[1]
    expect(region).toMatchObject({
      kind: 'region',
      label: 'Region 50x40',
      box: { x: 10, y: 20, width: 50, height: 40 },
      crop: { png: 'iVBOR' },
    })
    // The region's own pixels, unpadded.
    expect(t.p.calls).toContain('capture:10,20,50,40')
    // A Shift-click adds an element before the regions; the inspector removes the region.
    await t.click(2, true)
    await vi.waitFor(() => expect(t.events).toHaveLength(3))
    expect(t.selection(2)).toEqual(['#e1', '#e2', 'region-1'])
    await t.design.select('t1', ['#e2'])
    expect(t.selection(3)).toEqual(['#e2'])
    await t.drag({ x: 0, y: 0, w: 8, h: 8 }, true)
    await t.drag({ x: 0, y: 0, w: 9, h: 9 })
    await vi.waitFor(() => expect(t.events).toHaveLength(6))
    expect(t.selection(5)).toEqual(['region-3'])
    await t.click(5)
    await vi.waitFor(() => expect(t.events).toHaveLength(7))
    expect(t.selection(6)).toEqual(['#e5'])
  })

  it('ends when another picker takes the page, and picks again after a pick fails', async () => {
    const t = setup()
    await t.design.set('t1', true)
    // The page reloading under the pick: it fails and opens again.
    await t.p.answerPick(new Error('Execution context was destroyed'))
    await vi.waitFor(() => expect(t.p.isPicking()).toBe(true))
    expect(t.design.isOn('t1')).toBe(true)
    // A note's picker replaced it: the outlines go before the exit, and that picker stays.
    await t.p.answerPick({ cancelled: true })
    await vi.waitFor(() =>
      expect(t.events.at(-1)).toEqual({
        channel: 'design.exit',
        payload: { tabId: 't1', reason: 'escape' },
      }),
    )
    expect(t.design.isOn('t1')).toBe(false)
    expect(t.p.calls.at(-1)).toBe('destroy')
    // The renderer turns it off in answer: nothing more is sent to the page.
    await t.design.set('t1', false)
    expect(t.p.calls.at(-1)).toBe('destroy')
    expect(t.p.calls).not.toContain('picker:clear')
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
    await t.click(1)
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
    await t.click(1)
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
    // A page closing with the mode off is said too: the renderer drops its actor on it.
    t.close('t2')
    expect(t.events.at(-1)).toEqual({
      channel: 'design.exit',
      payload: { tabId: 't2', reason: 'closed' },
    })
  })

  it('a stop during a slow start waits for it, then destroys what it drew', async () => {
    const t = setup()
    const gate = Promise.withResolvers<void>()
    t.p.holdInit(gate.promise)
    const starting = t.design.set('t1', true)
    await vi.waitFor(() => expect(t.p.calls).toContain('init'))
    const stopping = t.design.set('t1', false)
    const tick = Promise.withResolvers<void>()
    setImmediate(tick.resolve)
    await tick.promise
    expect(t.p.calls).not.toContain('destroy')
    gate.resolve()
    await Promise.all([starting, stopping])
    // The start's picker opened, then went with the stop.
    expect(t.p.calls).toEqual(['init', 'picker:design', 'destroy', 'picker:clear'])
    expect(t.design.isOn('t1')).toBe(false)
  })

  it('start, stop and start again while the first start fails: the last start stays on', async () => {
    const t = setup()
    const gate = Promise.withResolvers<void>()
    t.p.holdInit(gate.promise)
    const first = t.design.set('t1', true)
    await vi.waitFor(() => expect(t.p.calls).toContain('init'))
    const stop = t.design.set('t1', false)
    const again = t.design.set('t1', true)
    gate.reject(new Error('context gone'))
    await expect(first).rejects.toMatchObject({ code: 'page-unreachable' })
    await stop
    await again
    expect(t.design.isOn('t1')).toBe(true)
    // The overlay the last start drew is the one standing: its init came after the stop.
    expect(t.p.calls.lastIndexOf('init')).toBeGreaterThan(t.p.calls.lastIndexOf('destroy'))
  })

  it('a style preview goes to the element and the selection is sent as it looks now', async () => {
    const t = setup()
    await t.design.set('t1', true)
    await t.design.style('t1', '#e1', 'padding', '8px')
    expect(t.p.calls).toContain('preview:#e1:padding:8px')
    expect(t.events.at(-1)!.payload['reason']).toBe('refresh')
  })

  it('a preview the page refuses fails with why, and sends nothing', async () => {
    const t = setup()
    await t.design.set('t1', true)
    t.p.answerPreview('rejected')
    await expect(t.design.style('t1', '#e1', 'padding', 'banana')).rejects.toMatchObject({
      code: 'style-rejected',
    })
    t.p.answerPreview('missing')
    await expect(t.design.style('t1', '#e1', 'padding', '8px')).rejects.toMatchObject({
      code: 'element-missing',
    })
    expect(t.events).toEqual([])
  })

  it('refuses work in a page where it is off, and a page that is not open', async () => {
    const t = setup()
    await expect(t.design.style('t1', '#a', 'color', 'red')).rejects.toMatchObject({
      code: 'design-off',
    })
    await expect(t.design.set('t9', true)).rejects.toMatchObject({ code: 'no-page' })
  })
})
