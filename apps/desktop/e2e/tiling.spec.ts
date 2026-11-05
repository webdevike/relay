import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect, launchApp } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { openPage as openWebPage, pageIds, pageTab, pageTabs, webPanel } from './helpers/web'

// The window shows one workspace at a time (an assistant, a chat, a page), each with its own
// dockview layout: app tabs (chats and pages) and tool tabs (Files, Terminal, web pages, pages
// beside) live in any of its panes. Pinned tabs show in every workspace.

type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
  }
}
type ShellHooks = {
  __evaosShell: {
    openPlace(page: string, newTab?: boolean, extra?: object): void
    openChat(): void
    browserScope(): string
    tabs(): { list: Array<{ id: number; page: string }>; active: number }
  }
}
/** A pane on screen: its id, its tabs' panel ids in order (`tab:<n>` or a tool), the one in front. */
type PaneView = { id: string; tabs: string[]; active: string | null }

let server: StaticServer
let fx: ChatFixture

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    // Chat A carries a link to the test page, so it opens the way Isaac opens one.
    await fx.append(
      'p4-ecard',
      JSON.stringify({
        type: 'message',
        id: 'a9',
        parentId: 'a1',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: `See [the page A link](${server.url('/a.html')}).` }],
          stopReason: 'stop',
        },
      }),
    )
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5' })
    fx.cleanup()
  },
})

test.use({ startOnChat: false })

test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const sel = (id: string): string => `[data-testid="${id}"]`
const scope = (shell: Page): Promise<string> =>
  shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.browserScope())

/** The panes on screen, `kind` only (a pane hidden by a maximized one is not on screen). */
const panes = (shell: Page, kind: 'app' | 'tool' | 'any' = 'tool'): Promise<PaneView[]> =>
  shell.evaluate(
    (k) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          k === 'any' ? '[data-pane-kind]' : `[data-pane-kind=${k}]`,
        ),
      ]
        .filter((f) => {
          const r = f.getBoundingClientRect()
          return f.checkVisibility({ visibilityProperty: true }) && r.width > 0 && r.height > 0
        })
        .map((f) => {
          const ids = (t: Element): string => {
            const app = t.getAttribute('data-app-tab')
            return app !== null
              ? `tab:${app}`
              : t.getAttribute('data-testid')!.slice('pane-tab-'.length)
          }
          const tabs = [...f.querySelectorAll('[data-pane-tab], .eva-tab[data-app-tab]')]
          const front = tabs.find(
            (t) => t.hasAttribute('data-active') && t.getAttribute('data-active') !== 'false',
          )
          return {
            id: f.dataset['paneId']!,
            tabs: tabs.map(ids),
            active: front ? ids(front) : null,
          }
        }),
    kind,
  )

type DockNode =
  { type: 'branch'; data: DockNode[] } | { type: 'leaf'; data: { id: string; views: string[] } }
const layoutFile = (dir: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}
/** The saved dock as nested ids: a pane is its id, a split is ['row' | 'column', ...children]. */
function shape(node: DockNode, dir: 'row' | 'column'): unknown {
  if (node.type === 'leaf') return node.data.id
  const turn = dir === 'row' ? 'column' : 'row'
  return [dir, ...node.data.map((c) => shape(c, turn))]
}
type SavedDock = { grid: { root: DockNode; orientation: 'HORIZONTAL' | 'VERTICAL' } }
/** The saved dock of the workspace in front. */
const savedDock = (dir: string): SavedDock | undefined => {
  const ws = layoutFile(dir)['workspaces'] as
    { front?: string; layouts?: Record<string, SavedDock> } | undefined
  return ws?.front ? ws.layouts?.[ws.front] : undefined
}
const savedShape = (dir: string): unknown => {
  const d = savedDock(dir)
  return d ? shape(d.grid.root, d.grid.orientation === 'HORIZONTAL' ? 'row' : 'column') : null
}
/** The saved views of pane `id`. */
function savedViews(dir: string, id: string): string[] | null {
  const find = (n: DockNode): string[] | null => {
    if (n.type === 'leaf') return n.data.id === id ? n.data.views : null
    for (const c of n.data) {
      const hit = find(c)
      if (hit) return hit
    }
    return null
  }
  const d = savedDock(dir)
  return d ? find(d.grid.root) : null
}

async function openChat(shell: Page, file: string): Promise<void> {
  await shell.evaluate(
    (f) => (window as unknown as ShellHooks).__evaosShell.openPlace('chat', false, { chat: f }),
    file,
  )
  await expect.poll(() => scope(shell)).toBe(`chat:${file}`)
}
async function openPage(shell: Page, page: string): Promise<void> {
  await shell.evaluate((p) => (window as unknown as ShellHooks).__evaosShell.openPlace(p), page)
  await expect.poll(() => scope(shell)).toBe(`page:${page}`)
}
/** Opens board `slug` (Canvas, one workspace for every board), in a new tab or this one. */
async function openBoard(shell: Page, slug: string, newTab: boolean): Promise<void> {
  await shell.evaluate(
    ([s, n]) =>
      (window as unknown as ShellHooks).__evaosShell.openPlace('canvas', n as boolean, {
        canvas: s,
      }),
    [slug, newTab] as const,
  )
  await expect.poll(() => scope(shell)).toBe('page:canvas')
  await expect(shell.locator(`${sel('tabbar')} .eva-tab[data-active=true]`).first()).toContainText(
    slug,
  )
}
async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}
async function box(shell: Page, selector: string) {
  const b = await shell.locator(selector).boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}
/** Picks a pane's + menu item (split right, split down, maximize). */
async function paneMenu(shell: Page, pane: string, item: string): Promise<void> {
  await shell.locator(sel(`pane-add-${pane}`)).click()
  await shell.locator(`${sel(`pane-add-menu-${pane}`)} ${sel(item)}`).click()
}
/** The sash between two side-by-side panes. */
async function sashBetween(shell: Page, left: string, right: string) {
  const a = await box(shell, sel(`pane-${left}`))
  const b = await box(shell, sel(`pane-${right}`))
  const sashes = await shell.locator('.dv-sash').all()
  for (const s of sashes) {
    const r = await s.boundingBox()
    if (r && r.x >= a.x + a.width - 2 && r.x + r.width <= b.x + 2 && r.height > 0) return r
  }
  throw new Error(`no sash between ${left} and ${right}`)
}
type Zone = { x: number; y: number; width: number; height: number }
/**
 * Drags `from` (a tab) to the point (x, y) with the mouse, in steps so dockview's drop overlay
 * follows. The overlay slides to the zone under the pointer, so `settled` (when given) says when
 * it has arrived; the drop waits for it. Answers the overlay's box just before the drop.
 */
async function dragTo(
  shell: Page,
  from: string,
  x: number,
  y: number,
  settled: (zone: Zone) => boolean = () => true,
): Promise<Zone> {
  const t = await box(shell, from)
  await shell.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(t.x + t.width / 2 + 6, t.y + t.height / 2 + 6, { steps: 3 })
  await shell.mouse.move(x, y, { steps: 16 })
  const overlay = shell.locator('.dv-drop-target-anchor, .dv-drop-target-selection').first()
  await expect(overlay).toBeVisible()
  let zone: Zone | null = null
  await expect
    .poll(
      async () => {
        zone = await overlay.boundingBox()
        return zone !== null && settled(zone)
      },
      { intervals: [100] },
    )
    .toBe(true)
  await shell.mouse.up()
  return zone!
}

// A fresh Dashboard: the app tabs on the left, one tool pane with Files on the right.
const DEFAULT: PaneView[] = [{ id: 'p2', tabs: ['files'], active: 'files' }]

test('each workspace keeps its own tool tabs; the toggle hides and shows them', async ({
  app,
  shell,
  configDir,
}) => {
  const tools = shell.locator('[data-pane-kind=tool]')
  const toggle = shell.locator(`${sel('panel-toggle')}:visible`).first()
  const chatA = fx.file('p4-ecard')
  const chatB = fx.file('p4-relay')

  // A fresh config: the app tabs on the left, one tool pane with Files on the right.
  await expect(shell.locator(sel('pane-p1'))).toHaveAttribute('data-pane-kind', 'app')
  await expect(shell.locator(sel('pane-p2'))).toHaveAttribute('data-pane-kind', 'tool')
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  const appBox = await box(shell, sel('pane-p1'))
  const toolBox = await box(shell, sel('pane-p2'))
  expect(toolBox.x).toBeGreaterThan(appBox.x + appBox.width)
  // The sash sits in the gap between them.
  const sash = await sashBetween(shell, 'p1', 'p2')
  expect(sash.width).toBeGreaterThan(0)
  // The first save writes the workspace's dock and drops the old split tree and panel keys.
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'p1', 'p2'])
  expect(layoutFile(configDir)).not.toHaveProperty('tiling')
  expect(layoutFile(configDir)).not.toHaveProperty('panel_choices')
  expect(layoutFile(configDir)).not.toHaveProperty('panel_tool')

  // Chat A is a workspace of its own: none of Dashboard's tool tabs follow it. A link in it opens
  // a web page beside the chat, which brings a tool pane up.
  await openChat(shell, chatA)
  await expect.poll(() => panes(shell)).toEqual([])
  await shell.locator(sel('chat-log')).getByText('the page A link').click()
  await expect(pageTabs(shell)).toHaveCount(1)
  const aTab = (await pageIds(shell))[0]!
  await expect(pageTab(shell, aTab)).toContainText('Page A')
  await expect(tools).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide tool panes')

  // Chat B has none: no pages, no tool panes. A page opened in B belongs to B.
  await openChat(shell, chatB)
  await expect.poll(() => pageIds(shell)).toEqual([])
  await expect.poll(() => panes(shell)).toEqual([])
  const bTab = await openWebPage(shell, server.url('/b.html'), 'Page B', 'p1')
  expect(bTab).not.toBe(aTab)

  // Back to A: its page again, B's not there; switching back restores A's layout as it was.
  await openChat(shell, chatA)
  await expect.poll(() => pageIds(shell)).toEqual([aTab])
  await expect(webPanel(shell, aTab)).toBeVisible()

  // Pin A's page from its tab's menu: it shows in B too, beside B's own.
  await pageTab(shell, aTab).click({ button: 'right' })
  await shell.locator(sel('pane-tab-menu-pin')).click()
  await expect(pageTab(shell, aTab)).toHaveAttribute('data-pinned', 'true')
  await openChat(shell, chatB)
  await expect.poll(async () => (await pageIds(shell)).sort()).toEqual([aTab, bTab].sort())
  await openPage(shell, 'dashboard')
  await expect.poll(() => pageIds(shell)).toEqual([aTab])
  await expect.poll(async () => (await panes(shell)).flatMap((p) => p.tabs)).toContain('files')

  // Hiding belongs to the workspace's layout: Dashboard's panes stay hidden while Isaac visits
  // chat A (which shows its own) and comes back; Cmd+Shift+B brings them back.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('aria-label', 'Show tool panes')
  await expect(tools.filter({ visible: true })).toHaveCount(0)
  await openChat(shell, chatA)
  await expect(webPanel(shell, aTab)).toBeVisible()
  await openPage(shell, 'dashboard')
  await expect(tools.filter({ visible: true })).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await shell.locator(sel('shell')).click({ position: { x: 600, y: 790 } })
  await shell.keyboard.press('Meta+Shift+b')
  await expect(tools.first()).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await panes(shell)).flatMap((p) => p.tabs)).toContain('files')

  // A new chat opens a page, then omp names its file: the page stays with the chat.
  const before = fs.readdirSync(fx.sessionsDir)
  await shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.openChat())
  await expect.poll(() => scope(shell)).toMatch(/^draft:\d+$/)
  const draftTab = await openWebPage(shell, server.url('/a.html'), 'Page A', 'p1')
  // The page opened in front of the chat's own pane: bring the chat's tab forward to type.
  await shell
    .locator(`${sel('tabbar')} .eva-tab`)
    .first()
    .click()
  const input = shell.locator(sel('composer-input'))
  await expect(input).toBeVisible()
  await input.fill('hello from a draft')
  await input.press('Enter')
  await expect
    .poll(() => fs.readdirSync(fx.sessionsDir).filter((n) => !before.includes(n)).length)
    .toBe(1)
  const created = path.join(
    fx.sessionsDir,
    fs.readdirSync(fx.sessionsDir).find((n) => !before.includes(n))!,
  )
  await expect.poll(() => scope(shell)).toBe(`chat:${created}`)
  await expect.poll(async () => (await pageIds(shell)).sort()).toEqual([aTab, draftTab].sort())
  await openChat(shell, chatA)
  await expect.poll(() => pageIds(shell)).toEqual([aTab])
  await openChat(shell, created)
  await expect.poll(async () => (await pageIds(shell)).sort()).toEqual([aTab, draftTab].sort())
  const want = await panes(shell)

  // A renderer reload comes back to the same workspace with the same panes and pages.
  await shell.reload()
  await shell.waitForSelector(sel('rail'))
  await shell.waitForFunction(() => Boolean((window as unknown as ShellHooks).__evaosShell))
  await expect.poll(() => scope(shell)).toBe(`chat:${created}`)
  await expect.poll(() => panes(shell)).toEqual(want)
  await openChat(shell, chatB)
  await expect.poll(async () => (await pageIds(shell)).sort()).toEqual([aTab, bTab].sort())

  // With every tool pane closed, the toggle opens Files again.
  for (;;) {
    const open = await panes(shell)
    if (open.length === 0) break
    await shell.locator(sel(`pane-close-${open[0]!.id}`)).click()
    await expect.poll(async () => (await panes(shell)).length).toBe(open.length - 1)
  }
  // The toggle sits in the chat's header: bring B's chat tab forward (its page is in front).
  await shell
    .locator(`${sel('tabbar')} .eva-tab`)
    .first()
    .click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect.poll(async () => (await panes(shell)).flatMap((p) => p.tabs)).toContain('files')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  void app
})

test('the + menu splits a pane right and down, the sash resizes, and maximize shows one', async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1600, 900)
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  // A second tool in the pane, then split right: the tab in front moves to the new pane.
  await paneMenu(shell, 'p2', 'pane-add-tool-terminal-p2')
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p2', tabs: ['files', 'terminal'], active: 'terminal' }])
  await paneMenu(shell, 'p2', 'pane-add-split-right-p2')
  await expect
    .poll(() => panes(shell))
    .toEqual([
      { id: 'p2', tabs: ['files'], active: 'files' },
      { id: 'p3', tabs: ['terminal'], active: 'terminal' },
    ])
  const p2 = await box(shell, sel('pane-p2'))
  const p3 = await box(shell, sel('pane-p3'))
  expect(p3.x).toBeGreaterThan(p2.x + p2.width)
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'p1', 'p2', 'p3'])

  // Dragging the sash after the app pane gives its space to the pane beside it.
  const app1 = await box(shell, sel('pane-p1'))
  const s = await sashBetween(shell, 'p1', 'p2')
  const x = s.x + s.width / 2
  const y = s.y + s.height / 2
  await shell.mouse.move(x, y)
  await shell.mouse.down()
  await shell.mouse.move(x - 20, y, { steps: 3 })
  await shell.mouse.move(x - 40, y, { steps: 3 })
  await shell.mouse.up()
  await expect
    .poll(async () => Math.round(app1.width - (await box(shell, sel('pane-p1'))).width))
    .toBe(40)
  expect(Math.round((await box(shell, sel('pane-p2'))).width - p2.width)).toBe(40)

  // The + menu moves Files over to p3 (p2, left empty, goes); split down puts it under Terminal.
  await paneMenu(shell, 'p3', 'pane-add-tool-files-p3')
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['terminal', 'files'], active: 'files' }])
  await paneMenu(shell, 'p3', 'pane-add-split-down-p3')
  await expect.poll(async () => (await panes(shell)).length).toBe(2)
  const [upper, lower] = await panes(shell)
  expect(upper).toEqual({ id: 'p3', tabs: ['terminal'], active: 'terminal' })
  expect(lower!.tabs).toEqual(['files'])
  const p3top = await box(shell, sel('pane-p3'))
  const under = await box(shell, sel(`pane-${lower!.id}`))
  expect(under.y).toBeGreaterThan(p3top.y + p3top.height)
  await expect.poll(() => savedShape(configDir)).toEqual(['row', 'p1', ['column', 'p3', lower!.id]])

  // Maximize fills the panes' area with one pane; its header button restores the others.
  await paneMenu(shell, 'p3', 'pane-add-zoom-p3')
  await expect
    .poll(() => panes(shell, 'any'))
    .toEqual([{ id: 'p3', tabs: ['terminal'], active: 'terminal' }])
  await expect(shell.locator(sel('pane-p1'))).toBeHidden()
  const restore = shell.locator(`${sel('pane-header-p3')} ${sel('pane-zoom-p3')}`)
  await expect(restore).toHaveAttribute('aria-label', 'Restore panes')
  await restore.click()
  await expect(shell.locator(sel('pane-p1'))).toBeVisible()
  await expect(shell.locator(sel(`pane-${lower!.id}`))).toBeVisible()

  // Splitting a pane with one tab opens a tool that is not open anywhere: none is left here.
  const count = (await panes(shell, 'any')).length
  await paneMenu(shell, 'p3', 'pane-add-split-right-p3')
  await expect.poll(async () => (await panes(shell, 'any')).length).toBe(count)
})

test('dragging a tool tab onto a pane edge makes a new pane, and the layout survives a restart', async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1400, 900)
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  await paneMenu(shell, 'p2', 'pane-add-tool-terminal-p2')
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p2', tabs: ['files', 'terminal'], active: 'terminal' }])

  // Drag Files to the app pane's bottom edge: the overlay shows the half of the pane (header and
  // body) it would take.
  const body = await box(shell, sel('pane-body-p1'))
  const pane = await box(shell, sel('pane-p1'))
  const zone = await dragTo(
    shell,
    sel('pane-tab-files'),
    body.x + body.width / 2,
    body.y + body.height - 24,
    (z) => Math.abs(z.height - pane.height / 2) <= 4,
  )
  expect(Math.abs(zone.y + zone.height - (pane.y + pane.height))).toBeLessThanOrEqual(4)
  expect(Math.abs(zone.height - pane.height / 2)).toBeLessThanOrEqual(4)

  await expect
    .poll(async () => (await panes(shell)).sort((a, b) => a.id.localeCompare(b.id)))
    .toEqual([
      { id: 'p2', tabs: ['terminal'], active: 'terminal' },
      { id: 'p3', tabs: ['files'], active: 'files' },
    ])
  const top = await box(shell, sel('pane-p1'))
  const below = await box(shell, sel('pane-p3'))
  expect(below.y).toBeGreaterThan(top.y + top.height)
  expect(Math.abs(below.x - top.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(below.width - top.width)).toBeLessThanOrEqual(1)
  await expect.poll(() => savedShape(configDir)).toEqual(['row', ['column', 'p1', 'p3'], 'p2'])

  // Drag Terminal onto the middle of the new pane: it joins that pane's tabs, and its own pane goes.
  const p3 = await box(shell, sel('pane-body-p3'))
  await dragTo(shell, sel('pane-tab-terminal'), p3.x + p3.width / 2, p3.y + p3.height / 2)
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p3', tabs: ['files', 'terminal'], active: 'terminal' }])
  await expect.poll(() => savedViews(configDir, 'p3')).toEqual(['files', 'terminal'])
  const want = await panes(shell, 'any')
  await app.close()

  // The same config dir brings the same panes back.
  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector(sel('rail'), { state: 'attached' })
    await page.waitForSelector(sel('pane-p3'), { state: 'attached' })
    await expect.poll(() => panes(page, 'any')).toEqual(want)
    const c = await box(page, sel('pane-p1'))
    const n = await box(page, sel('pane-p3'))
    expect(n.y).toBeGreaterThan(c.y + c.height)
    expect(savedShape(configDir)).toEqual(['column', 'p1', 'p3'])
  } finally {
    await app2.close()
  }
})

test("dragging an app tab onto the pane edge splits its workspace's app tabs; each pane gets its own strip, and they come back after a restart", async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1400, 900)
  // Two boards: two app tabs of one workspace (Canvas).
  await openBoard(shell, 'first-board', false)
  await openBoard(shell, 'second-board', true)
  // One pane of app tabs: one strip at the top, the window's.
  await expect(shell.locator(sel('tabbar'))).toHaveCount(1)
  const tabs = await panes(shell, 'app')
  expect(tabs).toHaveLength(1)
  expect(tabs[0]!.tabs).toHaveLength(2)
  const second = tabs[0]!.active!
  const body = await box(shell, sel('pane-body-p1'))

  // The second board's tab, dragged to the right edge, splits off a pane of its own.
  const zone = await dragTo(
    shell,
    `${sel('tabbar')} [data-app-tab="${second.slice(4)}"]`,
    body.x + body.width - 24,
    body.y + body.height / 2,
    (z) => Math.abs(z.width - body.width / 2) <= 4,
  )
  // The overlay is the pane's right half.
  expect(Math.abs(zone.x + zone.width - (body.x + body.width))).toBeLessThanOrEqual(4)
  expect(Math.abs(zone.width - body.width / 2)).toBeLessThanOrEqual(4)
  await expect.poll(async () => (await panes(shell, 'app')).length).toBe(2)
  const byX = async (p: PaneView) => (await box(shell, sel(`pane-${p.id}`))).x
  const split = await panes(shell, 'app')
  const xs = await Promise.all(split.map(byX))
  const [left, right] = xs[0]! < xs[1]! ? split : [split[1]!, split[0]!]
  expect(left!.tabs).not.toContain(second)
  expect(right!.tabs).toEqual([second])
  // Each pane of app tabs now has its own strip; the first keeps the window's controls.
  await expect(shell.locator(sel('tabbar'))).toHaveCount(1)
  await expect(
    shell.locator(`${sel(`pane-header-${right!.id}`)} ${sel(`tab-${second.slice(4)}`)}`),
  ).toBeVisible()
  await expect(shell.locator(sel(`pane-body-${right!.id}`))).toContainText('second-board')
  const want = await panes(shell, 'any')
  await expect.poll(() => savedViews(configDir, right!.id)).toEqual([second])
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector(sel(`pane-${right!.id}`), { state: 'attached' })
    await expect.poll(() => panes(page, 'any')).toEqual(want)
  } finally {
    await app2.close()
  }
})

// Dragging a shortcut is not a click on it: no drop target offers, and letting go changes nothing.
test("another workspace's pinned tab cannot be dragged out of its strip", async ({
  app,
  shell,
}) => {
  await size(app, shell, 1400, 900)
  await shell.locator(`${sel('tabbar')} ${sel('tab-0')}`).click({ button: 'right' })
  await shell.locator(sel('tab-menu-pin')).click()
  await openBoard(shell, 'first-board', false)
  await openBoard(shell, 'second-board', true)
  const tabs = await panes(shell, 'app')
  expect(tabs).toEqual([
    {
      id: 'p1',
      tabs: ['tab:0', expect.any(String), expect.any(String)],
      active: expect.any(String),
    },
  ])
  const body = await box(shell, sel('pane-body-p1'))

  // Dragging Dashboard's pinned shortcut to the pane's right edge offers no drop there, and
  // letting go leaves everything as it was: two workspaces never sit side by side.
  const pinned = await box(shell, sel('tab-pinned-0'))
  await shell.mouse.move(pinned.x + pinned.width / 2, pinned.y + pinned.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(pinned.x + pinned.width / 2 + 6, pinned.y + pinned.height / 2 + 6, {
    steps: 3,
  })
  await shell.mouse.move(body.x + body.width - 24, body.y + body.height / 2, { steps: 16 })
  await shell.waitForTimeout(300)
  await expect(shell.locator('.dv-drop-target-anchor, .dv-drop-target-selection')).toBeHidden()
  await shell.mouse.up()
  await shell.waitForTimeout(300)
  await expect.poll(() => scope(shell)).toBe('page:canvas')
  expect(await panes(shell, 'app')).toEqual(tabs)
  // Still in the lead pane's strip (the window's tab bar).
  await expect(shell.locator(`${sel('tabbar')} ${sel('tab-pinned-0')}`)).toBeVisible()
})

test('Cmd-click in the sidebar opens the page as a background tab; Cmd+Shift-click splits it beside', async ({
  shell,
}) => {
  await expect.poll(() => panes(shell)).toEqual(DEFAULT)
  const before = await panes(shell, 'app')
  await shell.locator(sel('nav-jobs')).click({ modifiers: ['Meta'] })
  // Jobs is a page tab of Dashboard's tool pane, not in front; the dashboard stays in front of
  // its own pane and keeps the workspace.
  await expect
    .poll(async () => (await panes(shell, 'any')).find((p) => p.id === 'p2'))
    .toEqual({ id: 'p2', tabs: ['files', 'view:page:jobs'], active: 'files' })
  expect((await panes(shell, 'app')).find((p) => p.id === 'p1')).toEqual(before[0])
  await expect.poll(() => scope(shell)).toBe('page:dashboard')
  await shell.locator(sel('pane-tab-view:page:jobs')).click()
  await expect(shell.locator(`${sel('pane-body-p2')} ${sel('page-jobs')}`)).toBeVisible()

  // Cmd+Shift-click splits a new pane off right of the focused pane, Habits in front there.
  await shell.locator(`${sel('tabbar')} ${sel('tab-0')}`).click()
  await shell.locator(sel('nav-habits')).click({ modifiers: ['Meta', 'Shift'] })
  await expect(shell.locator(sel('page-habits')).first()).toBeVisible()
  const shown = await panes(shell, 'any')
  const habits = shown.find((p) => p.active === 'view:page:habits')!
  expect(habits.tabs).toEqual(['view:page:habits'])
  expect(habits.id).not.toBe('p2')
  const p1 = await box(shell, sel('pane-p1'))
  const side = await box(shell, sel(`pane-${habits.id}`))
  expect(side.x).toBeGreaterThan(p1.x + p1.width)
  await expect.poll(() => scope(shell)).toBe('page:dashboard')
})

test('closing the last app tab leaves a Dashboard tab; closing the last tool tab closes its pane', async ({
  shell,
}) => {
  // Two boards: two app tabs of the Canvas workspace.
  await openBoard(shell, 'first-board', false)
  await openBoard(shell, 'second-board', true)
  await expect.poll(async () => (await panes(shell, 'app'))[0]!.tabs.length).toBe(2)
  for (;;) {
    const [p1] = await panes(shell, 'app')
    const close = shell.locator(`${sel('pane-p1')} .eva-tab-close`).first()
    if (p1!.tabs.length === 1) {
      await shell
        .locator(`${sel('pane-p1')} .eva-tab`)
        .first()
        .hover()
      await close.click()
      break
    }
    await close.click()
    await expect
      .poll(async () => (await panes(shell, 'app'))[0]!.tabs.length)
      .toBe(p1!.tabs.length - 1)
  }
  // The pane holding the app tabs never closes: Dashboard is there.
  await expect
    .poll(() =>
      shell.evaluate(() =>
        (window as unknown as ShellHooks).__evaosShell.tabs().list.map((t) => t.page),
      ),
    )
    .toEqual(['dashboard'])
  await expect(shell.locator(sel('pane-p1'))).toBeVisible()
  await expect(shell.locator(`${sel('pane-body-p1')} ${sel('page-dashboard')}`)).toBeVisible()

  // Tool tabs: closing Files and then Terminal closes the pane.
  await paneMenu(shell, 'p2', 'pane-add-tool-terminal-p2')
  await shell.locator(sel('pane-tab-files')).click()
  await shell.locator(sel('pane-tab-close-files')).click()
  await expect
    .poll(() => panes(shell))
    .toEqual([{ id: 'p2', tabs: ['terminal'], active: 'terminal' }])
  await shell.locator(sel('pane-tab-close-terminal')).click()
  await expect.poll(() => panes(shell)).toEqual([])
  await expect(shell.locator(sel('pane-p1'))).toBeVisible()
})
