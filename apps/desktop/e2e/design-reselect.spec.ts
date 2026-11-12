import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { guestEval, navigate, newPage, sendKey, webPanel, type BrowserHooks } from './helpers/web'

// Design Mode keeps the element Isaac picked through a reload and a re-render of a list of cards
// alike (apps/desktop/docs/design-mode.md): its path names it alone, and the fingerprint taken at
// the pick finds it again when the path no longer does. The second test is the bug Isaac hit on
// the demo shop: a card picked while a search showed it alone came back as the first card.
// Helpers are copied from design-mode.spec.ts.

/** The hooks main puts on globalThis in an e2e run (design-mode.spec.ts reads the same). */
type Hooks = {
  __evaosTest: {
    hooks: {
      browser: {
        host: BrowserHooks['__evaosTest']['hooks']['browser']['host']
        pageControl(id: string): { inWorld<T>(name: string, expression: string): Promise<T> }
      }
      design: { sessions: Map<string, { selectors: string[] }> }
    }
  }
}

/** Isaac's own mouse in page `id` (native input events, as his trackpad sends them). */
function mouse(
  app: ElectronApplication,
  id: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  return app.evaluate(
    (_e, a) => {
      // Main's e2e hooks: installed in test runs, not typed on globalThis.
      const g = globalThis as unknown as Hooks
      const wc = g.__evaosTest.hooks.browser.host.tabById(a.id)
      if (!wc) throw new Error(`no page ${a.id}`)
      for (const ev of a.events) wc.sendInputEvent(ev)
    },
    { id, events },
  )
}

/** Isaac's click in page `id` at `at` (move, press, release). */
const click = (app: ElectronApplication, id: string, at: { x: number; y: number }) =>
  mouse(app, id, [
    { type: 'mouseMove', ...at },
    { type: 'mouseDown', ...at, button: 'left', clickCount: 1 },
    { type: 'mouseUp', ...at, button: 'left', clickCount: 1 },
  ])

/** A point in the left padding of the `n`th card (from 1): the card itself, not its text. */
async function cardEdge(app: ElectronApplication, id: string, n: number) {
  return (await guestEval(
    app,
    id,
    `(() => { const r = document.querySelectorAll('#grid > .card')[${n - 1}].getBoundingClientRect(); return { x: Math.round(r.x + 6), y: Math.round(r.y + r.height / 2) } })()`,
  )) as { x: number; y: number }
}

/**
 * The in-page overlay's (isolated world) first selected element: its place among its siblings
 * (from 1) and its heading's text, while its frame shows; null otherwise.
 */
function selected(
  app: ElectronApplication,
  id: string,
): Promise<{ place: number; text: string } | null> {
  return app.evaluate(
    async (_e, a) => {
      // Main's e2e hooks: installed in test runs, not typed on globalThis.
      const g = globalThis as unknown as Hooks
      return g.__evaosTest.hooks.browser
        .pageControl(a.id)
        .inWorld<{ place: number; text: string } | null>(
          'relay-design',
          `(() => { const o = globalThis.__relayDesign; if (!o || !o.host.isConnected) return null; const p = o.picked[0]; const e = p && p.element; if (!e || !e.isConnected || p.frame.style.display !== 'block') return null; return { place: Array.from(e.parentElement.children).indexOf(e) + 1, text: (e.querySelector('h3') || e).textContent.trim() } })()`,
        )
    },
    { id },
  )
}

/** The selection's paths as main keeps them (and sends them to the chat). */
function sessionSelectors(app: ElectronApplication, id: string): Promise<string[] | null> {
  return app.evaluate((_e, tabId) => {
    // Main's e2e hooks: installed in test runs, not typed on globalThis.
    const g = globalThis as unknown as Hooks
    const s = g.__evaosTest.hooks.design.sessions.get(tabId)
    return s ? [...s.selectors] : null
  }, id)
}

/** How many elements `selector` names in page `id`, and the place (from 1) of the one it names. */
async function named(
  app: ElectronApplication,
  id: string,
  selector: string,
): Promise<{ count: number; place: number | null; text: string | null }> {
  return (await guestEval(
    app,
    id,
    `(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); const e = all.length === 1 ? all[0] : null; return { count: all.length, place: e ? Array.from(e.parentElement.children).indexOf(e) + 1 : null, text: e ? (e.querySelector('h3') || e).textContent.trim() : null } })()`,
  )) as { count: number; place: number | null; text: string | null }
}

const inspector = (shell: Page, id: string) =>
  webPanel(shell, id).locator('[data-testid=design-inspector]')

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

/** A page tab at `path` with Design Mode on, in a pane wide enough for its toggle. */
async function designOn(app: ElectronApplication, shell: Page, path: string, setup?: string) {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(2200, 1000))
  const id = await newPage(shell)
  const toggle = webPanel(shell, id).locator('[data-testid=btn-design-mode]')
  await navigate(shell, id, server.url(path))
  await expect.poll(() => guestEval(app, id, 'document.readyState')).toBe('complete')
  if (setup) await guestEval(app, id, setup)
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => guestEval(app, id, `!!document.getElementById('relay-note-picker')`))
    .toBe(true)
  return { id, toggle }
}

/** Reloads page `id` and waits for the new document (the old one is marked first). */
async function reload(app: ElectronApplication, id: string): Promise<void> {
  await guestEval(app, id, 'window.oldDocument = true; 1')
  await guestEval(app, id, 'location.reload()')
  await expect
    .poll(() => guestEval(app, id, 'window.oldDocument === undefined').catch(() => false))
    .toBe(true)
}

test('Design Mode: the 5th of six identical cards stays selected through a reload and a re-render', async ({
  app,
  shell,
}) => {
  const { id, toggle } = await designOn(app, shell, '/design-cards.html')
  await click(app, id, await cardEdge(app, id, 5))
  const items = inspector(shell, id).locator('[data-testid=design-item]')
  await expect(items).toHaveCount(1)
  await expect.poll(() => selected(app, id)).toEqual({ place: 5, text: 'Plant' })
  // The path main keeps names that card and no other.
  const [picked] = (await sessionSelectors(app, id))!
  expect(await named(app, id, picked!)).toEqual({ count: 1, place: 5, text: 'Plant' })

  await reload(app, id)
  await expect
    .poll(() => selected(app, id), { timeout: 10_000 })
    .toEqual({ place: 5, text: 'Plant' })
  const [kept] = (await sessionSelectors(app, id))!
  expect(await named(app, id, kept!)).toEqual({ count: 1, place: 5, text: 'Plant' })
  await expect(items).toHaveCount(1)
  await expect(items.first()).not.toHaveAttribute('data-missing', 'true')

  // The page builds its cards again in place: the selection follows to the new 5th card.
  await guestEval(app, id, 'render(); 1')
  await expect.poll(() => selected(app, id)).toEqual({ place: 5, text: 'Plant' })

  await sendKey(app, id, 'Escape', [])
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('Design Mode: a card picked while a search showed it alone is still that card after the reload', async ({
  app,
  shell,
}) => {
  // The tour searched "light": only the Grow Light Bar card shows when Isaac picks it.
  const { id, toggle } = await designOn(
    app,
    shell,
    '/demo-shop.html',
    "document.getElementById('q').value = 'light'; document.getElementById('go').click(); 1",
  )
  expect(await guestEval(app, id, "document.querySelectorAll('#grid > .card').length")).toBe(1)
  await click(app, id, await cardEdge(app, id, 1))
  const items = inspector(shell, id).locator('[data-testid=design-item]')
  await expect(items).toHaveCount(1)
  await expect.poll(() => selected(app, id)).toEqual({ place: 1, text: 'Grow Light Bar' })
  // Alone in the grid, its path needs no position: it names every card once the grid is whole.
  const [picked] = (await sessionSelectors(app, id))!
  expect(picked).toBe('#grid > div.card')

  // The reload shows all six cards; the Grow Light Bar card is the 5th.
  await reload(app, id)
  await expect
    .poll(() => selected(app, id), { timeout: 10_000 })
    .toEqual({ place: 5, text: 'Grow Light Bar' })
  // Main keeps (and a Send would carry) a path that names that card alone.
  await expect
    .poll(async () => named(app, id, (await sessionSelectors(app, id))![0]!))
    .toEqual({ count: 1, place: 5, text: 'Grow Light Bar' })
  await expect(items).toHaveCount(1)
  await expect(items.first()).not.toHaveAttribute('data-missing', 'true')

  await sendKey(app, id, 'Escape', [])
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})
