import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentNote } from '@evaos/contract'

vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
const handlers = new Map<string, (input: never) => unknown>()
const emitted = vi.fn()
vi.mock('../ipc/handle', () => ({
  handle: (_c: unknown, name: string, fn: (input: never) => unknown) => handlers.set(name, fn),
  emit: (_c: unknown, channel: string, payload: unknown) => emitted(channel, payload),
}))

import { captureRect, clampRegion, registerBrowserAnnotate } from './annotate'
import type { PickOp, PickResult } from './annotate-picker'

const VIEW = { width: 800, height: 600 }

describe('clampRegion', () => {
  it('rounds the box outward to whole CSS px', () => {
    expect(clampRegion({ x: 10.4, y: 20.6, w: 100.2, h: 30 }, VIEW)).toEqual({
      x: 10,
      y: 20,
      w: 101,
      h: 31,
    })
  })

  it('cuts a box that runs off the viewport', () => {
    expect(clampRegion({ x: -50, y: 550, w: 200, h: 200 }, VIEW)).toEqual({
      x: 0,
      y: 550,
      w: 150,
      h: 50,
    })
  })

  it('is empty for a box wholly off screen', () => {
    expect(clampRegion({ x: 900, y: -300, w: 50, h: 50 }, VIEW)).toEqual({
      x: 800,
      y: 0,
      w: 0,
      h: 0,
    })
  })
})

describe('captureRect', () => {
  it('pads the region inside the viewport at zoom 1', () => {
    expect(captureRect({ x: 100, y: 50, w: 200, h: 40 }, VIEW, 1)).toEqual({
      x: 92,
      y: 42,
      width: 216,
      height: 56,
    })
  })

  it('stops the padding at the viewport edges', () => {
    expect(captureRect({ x: 2, y: 0, w: 798, h: 600 }, VIEW, 1)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })
  })

  it('scales CSS px to view DIPs by the page zoom', () => {
    expect(captureRect({ x: 100, y: 100, w: 50, h: 50 }, VIEW, 1.25, 0)).toEqual({
      x: 125,
      y: 125,
      width: 63,
      height: 63,
    })
    expect(captureRect({ x: 101, y: 33, w: 10, h: 10 }, VIEW, 0.5, 0)).toEqual({
      x: 50,
      y: 16,
      width: 6,
      height: 6,
    })
  })
})

describe('browser.annotate', () => {
  let dir: string
  beforeEach(() => {
    handlers.clear()
    emitted.mockClear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos annotate '))
  })

  const setup = (pick: PickResult) => {
    const tab = {
      state: { id: 't1', url: 'https://example.com/a', title: 'Example', agent: undefined },
      scope: 'chat:/s/one.jsonl',
    }
    const capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('png-bytes'),
    }))
    // The page's webContents: navigation events come from it; `url` is what it shows.
    const nav = { url: 'https://example.com/a' }
    const wc = Object.assign(new EventEmitter(), {
      focus: vi.fn(),
      getZoomFactor: () => 1,
      getURL: () => nav.url,
      isDestroyed: () => false,
      capturePage,
    })
    const page = {
      pick: vi.fn(async (op: PickOp): Promise<PickResult> =>
        op.op === 'clear' ? { cancelled: true } : pick,
      ),
    }
    // The tab's view; a test lets go of it to see whether annotate still holds the page.
    const view: { webContents: typeof wc | null } = { webContents: wc }
    const host = {
      allTabs: () => [tab],
      driveView: () => view,
      pageControl: () => page,
    }
    const send = vi.fn(async (_note: AgentNote, _ws: string | null) => ({ sent: true, to: 'One' }))
    const ctx = {
      env: { configDir: dir },
      win: { isFocused: () => false },
      shell: { webContents: { focus: vi.fn() } },
    }
    registerBrowserAnnotate(ctx as never, host as never, send)
    const call = (name: string, input: unknown) => handlers.get(name)!(input as never)
    const ops = () => page.pick.mock.calls.map(([op]) => op.op)
    return { call, send, capturePage, page, ops, wc, nav, view, tab }
  }

  const button: Extract<PickResult, { cancelled: false }> = {
    cancelled: false,
    element: { tag: 'button', role: 'button', text: 'Buy', selector: '#buy' },
    box: { x: 10, y: 20, w: 80, h: 30 },
    viewport: VIEW,
    shift: false,
    at: { x: 50, y: 35 },
  }

  it('refuses the note once the page navigated away from its mark, and tells the shell', async () => {
    const { call, send, capturePage, wc, nav } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    nav.url = 'https://new.example/private'
    wc.emit('did-navigate')
    expect(emitted).toHaveBeenCalledWith('browser.annotateDropped', { tabId: 't1' })
    await expect(
      call('browser.annotateSend', { tabId: 't1', text: 'Make this bigger' }),
    ).rejects.toMatchObject({ code: 'page-changed' })
    expect(capturePage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    // The mark is gone, not waiting for a second try.
    await expect(call('browser.annotateSend', { tabId: 't1', text: 'x' })).rejects.toMatchObject({
      code: 'no-mark',
    })
  })

  it('drops the mark on an in-page navigation and takes it off the page', async () => {
    const { call, send, ops, wc, nav } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    // A subframe's navigation leaves the mark be.
    wc.emit('did-navigate-in-page', {}, 'https://example.com/a#frame', false)
    expect(emitted).not.toHaveBeenCalled()
    nav.url = 'https://example.com/a#later'
    wc.emit('did-navigate-in-page', {}, nav.url, true)
    expect(emitted).toHaveBeenCalledWith('browser.annotateDropped', { tabId: 't1' })
    expect(ops()).toEqual(['pick', 'clear'])
    await expect(call('browser.annotateSend', { tabId: 't1', text: 'x' })).rejects.toMatchObject({
      code: 'page-changed',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a note whose page shows another URL even without a navigation event', async () => {
    const { call, send, capturePage, nav } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    nav.url = 'https://new.example/private'
    await expect(call('browser.annotateSend', { tabId: 't1', text: 'x' })).rejects.toMatchObject({
      code: 'page-changed',
    })
    expect(capturePage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('stops listening to the page once the note is sent or dropped', async () => {
    const { call, wc } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    expect(wc.listenerCount('did-navigate')).toBe(1)
    await call('browser.annotateSend', { tabId: 't1', text: 'x' })
    expect(wc.listenerCount('did-navigate')).toBe(0)
    await call('browser.annotate', { tabId: 't1' })
    await call('browser.annotateCancel', { tabId: 't1' })
    expect(wc.listenerCount('did-navigate')).toBe(0)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0)
    expect(wc.listenerCount('destroyed')).toBe(0)
    wc.emit('did-navigate')
    expect(emitted).not.toHaveBeenCalled()
  })

  const noteFiles = () => {
    const notes = path.join(dir, 'notes')
    return fs.existsSync(notes) ? fs.readdirSync(notes) : []
  }

  it('refuses the note when the page navigates while the mark is being cleared', async () => {
    const { call, send, capturePage, page, wc, nav } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    page.pick.mockImplementationOnce(async () => {
      nav.url = 'https://new.example/private'
      wc.emit('did-navigate')
      return { cancelled: true }
    })
    await expect(call('browser.annotateSend', { tabId: 't1', text: 'x' })).rejects.toMatchObject({
      code: 'page-changed',
    })
    expect(capturePage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(noteFiles()).toEqual([])
    expect(wc.listenerCount('did-navigate')).toBe(0)
  })

  it('refuses the note and keeps no screenshot when the page navigates during the capture', async () => {
    const { call, send, capturePage, wc, nav } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    capturePage.mockImplementationOnce(async () => {
      nav.url = 'https://new.example/private'
      wc.emit('did-navigate')
      return { isEmpty: () => false, toPNG: () => Buffer.from('next-page') }
    })
    await expect(call('browser.annotateSend', { tabId: 't1', text: 'x' })).rejects.toMatchObject({
      code: 'page-changed',
    })
    expect(send).not.toHaveBeenCalled()
    expect(noteFiles()).toEqual([])
    expect(wc.listenerCount('did-navigate')).toBe(0)
    expect(wc.listenerCount('did-navigate-in-page')).toBe(0)
    expect(wc.listenerCount('destroyed')).toBe(0)
  })

  it('carries the URL and title the page had when it was marked', async () => {
    const { call, send, tab } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    // The tab's state moves on (a late title update, say); the note keeps the marked document's.
    tab.state.url = 'https://example.com/elsewhere'
    tab.state.title = 'Elsewhere'
    await call('browser.annotateSend', { tabId: 't1', text: 'x' })
    expect(send.mock.calls[0]![0]).toMatchObject({ url: 'https://example.com/a', title: 'Example' })
  })

  it('lets go of the page once it navigates or goes away, still answering page-changed', async () => {
    for (const event of ['did-navigate', 'destroyed'] as const) {
      handlers.clear()
      const { call, view } = setup(button)
      await call('browser.annotate', { tabId: 't1' })
      const wc = view.webContents!
      wc.emit(event)
      for (const name of ['did-navigate', 'did-navigate-in-page', 'destroyed'])
        expect(wc.listenerCount(name)).toBe(0)
      await expect(call('browser.annotateSend', { tabId: 't1', text: 'x' })).rejects.toMatchObject({
        code: 'page-changed',
      })
    }
  })
  it('answers the mark, then sends the note on it with its screenshot to the tab’s chat', async () => {
    const { call, send, capturePage, ops } = setup(button)
    await expect(call('browser.annotate', { tabId: 't1' })).resolves.toEqual({
      mark: { element: button.element, region: { x: 10, y: 20, w: 80, h: 30 } },
    })
    // The page only drew the mark; nothing is sent until the shell sends the note.
    expect(send).not.toHaveBeenCalled()
    expect(ops()).toEqual(['pick'])

    await expect(
      call('browser.annotateSend', { tabId: 't1', text: 'Make this bigger' }),
    ).resolves.toEqual({ sent: true, to: 'One' })
    // The mark leaves the page before the screenshot.
    expect(ops()).toEqual(['pick', 'clear'])
    expect(capturePage).toHaveBeenCalledWith(
      { x: 2, y: 12, width: 96, height: 46 },
      { stayHidden: true },
    )
    const [note, workspace] = send.mock.calls[0]!
    expect(workspace).toBe('chat:/s/one.jsonl')
    expect(note).toMatchObject({
      surface: 'browser',
      text: 'Make this bigger',
      url: 'https://example.com/a',
      title: 'Example',
      tabId: 't1',
      element: { tag: 'button', selector: '#buy' },
      region: { x: 10, y: 20, w: 80, h: 30 },
    })
    if (note.surface !== 'browser' || note.image === undefined) throw new Error('no image')
    const image = note.image
    expect(path.dirname(image)).toBe(path.join(dir, 'notes'))
    expect(fs.readFileSync(image, 'utf8')).toBe('png-bytes')

    // The mark went with the note: a second send has nothing to send.
    await expect(
      call('browser.annotateSend', { tabId: 't1', text: 'Again' }),
    ).rejects.toMatchObject({ code: 'no-mark' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('drops the mark on cancel without sending', async () => {
    const { call, send, ops } = setup(button)
    await call('browser.annotate', { tabId: 't1' })
    await expect(call('browser.annotateCancel', { tabId: 't1' })).resolves.toEqual({ ok: true })
    expect(ops()).toEqual(['pick', 'clear'])
    await expect(call('browser.annotateSend', { tabId: 't1', text: 'Late' })).rejects.toMatchObject(
      { code: 'no-mark' },
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('answers no mark when Isaac cancels the picker or the page goes away', async () => {
    const { call, send } = setup({ cancelled: true })
    await expect(call('browser.annotate', { tabId: 't1' })).resolves.toEqual({ mark: null })
    const gone = setup(button)
    gone.page.pick.mockRejectedValueOnce(new Error('Execution context was destroyed.'))
    await expect(gone.call('browser.annotate', { tabId: 't1' })).resolves.toEqual({ mark: null })
    expect(gone.ops()).toEqual(['pick'])
    expect(send).not.toHaveBeenCalled()
    expect(gone.send).not.toHaveBeenCalled()
  })

  it('closes the picker when Isaac takes too long to mark', async () => {
    const { call, page, ops } = setup(button)
    page.pick.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'timeout' }))
    await expect(call('browser.annotate', { tabId: 't1' })).resolves.toEqual({ mark: null })
    expect(ops()).toEqual(['pick', 'clear'])
  })

  it('fails not-found for an unknown tab', async () => {
    const { call } = setup({ cancelled: true })
    await expect(call('browser.annotate', { tabId: 't9' })).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(call('browser.annotateSend', { tabId: 't9', text: 'x' })).rejects.toMatchObject({
      code: 'not-found',
    })
  })
})
