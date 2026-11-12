import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ipcMain, session } from 'electron'
import { DESIGN_STYLE_KEYS, noteText, type AgentNote, type InvokeParsed } from '@evaos/contract'
import type { AgentNotes } from '../agent-presence/notes'
import { DESIGN_GATE_QUERY, PASSKEY_CHANNEL } from '../../preload/guest-channel'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { registerTestHook, registerViewProvider } from '../test-hooks'
import { BrowserHost } from './browser-host'
import { registerBrowserIpc } from './browser-ipc'
import { DesignMode } from './design-mode'
import { designPage } from './design-page'
import { designNote } from './design-send'
import { setupExtensions } from './extensions'
import { GUEST_PARTITION, setupGuestSession } from './guest-session'
import { installTabAppCookies } from './tab-app-cookies'

type BrowserNote = Extract<AgentNote, { surface: 'browser' }>

export function registerBrowser(ctx: MainContext): BrowserHost {
  setupGuestSession(ctx.env)
  const host = new BrowserHost(ctx)
  installTabAppCookies(session.fromPartition(GUEST_PARTITION), host)
  registerBrowserIpc(ctx, host)
  registerViewProvider(() => host.views())
  registerTestHook('browser', { host, pageControl: (id: string) => host.pageControl(id) })
  // Guest pages' passkey requests (preload/guest.ts); the host ignores senders that aren't its tabs.
  ipcMain.on(PASSKEY_CHANNEL, (event, phase: unknown) => {
    if (phase === 'start' || phase === 'done') host.passkey(event.sender.id, phase)
  })
  // Navigation waits for the extension host so the first page already gets content scripts.
  host.ready = setupExtensions(ctx, host).catch((e: unknown) => {
    console.warn('[extensions] setup failed:', e instanceof Error ? e.message : e)
  })
  // A native view paints over the renderer, so an HTML fullscreen video needs every view hidden.
  ctx.shell.webContents.on('enter-html-full-screen', () => host.setFullscreen(true))
  ctx.shell.webContents.on('leave-html-full-screen', () => host.setFullscreen(false))
  ctx.win.on('closed', () => host.dispose())
  ctx.onBeforeQuit(async () => host.dispose())
  return host
}

/**
 * Design Mode in page tabs (design-mode.ts): its IPC and its test hook. A Send goes to the chat
 * owning the page through `send` (agent-presence/notes.ts), its screenshots as files beside the
 * page notes' (`<configDir>/notes/<id>.png`).
 */
export function registerDesignMode(
  ctx: MainContext,
  host: BrowserHost,
  notes: Pick<AgentNotes, 'send' | 'ownerOf'>,
): void {
  const design = new DesignMode(
    {
      page: (tabId) => designPage(host.pageControl(tabId), DESIGN_STYLE_KEYS),
      contents: (tabId) => host.tabById(tabId),
      onTabClosed: (cb) => host.onTabClosed(cb),
      interceptInput: (fn) => host.interceptInput(fn),
    },
    (channel, payload) => emit(ctx, channel, payload),
  )
  handle(ctx, 'design.set', async ({ tabId, on }) => {
    await design.set(tabId, on)
    return { ok: true as const }
  })
  handle(ctx, 'design.select', async ({ tabId, selectors }) => {
    await design.select(tabId, selectors)
    return { ok: true as const }
  })
  handle(ctx, 'design.style', async ({ tabId, selector, property, value }) => {
    await design.style(tabId, selector, property, value)
    return { ok: true as const }
  })
  const pageOf = (tabId: string) => {
    const tab = host.allTabs().find((t) => t.state.id === tabId)
    if (!tab) throw Object.assign(new Error(`No page ${tabId}`), { code: 'not-found' })
    return tab
  }
  /** The request as a page note of intent `change`, its screenshots written beside the notes'. */
  const noteOf = async (
    tabId: string,
    req: Omit<InvokeParsed<'design.send'>, 'tabId'>,
    saved: string[],
  ): Promise<BrowserNote> => {
    const tab = pageOf(tabId)
    const dir = path.join(ctx.env.configDir, 'notes')
    const save = async (png: string): Promise<string> => {
      await fs.promises.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${randomUUID()}.png`)
      await fs.promises.writeFile(file, Buffer.from(png, 'base64'))
      saved.push(file)
      return file
    }
    const note = await designNote(req, { tabId, url: tab.state.url, title: tab.state.title }, save)
    if (!note) {
      throw Object.assign(new Error('None of the selected elements is in the page right now'), {
        code: 'nothing-to-send',
      })
    }
    return note
  }
  handle(ctx, 'design.send', async ({ tabId, ...req }) => {
    const saved: string[] = []
    let sent = false
    try {
      const r = await notes.send(await noteOf(tabId, req, saved), pageOf(tabId).scope || null)
      sent = r.sent
      return r
    } finally {
      // A request that went nowhere leaves no screenshots behind.
      if (!sent) await Promise.all(saved.map((f) => fs.promises.rm(f, { force: true })))
    }
  })
  handle(ctx, 'design.compose', async ({ tabId, ...req }) => {
    const saved: string[] = []
    const note = await noteOf(tabId, req, saved)
    const files = [note.image, ...(note.also ?? []).map((t) => t.image)].filter(
      (f): f is string => f !== undefined,
    )
    // The text names each screenshot's path, so one that can't be read drops out of the images only.
    const images = (
      await Promise.all(
        files.map((f) =>
          fs.promises
            .readFile(f)
            .then((b) => ({ mimeType: 'image/png' as const, data: b.toString('base64') }))
            .catch(() => null),
        ),
      )
    ).filter((i) => i !== null)
    return { text: noteText(note), images }
  })
  handle(ctx, 'design.owner', ({ tabId }) => {
    const tab = pageOf(tabId)
    const probe: AgentNote = {
      surface: 'browser',
      text: '.',
      url: tab.state.url,
      title: tab.state.title,
      tabId,
      region: { x: 0, y: 0, w: 0, h: 0 },
    }
    return { owner: notes.ownerOf(probe, tab.scope || null) }
  })
  // A new document in a page tab asks whether Design Mode holds the pointer before it runs scripts.
  ipcMain.handle(DESIGN_GATE_QUERY, (event) => {
    const tab = host.tabByWebContents(event.sender.id)
    return tab ? design.isOn(tab.id) : false
  })
  registerTestHook('design', design)
  ctx.win.on('closed', () => design.dispose())
}
