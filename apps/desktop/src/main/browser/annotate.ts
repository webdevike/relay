import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WebContents } from 'electron'
import { NOTE_MARK_COLOR, type AgentNote, type NoteRegion } from '@evaos/contract'
import type { SendNote } from '../agent-presence/notes'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { registerTestHook } from '../test-hooks'
import type { PickBox, PickResult } from './annotate-picker'
import type { BrowserHost } from './browser-host'

/** How long the picker waits for Isaac's mark before it closes itself. */
const PICK_TIMEOUT_MS = 30 * 60_000
/** How long clearing the mark from the page may take. */
const CLEAR_TIMEOUT_MS = 5000
/** Context kept around the mark in its screenshot, in CSS px. */
const CAPTURE_PAD = 8

/** The mark's box inside the viewport, in whole CSS px (a box partly off screen is cut). */
export function clampRegion(box: PickBox, viewport: { width: number; height: number }): NoteRegion {
  const x0 = Math.min(Math.max(Math.floor(box.x), 0), viewport.width)
  const y0 = Math.min(Math.max(Math.floor(box.y), 0), viewport.height)
  const x1 = Math.min(Math.max(Math.ceil(box.x + box.w), x0), viewport.width)
  const y1 = Math.min(Math.max(Math.ceil(box.y + box.h), y0), viewport.height)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * The view rect capturePage takes for `region` (viewport CSS px), padded and kept inside the
 * viewport: capturePage counts in DIPs, a CSS px is `zoom` DIPs (the page's zoom factor), and
 * the image comes back at the screen's scale, so it stays sharp on Retina.
 */
export function captureRect(
  region: NoteRegion,
  viewport: { width: number; height: number },
  zoom: number,
  pad = CAPTURE_PAD,
): { x: number; y: number; width: number; height: number } {
  const x0 = Math.max(region.x - pad, 0)
  const y0 = Math.max(region.y - pad, 0)
  const x1 = Math.min(region.x + region.w + pad, viewport.width)
  const y1 = Math.min(region.y + region.h + pad, viewport.height)
  const x = Math.floor(x0 * zoom)
  const y = Math.floor(y0 * zoom)
  return {
    x,
    y,
    width: Math.max(Math.ceil(x1 * zoom) - x, 0),
    height: Math.max(Math.ceil(y1 * zoom) - y, 0),
  }
}

/** What e2e sees and steers (test hook `browserAnnotate`, EVAOS_E2E only). */
export interface AnnotateHook {
  /** Every note handed to the sender, oldest first. */
  notes: Array<{ note: AgentNote; workspace: string | null }>
  /** Answers in place of the real sender when set. */
  answer: { sent: boolean; to: string | null } | null
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

type Marked = Extract<PickResult, { cancelled: false }>

/** What a released mark's `release` becomes; module level, so it holds no page. */
const noRelease = (): void => {}

/**
 * A mark waiting for its note, bound to the document it was made on. Once the page navigates or
 * goes away it is released (listeners off, mark and page refs dropped) and only answers
 * `page-changed` from then on.
 */
interface Pending {
  picked: Marked | null
  /** The page's webContents, URL and title when Isaac marked it. */
  wc: WebContents | null
  url: string
  title: string
  /** The page navigated (or went away) since: the mark no longer points at what it shows. */
  changed: boolean
  /** Stops listening to the page and lets go of the mark and the page. */
  release(): void
}

/**
 * `browser.annotate`: Isaac marks an element or a region on a page (the picker in the page) and
 * writes a note in the shell (`browser.annotateSend`); it goes to the chat owning the tab (`send`,
 * by the tab's workspace) with the mark, its screenshot (`<configDir>/notes/<id>.png`) and the
 * page's URL. The page only ever draws the mark: the note's keys never reach it. A second
 * annotate on the tab drops the first mark or closes the first picker, which answers null.
 */
export function registerBrowserAnnotate(ctx: MainContext, host: BrowserHost, send: SendNote): void {
  const hook: AnnotateHook = { notes: [], answer: null }
  registerTestHook('browserAnnotate', hook)
  const tabOf = (tabId: string) => host.allTabs().find((t) => t.state.id === tabId)
  const pageOf = (tabId: string) => {
    const tab = tabOf(tabId)
    if (!tab) throw Object.assign(new Error(`No page ${tabId}`), { code: 'not-found' })
    return tab
  }
  /** The mark each tab's note waits on, from its pick until it is sent or dropped. */
  const marks = new Map<string, Pending>()
  const drop = (tabId: string): void => {
    marks.get(tabId)?.release()
    marks.delete(tabId)
  }
  /** Takes the mark (or the open picker) off the page; a page gone has nothing to clear. */
  const clear = async (tabId: string): Promise<void> => {
    try {
      await host.pageControl(tabId).pick({ op: 'clear' }, CLEAR_TIMEOUT_MS)
    } catch {
      // Gone (closed, navigated, crashed): its mark went with it.
    }
  }
  /**
   * Keeps `picked` for the note while its page stays on the same document. A navigation (an
   * in-page one too: the URL the note would carry changes) or the page going away drops it and
   * tells the shell, which closes the composer; a note never goes out on a page Isaac didn't mark.
   */
  const keep = (tabId: string, picked: Marked, wc: WebContents, title: string): void => {
    let released = false
    const pending: Pending = {
      picked,
      wc,
      url: wc.getURL(),
      title,
      changed: false,
      release: () => {
        if (released) return
        released = true
        // The tombstone left in `marks` must not reach the page through this closure: any
        // function made in here would keep this scope (and the page) alive.
        pending.release = noRelease
        pending.picked = null
        pending.wc = null
        if (wc.isDestroyed()) return
        wc.off('did-navigate', navigated)
        wc.off('did-navigate-in-page', navigatedInPage)
        wc.off('destroyed', navigated)
      },
    }
    // Stays bound while a send is in flight too (off the map by then), so a navigation during
    // its clear or screenshot still invalidates it.
    const changed = (inPage: boolean): void => {
      if (released) return
      pending.changed = true
      pending.release()
      // An in-page navigation keeps the document, and the mark drawn on it.
      if (inPage) void clear(tabId)
      emit(ctx, 'browser.annotateDropped', { tabId })
    }
    function navigated(): void {
      changed(false)
    }
    function navigatedInPage(_e: unknown, _url: string, isMainFrame: boolean): void {
      if (isMainFrame) changed(true)
    }
    wc.on('did-navigate', navigated)
    wc.on('did-navigate-in-page', navigatedInPage)
    wc.on('destroyed', navigated)
    marks.set(tabId, pending)
  }

  handle(ctx, 'browser.annotate', async ({ tabId }) => {
    const tab = pageOf(tabId)
    drop(tabId)
    const wc = host.driveView(tabId).webContents
    // Escape works before the first click; focus moves inside the window only, never to it.
    if (ctx.win.isFocused()) wc.focus()
    const picked = await host
      .pageControl(tabId)
      .pick({ op: 'pick', color: tab.state.agent?.color ?? NOTE_MARK_COLOR }, PICK_TIMEOUT_MS)
      .catch(async (e: unknown) => {
        // Timed out: close the picker still open in the page. Gone (navigation, crash): nothing to close.
        if (e instanceof Error && 'code' in e && e.code === 'timeout') await clear(tabId)
        return { cancelled: true as const }
      })
    if (picked.cancelled) return { mark: null }
    keep(tabId, picked, wc, tab.state.title)
    // The note is typed in the shell: keys must leave the page before the composer takes focus.
    if (ctx.win.isFocused()) ctx.shell.webContents.focus()
    return {
      mark: {
        ...(picked.element ? { element: picked.element } : {}),
        region: clampRegion(picked.box, picked.viewport),
      },
    }
  })

  handle(ctx, 'browser.annotateCancel', async ({ tabId }) => {
    drop(tabId)
    if (tabOf(tabId)) await clear(tabId)
    return { ok: true as const }
  })

  handle(ctx, 'browser.annotateSend', async ({ tabId, text }) => {
    const tab = pageOf(tabId)
    const pending = marks.get(tabId)
    if (!pending)
      throw Object.assign(new Error('Nothing is marked on this page'), { code: 'no-mark' })
    // Off the map (a second send finds no mark) but still listening until the note is out.
    marks.delete(tabId)
    const pageChanged = () =>
      Object.assign(new Error('The page changed since it was marked'), { code: 'page-changed' })
    let image: string | undefined
    try {
      const wc = host.driveView(tabId).webContents
      const { picked } = pending
      if (pending.changed || !picked || wc !== pending.wc || wc.getURL() !== pending.url)
        throw pageChanged()
      const stale = () => pending.changed || wc.isDestroyed() || wc.getURL() !== pending.url
      // The screenshot shows the page, not the mark drawn over it.
      await clear(tabId)
      if (stale()) throw pageChanged()
      const region = clampRegion(picked.box, picked.viewport)
      const rect = captureRect(region, picked.viewport, wc.getZoomFactor())
      if (rect.width > 0 && rect.height > 0) {
        const shot = await wc.capturePage(rect, { stayHidden: true }).catch(() => null)
        if (stale()) throw pageChanged()
        if (shot && !shot.isEmpty()) {
          const dir = path.join(ctx.env.configDir, 'notes')
          await fs.promises.mkdir(dir, { recursive: true })
          image = path.join(dir, `${randomUUID()}.png`)
          await fs.promises.writeFile(image, shot.toPNG())
        }
      }
      if (stale()) throw pageChanged()
      const note: AgentNote = {
        surface: 'browser',
        text: clip(text, 4000),
        url: clip(pending.url, 4000),
        title: clip(pending.title, 500),
        tabId,
        ...(picked.element ? { element: picked.element } : {}),
        region,
        ...(image ? { image } : {}),
      }
      pending.release()
      const workspace = tab.scope || null
      hook.notes.push({ note, workspace })
      return hook.answer ?? (await send(note, workspace))
    } catch (e) {
      pending.release()
      if (image && e instanceof Error && 'code' in e && e.code === 'page-changed')
        await fs.promises.rm(image, { force: true })
      throw e
    }
  })
}
