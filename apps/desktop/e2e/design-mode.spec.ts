import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import {
  guestEval,
  navigate,
  newPage,
  pageTab,
  sendKey,
  webPanel,
  type BrowserHooks,
} from './helpers/web'

// Design Mode in a page tab (apps/desktop/docs/design-mode.md): the toggle in the address row,
// hover and pick in the page with Isaac's own (native) input, the inspector beside the page, a
// style edit previewed live, a drawing on the crop, Send to the workspace's chat (the fake omp
// logs the prompt), the selection kept through a hot update and a reload, and Esc. Screenshots
// go to proof/phase-design-mode/ (EVAOS_PROOF=1).

const LOG = path.join(os.tmpdir(), `evaos-fake-omp-design-${process.pid}.log`)
const PHASE = 'phase-design-mode'

type Ev = { event: string; detail: Record<string, unknown> | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []

/** Isaac's own mouse in page `id` (native input events, as his trackpad sends them). */
function mouse(
  app: ElectronApplication,
  id: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  return app.evaluate(
    (_e, a) => {
      const h = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
      const wc = h.tabById(a.id)
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

/** Shift pressed or let go in the shell, as native input (Playwright's keys skip Electron's hooks). */
const shellKey = (app: ElectronApplication, type: 'keyDown' | 'keyUp') =>
  app.evaluate(
    (_e, t) =>
      (
        globalThis as unknown as {
          __evaosTest: { shell: { webContents: { sendInputEvent(e: object): void } } }
        }
      ).__evaosTest.shell.webContents.sendInputEvent({
        type: t,
        keyCode: 'Shift',
        modifiers: t === 'keyDown' ? ['shift'] : [],
      }),
    type,
  )

/** The center of the element `selector` names in page `id`, in viewport px. */
async function centerOf(app: ElectronApplication, id: string, selector: string) {
  return (await guestEval(
    app,
    id,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
  )) as { x: number; y: number }
}

/** What the in-page overlay (isolated world) draws: the hover label and the numbered frames. */
function overlayState(
  app: ElectronApplication,
  id: string,
): Promise<{ hover: string; hoverShown: boolean; frames: number } | null> {
  return app.evaluate(
    async (_e, a) => {
      const hooks = (
        globalThis as unknown as {
          __evaosTest: {
            hooks: {
              browser: {
                pageControl(id: string): {
                  inWorld<T>(name: string, expression: string): Promise<T>
                }
              }
            }
          }
        }
      ).__evaosTest.hooks.browser
      return hooks
        .pageControl(a.id)
        .inWorld<{ hover: string; hoverShown: boolean; frames: number } | null>(
          'relay-design',
          `(() => { const o = globalThis.__relayDesign; if (!o || !o.host.isConnected) return null; return { hover: o.tag.textContent, hoverShown: o.hover.style.display === 'block', frames: o.picked.filter((p) => p.frame.style.display === 'block').length } })()`,
        )
    },
    { id },
  )
}

const inspector = (shell: Page, id: string) =>
  webPanel(shell, id).locator('[data-testid=design-inspector]')

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
  fs.rmSync(LOG, { force: true })
})

test.use({ launchEnv: { FAKE_OMP_DELAY_MS: '5', FAKE_OMP_LOG: LOG } })

test('Design Mode: pick, inspect, edit, draw, send, keep the selection, Esc', async ({
  app,
  shell,
}) => {
  fs.rmSync(LOG, { force: true })
  // A desktop-sized window: the chat, and the page with the inspector beside it.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeGreaterThan(1700)
  // A1: no Design Mode on a blank page.
  const id = await newPage(shell)
  const panel = webPanel(shell, id)
  const toggle = panel.locator('[data-testid=btn-design-mode]')
  await expect(toggle).toBeDisabled()
  // Isaac widens the page's pane for design work: the chat's divider dragged left.
  const pageBox = (await panel.boundingBox())!
  const sash = shell.locator('.dv-sash').filter({ visible: true })
  const near = await sash.evaluateAll(
    (els, x) => els.findIndex((e) => Math.abs(e.getBoundingClientRect().x - x) < 12),
    pageBox.x,
  )
  expect(near).toBeGreaterThanOrEqual(0)
  const s = (await sash.nth(near).boundingBox())!
  await shell.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(s.x - 520, s.y + s.height / 2, { steps: 8 })
  await shell.mouse.up()
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(900)

  await navigate(shell, id, server.url('/design.html'))
  await expect(pageTab(shell, id)).toContainText('Design fixture')
  await expect.poll(() => guestEval(app, id, 'document.readyState')).toBe('complete')
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await proofShot(app, shell, 'before-page', { phase: PHASE })

  // A1: on.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(inspector(shell, id)).toBeVisible()
  await expect(inspector(shell, id).locator('[data-testid=design-hint]')).toBeVisible()
  await expect.poll(() => overlayState(app, id)).not.toBeNull()
  // A wide pane: the inspector stands beside the page, which keeps the rest.
  await expect
    .poll(async () => {
      const ins = (await inspector(shell, id).boundingBox())!
      const slot = (await panel.locator('[data-testid=browser-slot]').boundingBox())!
      return ins.x >= slot.x + slot.width - 1 && Math.abs(ins.y - slot.y) < 2
    })
    .toBe(true)
  await expect.poll(() => guestEval(app, id, 'innerWidth')).toBeGreaterThan(600)

  // A2: hover highlights in the page.
  const save = await centerOf(app, id, '#save')
  await mouse(app, id, [{ type: 'mouseMove', ...save }])
  await expect
    .poll(() => overlayState(app, id))
    .toMatchObject({ hover: 'button#save', hoverShown: true })
  await proofShot(app, shell, 'hover', { phase: PHASE })

  // A2 + A3: a click selects and never reaches the page.
  await click(app, id, save)
  const items = inspector(shell, id).locator('[data-testid=design-item]')
  await expect(items).toHaveCount(1)
  expect(await guestEval(app, id, 'window.clicks')).toBe(0)
  // A4: label, React source and component, styles, crop.
  await expect(items.first().locator('[data-testid=design-item-label]')).toHaveText('button#save')
  await expect(items.first().locator('[data-testid=design-item-source]')).toHaveText(
    'SaveButton · components/SaveButton.tsx:12',
  )
  await expect(inspector(shell, id).locator('[data-testid=design-source]')).toHaveText(
    'src/components/SaveButton.tsx:12',
  )
  await expect(inspector(shell, id).locator('[data-testid=design-style-padding]')).toHaveValue(
    '10px 18px',
  )
  await expect(
    inspector(shell, id).locator('[data-testid=design-style-background-color]'),
  ).toHaveValue('rgb(47, 111, 235)')
  const crop = inspector(shell, id).locator('[data-testid=design-crop]')
  await expect(crop).toBeVisible()
  const plainCrop = await crop.getAttribute('src')

  // A3: shift-click adds a second element; its source comes from data attributes. Shift is held
  // in the shell, which keeps the keyboard while Isaac points into the page.
  await inspector(shell, id).locator('[data-testid=design-exit]').focus()
  await shellKey(app, 'keyDown')
  await click(app, id, await centerOf(app, id, '.card h2'))
  await expect(items).toHaveCount(2)
  await shellKey(app, 'keyUp')
  await expect(items.nth(1).locator('[data-testid=design-item-source]')).toHaveText(
    'Card · components/Card.tsx:7',
  )
  await expect.poll(async () => (await overlayState(app, id))?.frames).toBe(2)

  // A2: the wheel still scrolls the page.
  const ended = guestEval(
    app,
    id,
    "new Promise((r) => addEventListener('scrollend', () => r(scrollY), { once: true }))",
  )
  await mouse(app, id, [{ type: 'mouseWheel', ...save, deltaX: 0, deltaY: -300 }])
  expect(await ended).toBeGreaterThan(0)
  await guestEval(app, id, "scrollTo({ top: 0, behavior: 'instant' })")
  await expect.poll(() => guestEval(app, id, 'scrollY')).toBe(0)

  // A6: a style edit previews in the page.
  await items.first().locator('.eva-design-item-main').click()
  const padding = inspector(shell, id).locator('[data-testid=design-style-padding]')
  await padding.fill('6px 12px')
  await padding.press('Enter')
  await expect
    .poll(() => guestEval(app, id, "getComputedStyle(document.getElementById('save')).padding"))
    .toBe('6px 12px')
  await expect(inspector(shell, id).locator('[data-testid=design-status]')).toHaveText(
    '1 style edit',
  )

  // A7: drawing on the crop replaces it.
  await inspector(shell, id).locator('[data-testid=design-draw]').click()
  const canvas = shell.locator('[data-testid=design-canvas]')
  await expect(canvas).toBeVisible()
  const box = (await canvas.boundingBox())!
  await shell.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.3)
  await shell.mouse.down()
  await shell.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.8, { steps: 6 })
  await shell.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.3, { steps: 6 })
  await shell.mouse.up()
  await proofShot(app, shell, 'annotate', { phase: PHASE })
  await shell.locator('[data-testid=design-annotate-done]').click()
  await expect(canvas).toHaveCount(0)
  await expect(inspector(shell, id).locator('[data-testid=design-draw]')).toHaveText('Drawn on')
  // The crop may refresh after the style preview; the drawn one must differ from any plain one.
  const drawn = await crop.getAttribute('src')
  expect(drawn).not.toBe(plainCrop)

  // A5: the instruction and Send reach the workspace chat's omp as one prompt with images.
  const send = inspector(shell, id).locator('[data-testid=design-send]')
  await inspector(shell, id)
    .locator('[data-testid=design-instruction]')
    .fill('make this button quieter')
  await proofShot(app, shell, 'after-inspector', { phase: PHASE })
  await expect(send).toBeEnabled()
  await send.click()
  await expect(inspector(shell, id).locator('[data-testid=design-status]')).toContainText('Sent')
  await expect
    .poll(() => readLog().find((e) => e.event === 'prompt-images')?.detail ?? null)
    .toEqual({ count: 2, mimeTypes: ['image/png', 'image/png'] })
  const prompt = String(
    readLog().find((e) => e.event === 'prompt' && String(e.detail?.['message']).includes('[Design'))
      ?.detail?.['message'] ?? '',
  )
  expect(prompt).toContain('Change: "make this button quieter"')
  expect(prompt).toContain('Selector: "#save"')
  expect(prompt).toContain('Source: "src/components/SaveButton.tsx:12:5"')
  expect(prompt).toContain('Component: "SaveButton"')
  expect(prompt).toContain('DOM: "<button class=\\"primary\\" id=\\"save\\"')
  expect(prompt).toContain('padding "10px 18px" -> "6px 12px"')
  expect(prompt).toContain('the user drew on it')
  expect(prompt).toContain('Source: "src/components/Card.tsx:7"')
  // Sent: an empty request can't go again.
  await expect(send).toBeDisabled()
  // The chat shows the request compactly: the change and the elements; the prompt under Details.
  const bubble = shell.locator('[data-testid=chat-log] [data-testid=design-request]')
  await expect(bubble).toContainText('make this button quieter')
  await expect(bubble).toContainText('src/components/SaveButton.tsx:12:5')
  await expect(bubble).not.toContainText('Styles now')

  // A8: a hot update replaces the card's nodes; the selection follows.
  await guestEval(app, id, "window.hotSwap('28px')")
  await expect
    .poll(() => guestEval(app, id, "getComputedStyle(document.querySelector('.card')).padding"))
    .toBe('28px')
  await expect.poll(async () => (await overlayState(app, id))?.frames).toBe(2)
  await expect(items).toHaveCount(2)
  await expect(items.nth(1)).not.toHaveAttribute('data-missing', 'true')

  // A8: a change inside a selected element alone (no new text, size or style of its own) is
  // read again too: main's signature of the selection moves.
  const sigOf = () =>
    app.evaluate(
      (_e, tabId) =>
        (
          globalThis as unknown as {
            __evaosTest: { hooks: { design: { sessions: Map<string, { sig: string }> } } }
          }
        ).__evaosTest.hooks.design.sessions.get(tabId)?.sig ?? null,
      id,
    )
  const sigBefore = await sigOf()
  await guestEval(
    app,
    id,
    "document.querySelector('h2').appendChild(document.createElement('i')); 1",
  )
  await expect.poll(sigOf).not.toBe(sigBefore)

  // A8: a full reload keeps the selection too.
  await guestEval(app, id, 'location.reload()')
  await expect.poll(() => guestEval(app, id, 'window.clicks')).toBe(0)
  await expect.poll(async () => (await overlayState(app, id))?.frames, { timeout: 10_000 }).toBe(2)
  await expect(items).toHaveCount(2)
  await expect(items.first().locator('[data-testid=design-item-label]')).toHaveText('button#save')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await proofShot(app, shell, 'after-reload', { phase: PHASE })

  // A narrow window: the inspector moves under the page, which keeps its width.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1100, 900))
  await expect
    .poll(async () => {
      const ins = await inspector(shell, id).boundingBox()
      const slot = await panel.locator('[data-testid=browser-slot]').boundingBox()
      return ins && slot ? ins.y >= slot.y + slot.height - 1 : false
    })
    .toBe(true)
  const paneWidth = (await panel.boundingBox())!.width
  await expect
    .poll(async () => Number(await guestEval(app, id, 'innerWidth')))
    .toBeGreaterThan(paneWidth - 8)
  // The panel stays inside its pane and Send stays inside the stacked inspector.
  const paneBody = (await panel.locator('xpath=..').boundingBox())!
  const panelBox = (await panel.boundingBox())!
  const insBox = (await inspector(shell, id).boundingBox())!
  const sendBox = (await send.boundingBox())!
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(paneBody.y + paneBody.height + 1)
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(insBox.y + insBox.height)
  await expect.poll(async () => (await overlayState(app, id))?.frames).toBe(2)
  await proofShot(app, shell, 'after-narrow', { phase: PHASE })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeGreaterThan(1700)

  // A9: Esc in the page exits and removes the overlay.
  await sendKey(app, id, 'Escape', [])
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(inspector(shell, id)).toHaveCount(0)
  await expect
    .poll(() => guestEval(app, id, "document.querySelector('relay-design') === null"))
    .toBe(true)
  // Page input reaches the page again once main has ended the session.
  await expect
    .poll(() =>
      app.evaluate(
        (_e, tabId) =>
          (
            globalThis as unknown as {
              __evaosTest: { hooks: { design: { isOn(id: string): boolean } } }
            }
          ).__evaosTest.hooks.design.isOn(tabId),
        id,
      ),
    )
    .toBe(false)
  // The page has its wide bounds again (a click sent mid-resize can miss it).
  await expect.poll(() => guestEval(app, id, 'innerWidth')).toBeGreaterThan(900)
  await click(app, id, await centerOf(app, id, '#save'))
  await expect.poll(() => guestEval(app, id, 'window.clicks')).toBe(1)

  // A9: Esc from the inspector exits too.
  await toggle.click()
  await expect(inspector(shell, id)).toBeVisible()
  await expect.poll(() => overlayState(app, id)).not.toBeNull()
  await inspector(shell, id).locator('[data-testid=design-exit]').focus()
  await shell.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(() => guestEval(app, id, "document.querySelector('relay-design') === null"))
    .toBe(true)
})
