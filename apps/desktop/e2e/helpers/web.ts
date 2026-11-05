import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'

/**
 * Web pages as page tabs: every browser host tab is its own tool tab (`pane-tab-web:<id>`) with
 * its own panel (`web-panel[data-tab-id=<id>]`: address row, slot). These find them and reach
 * each page's native view by id, whichever page the host has active.
 */
export type Rect = { x: number; y: number; width: number; height: number }

interface WcLike {
  getURL(): string
  focus(): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  sendInputEvent(e: Record<string, unknown>): void
  session: unknown
  getLastWebPreferences(): {
    sandbox?: boolean
    contextIsolation?: boolean
    preload?: string
  } | null
}
interface ViewLike {
  getVisible(): boolean
  getBounds(): Rect
  webContents: WcLike
}
export interface HostLike {
  views(): ViewLike[]
  tabById(id: string): WcLike | undefined
  activeTabId(): string
  snapshot(): { tabs: Array<{ id: string; title: string; url: string }>; activeId: string }
}
export type BrowserHooks = {
  __evaosTest: {
    win: { isDestroyed(): boolean }
    hooks: { browser: { host: HostLike; pageControl(id: string): unknown } }
  }
}

/** A page's panel (its address row and slot). */
export const webPanel = (shell: Page, id: string): Locator =>
  shell.locator(`[data-testid=web-panel][data-tab-id=${id}]`)

/** A page's tab in its pane's strip. */
export const pageTab = (shell: Page, id: string): Locator =>
  shell.locator(`[data-testid="pane-tab-web:${id}"]`)

/** Every page tab of the workspace on screen. */
export const pageTabs = (shell: Page): Locator => shell.locator('[data-testid^="pane-tab-web:"]')

/** The pages with a tab on screen, in strip order. */
export function pageIds(shell: Page): Promise<string[]> {
  return shell.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="pane-tab-web:"]')].map((e) =>
      (e.getAttribute('data-testid') ?? '').slice('pane-tab-web:'.length),
    ),
  )
}

/** The first tool pane's id (Files, right of the chat, in the default shell). */
export function toolPane(shell: Page): Promise<string> {
  return shell.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-pane-kind=tool]')
    if (!el?.dataset['paneId']) throw new Error('no tool pane')
    return el.dataset['paneId']
  })
}

/** The pane whose strip holds page `id`'s tab. */
export function paneOfPage(shell: Page, id: string): Promise<string> {
  return shell.evaluate((tabId) => {
    const tab = document.querySelector(`[data-testid="pane-tab-web:${tabId}"]`)
    const pane = tab?.closest<HTMLElement>('[data-pane-id]')?.dataset['paneId']
    if (!pane) throw new Error(`no pane holds ${tabId}`)
    return pane
  }, id)
}

/**
 * A blank page from pane `pane`'s + menu (the first tool pane by default): its tab comes to the
 * front with the address field focused. Answers the page's id.
 */
export async function newPage(shell: Page, pane?: string): Promise<string> {
  const before = await pageIds(shell)
  const p = pane ?? (await toolPane(shell))
  await shell
    .locator(`[data-pane-id=${p}]`)
    .locator(`[data-testid=pane-add-${p}], [data-testid=tab-new]`)
    .first()
    .click()
  await shell.locator(`[data-testid=pane-add-tool-browser-${p}]`).click()
  let id = ''
  await expect
    .poll(async () => {
      id = (await pageIds(shell)).find((x) => !before.includes(x)) ?? ''
      return id
    })
    .not.toBe('')
  await expect(webPanel(shell, id)).toBeVisible()
  return id
}

/** Types `input` into page `id`'s address field and goes. */
export async function navigate(shell: Page, id: string, input: string): Promise<void> {
  const addr = webPanel(shell, id).locator('[data-testid=address-input]')
  await addr.fill(input)
  await addr.press('Enter')
}

/** A new page (see newPage) at `url`, its tab titled once it loads. */
export async function openPage(
  shell: Page,
  url: string,
  title?: string,
  pane?: string,
): Promise<string> {
  const id = await newPage(shell, pane)
  await navigate(shell, id, url)
  if (title) await expect(pageTab(shell, id)).toContainText(title)
  return id
}

/** Page `id`'s view: whether it shows and where (null while it has none). */
export function viewOf(
  app: ElectronApplication,
  id: string,
): Promise<{ visible: boolean; bounds: Rect } | null> {
  return app.evaluate((_e, tabId) => {
    const h = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
    const wc = h.tabById(tabId)
    const v = h.views().find((x) => x.webContents === wc)
    return v ? { visible: v.getVisible(), bounds: v.getBounds() } : null
  }, id)
}

/** Whether page `id`'s view is on screen. */
export async function viewVisible(app: ElectronApplication, id: string): Promise<boolean> {
  return (await viewOf(app, id))?.visible ?? false
}

/** Runs `code` in page `id`. */
export function guestEval(app: ElectronApplication, id: string, code: string): Promise<unknown> {
  return app.evaluate(
    (_e, a) => {
      const h = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
      const wc = h.tabById(a.id)
      if (!wc) throw new Error(`no page ${a.id}`)
      return wc.executeJavaScript(a.code)
    },
    { id, code },
  )
}

/** A key pressed inside page `id` (focused first), as the guest's own input. */
export function sendKey(
  app: ElectronApplication,
  id: string,
  key: string,
  modifiers: string[],
): Promise<void> {
  return app.evaluate(
    (_e, a) => {
      const h = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
      const wc = h.tabById(a.id)
      if (!wc) throw new Error(`no page ${a.id}`)
      wc.focus()
      wc.sendInputEvent({ type: 'keyDown', keyCode: a.key, modifiers: a.modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode: a.key, modifiers: a.modifiers })
    },
    { id, key, modifiers },
  )
}

/** Page `id`'s slot rect, rounded as the host gets it. */
export async function slotRect(shell: Page, id: string): Promise<Rect> {
  const box = await webPanel(shell, id).locator('[data-testid=browser-slot]').boundingBox()
  if (!box) throw new Error(`page ${id}'s slot has no box`)
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

/** Waits until page `id`'s view sits exactly over its slot; answers the largest delta (0). */
export async function expectViewOnSlot(
  app: ElectronApplication,
  shell: Page,
  id: string,
): Promise<number> {
  await expect
    .poll(async () => JSON.stringify((await viewOf(app, id))?.bounds), { timeout: 5000 })
    .toBe(JSON.stringify(await slotRect(shell, id)))
  const b = (await viewOf(app, id))!.bounds
  const s = await slotRect(shell, id)
  return Math.max(
    Math.abs(b.x - s.x),
    Math.abs(b.y - s.y),
    Math.abs(b.width - s.width),
    Math.abs(b.height - s.height),
  )
}

/** Two rAFs and a beat: layout and slot reports settle. */
export async function frames(shell: Page): Promise<void> {
  await shell.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), 50))),
      ),
  )
}

/** Every live page view, in creation order. */
export function views(
  app: ElectronApplication,
): Promise<Array<{ visible: boolean; bounds: Rect }>> {
  return app.evaluate(() =>
    (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
      .views()
      .map((v) => ({ visible: v.getVisible(), bounds: v.getBounds() })),
  )
}
