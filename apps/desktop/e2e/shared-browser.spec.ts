import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { guestEval, openPage, pageIds, paneOfPage, webPanel } from './helpers/web'

const test = base.extend({ launchEnv: { EVAOS_AGENT_CONTROL: '1' } })

interface AgentResult {
  ok: boolean
  value?: Record<string, unknown>
  code?: string
  message?: string
}

/** The app's agent control API, as relay-ctl calls it (bearer token from the control file). */
async function controlApi(configDir: string) {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  return async (action: string, params: Record<string, unknown>, scope = 'agent:nova') => {
    const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params, scope }),
    })
    return (await res.json()) as AgentResult
  }
}

/** Isaac's control on an agent's tab (Allow, Not now, Take over, Hand back). */
function agentOp(app: ElectronApplication, tabId: string, op: string): Promise<void> {
  return app.evaluate(
    (_e, a) => {
      const g = globalThis as unknown as {
        __evaosTest: { hooks: { agentDrive: { op(id: string, op: string): void } } }
      }
      g.__evaosTest.hooks.agentDrive.op(a.tabId, a.op)
    },
    { tabId, op },
  )
}

/** Isaac's own mouse press in page `id` (native input, not the drive's). */
function isaacClicks(app: ElectronApplication, id: string): Promise<void> {
  return app.evaluate(
    (_e, a) => {
      const g = globalThis as unknown as {
        __evaosTest: {
          hooks: {
            browser: {
              host: { tabById(id: string): { sendInputEvent(e: object): void } | undefined }
            }
          }
        }
      }
      const wc = g.__evaosTest.hooks.browser.host.tabById(a.id)
      if (!wc) throw new Error(`no page ${a.id}`)
      wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 })
    },
    { id },
  )
}

// The shared browser: Relay's page tabs read like a real browser (one-click New tab, an address
// field that shows the host first), and assistants drive pages in Isaac's signed-in session.

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('browser chrome: New tab in one click, host-first address', async ({ app, shell }) => {
  const first = await openPage(shell, server.url('/a.html?q=1'), 'Page A')
  const panel = webPanel(shell, first)
  const shown = panel.locator('[data-testid=address-display]')
  await expect(shown).toHaveText(`http://127.0.0.1:${server.port}/a.html?q=1`)
  await expect(shown.locator('span')).toHaveText('/a.html?q=1')
  await proofShot(app, shell, 'chrome-address', { phase: 'shared-browser' })
  // Editing shows the whole address as typed.
  await panel.locator('[data-testid=address-input]').click()
  await expect(shown).toHaveCount(0)
  await expect(panel.locator('[data-testid=address-input]')).toHaveValue(server.url('/a.html?q=1'))
  await shell.keyboard.press('Escape')

  // A pane of pages: + opens a blank page right there, its address focused.
  const pane = await paneOfPage(shell, first)
  await shell.locator(`[data-testid=page-new-tab-${pane}]`).click()
  await expect.poll(async () => (await pageIds(shell)).length).toBe(2)
  const second = (await pageIds(shell)).find((x) => x !== first)!
  expect(await paneOfPage(shell, second)).toBe(pane)
  await expect(webPanel(shell, second).locator('[data-testid=address-input]')).toBeFocused()
  // The add menu stays one click away, behind the chevron.
  await shell.locator(`[data-testid=pane-add-${pane}]`).click()
  await expect(shell.locator(`[data-testid=pane-add-menu-${pane}]`)).toBeVisible()
})

test('agents drive a page off screen: read, type, click, ask before buying, pause for Isaac', async ({
  app,
  shell,
  configDir,
}) => {
  await expect(shell.locator('[data-pane-tab]').first()).toBeVisible()
  const run = await controlApi(configDir)
  const ok = async (action: string, params: Record<string, unknown>) => {
    const r = await run(action, params)
    expect(r, `${action}: ${r.message}`).toMatchObject({ ok: true })
    return r.value!
  }
  // Nova's workspace is not on screen: her page opens there, in the background.
  const opened = await ok('browser.open', { url: server.url('/shop.html') })
  const tabId = opened.tabId as string
  expect(opened.background).toBe(true)
  const listed = (await ok('browser.tabs', {})).tabs as Array<{
    tabId: string
    agent?: { name: string; status: string; caption: string }
  }>
  expect(listed.find((t) => t.tabId === tabId)?.agent).toMatchObject({
    name: 'Nova',
    status: 'idle',
  })
  await expect
    .poll(async () => (await ok('browser.read', { tabId, mode: 'text' })).text)
    .toContain('Deals')

  // The outline names every control with a ref the actions take.
  const outline = (await ok('browser.read', { tabId })).outline as string
  expect(outline).toMatch(/\[n\d+\] searchbox "Search Shop"/)
  expect(outline).toMatch(/\[n\d+\] button "Go"/)

  // Typing a search and pressing Enter never asks: search forms are not consequential.
  const typed = await ok('browser.type', {
    tabId,
    label: 'Search Shop',
    text: 'ORICO 2TB',
    submit: true,
    caption: 'Searching for a 2TB SSD',
  })
  expect(typed.url).toContain('q=ORICO+2TB')
  const working = ((await ok('browser.tabs', {})).tabs as typeof listed).find(
    (t) => t.tabId === tabId,
  )
  expect(working?.agent).toMatchObject({ status: 'working', caption: 'Searching for a 2TB SSD' })

  // Clicks are real input (trusted events), by visible text or by ref.
  await ok('browser.click', { tabId, text: 'Add to Cart' })
  expect(await guestEval(app, tabId, 'window.clicks')).toEqual({ trusted: 1, untrusted: 0 })
  const ref = /\[(n\d+)\] link "Proceed to checkout"/.exec(
    (await ok('browser.read', { tabId })).outline as string,
  )![1]
  const checkout = await ok('browser.click', { tabId, ref })
  expect(checkout.url).toContain('/checkout.html')

  // A page off screen still lays out and screenshots.
  const shot = await ok('browser.screenshot', { tabId })
  expect(shot.width as number).toBeGreaterThan(300)
  expect(
    Buffer.from(shot.png as string, 'base64')
      .subarray(1, 4)
      .toString(),
  ).toBe('PNG')

  // Placing the order waits for Isaac's Allow, and says what it costs.
  const placing = run('browser.click', { tabId, text: 'Place your order' })
  await expect
    .poll(
      async () =>
        ((await ok('browser.tabs', {})).tabs as typeof listed).find((t) => t.tabId === tabId)?.agent
          ?.status,
    )
    .toBe('ask')
  const asking = (await app.evaluate(
    (_e, id) =>
      (
        globalThis as unknown as {
          __evaosTest: { hooks: { browser: { host: { agentOf(id: string): unknown } } } }
        }
      ).__evaosTest.hooks.browser.host.agentOf(id),
    tabId,
  )) as { ask: { label: string } }
  expect(asking.ask.label).toBe('place your order, $89.99')
  expect(await guestEval(app, tabId, 'document.getElementById("placed").hidden')).toBe(true)
  // While it waits, other actions say so.
  expect(await run('browser.scroll', { tabId, dy: 100 })).toMatchObject({
    ok: false,
    code: 'awaiting-approval',
  })
  await agentOp(app, tabId, 'allow')
  expect(await placing).toMatchObject({ ok: true })
  expect(await guestEval(app, tabId, 'document.getElementById("placed").hidden')).toBe(false)

  // Isaac clicks in the page: the agent pauses until he hands back.
  await isaacClicks(app, tabId)
  expect(await run('browser.navigate', { tabId, go: 'back' })).toMatchObject({
    ok: false,
    code: 'paused-by-isaac',
  })
  const waiting = run('browser.wait', { tabId, until: 'handback', timeoutMs: 20_000 })
  await agentOp(app, tabId, 'handBack')
  expect(await waiting).toMatchObject({ ok: true, value: { met: true, status: 'working' } })

  // Not now stops it, and the agent hears so.
  await ok('browser.navigate', { tabId, go: 'reload' })
  const again = run('browser.click', { tabId, text: 'Place your order' })
  await expect
    .poll(
      async () =>
        ((await ok('browser.tabs', {})).tabs as typeof listed).find((t) => t.tabId === tabId)?.agent
          ?.status,
    )
    .toBe('ask')
  await agentOp(app, tabId, 'deny')
  expect(await again).toMatchObject({ ok: false, code: 'declined-by-isaac' })

  await ok('browser.done', { tabId, summary: 'Ordered ORICO 2TB, $89.99' })
  const done = ((await ok('browser.tabs', {})).tabs as typeof listed).find((t) => t.tabId === tabId)
  expect(done?.agent).toMatchObject({ status: 'done', caption: 'Ordered ORICO 2TB, $89.99' })
})
