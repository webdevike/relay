import * as fs from 'node:fs'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import {
  frames,
  guestEval,
  openPage,
  sendKey,
  viewOf,
  webPanel,
  type BrowserHooks,
} from './helpers/web'

/**
 * Note for chat (browser.annotate): Isaac picks an element or drags a region on a page, writes
 * a note in the shell (never in the page) and sends it. The note reaches the sender (test hook
 * `browserAnnotate`, whose `answer` stands in for the chat) with the mark and a PNG of it.
 */
interface Note {
  surface: 'browser'
  text: string
  url: string
  title: string
  tabId: string
  element?: { tag: string; role?: string; text?: string; selector?: string }
  region: { x: number; y: number; w: number; h: number }
  image?: string
}
type Hooks = BrowserHooks & {
  __evaosTest: {
    hooks: {
      browserAnnotate: {
        notes: Array<{ note: Note; workspace: string | null }>
        answer: { sent: boolean; to: string | null } | null
      }
    }
  }
}

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const stubChat = (app: ElectronApplication): Promise<void> =>
  app.evaluate(() => {
    ;(globalThis as unknown as Hooks).__evaosTest.hooks.browserAnnotate.answer = {
      sent: true,
      to: 'Fixture chat',
    }
  })

const notes = (
  app: ElectronApplication,
): Promise<Array<{ note: Note; workspace: string | null }>> =>
  app.evaluate(() => (globalThis as unknown as Hooks).__evaosTest.hooks.browserAnnotate.notes)

/** Mouse input inside page `id` as the guest's own (trusted) events, in view px. */
const mouse = (
  app: ElectronApplication,
  id: string,
  steps: Array<{ type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number }>,
): Promise<void> =>
  app.evaluate(
    (_e, a) => {
      const wc = (globalThis as unknown as Hooks).__evaosTest.hooks.browser.host.tabById(a.id)
      if (!wc) throw new Error(`no page ${a.id}`)
      for (const s of a.steps) {
        wc.sendInputEvent({
          ...s,
          ...(s.type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }),
        })
      }
    },
    { id, steps },
  )

/** The note's field in the shell, once the mark is made (the page's address row turns into it). */
const noteField = (shell: Page, id: string): Locator =>
  webPanel(shell, id).getByTestId('annotate-composer').getByTestId('annotate-note')

/** Writes the note key by key in the shell and sends it with Enter. */
const writeAndSend = async (shell: Page, id: string, text: string): Promise<void> => {
  const field = noteField(shell, id)
  await expect(field).toBeFocused()
  await field.pressSequentially(text)
  await field.press('Enter')
}

const pickerOpen = (app: ElectronApplication, id: string): Promise<unknown> =>
  guestEval(app, id, `!!document.getElementById('relay-note-picker')`)

/** The middle of `#btn` on page `id`, in view px, and its box. */
const buttonOf = async (app: ElectronApplication, id: string) => {
  const btn = (await guestEval(
    app,
    id,
    `(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`,
  )) as { x: number; y: number; w: number; h: number }
  return { btn, cx: Math.round(btn.x + btn.w / 2), cy: Math.round(btn.y + btn.h / 2) }
}

test('a note on a page element goes to the chat with the element and its picture', async ({
  app,
  shell,
}) => {
  const url = server.url('/b.html')
  const id = await openPage(shell, url, 'Page B')
  await stubChat(app)
  const panel = webPanel(shell, id)

  // A second Note for chat restarts the picker: one picker, the first answers cancelled.
  await panel.getByTestId('btn-annotate').click()
  await expect.poll(() => pickerOpen(app, id)).toBe(true)
  await panel.getByTestId('btn-annotate').click()
  await expect
    .poll(() => guestEval(app, id, `document.querySelectorAll('#relay-note-picker').length`))
    .toBe(1)
  const { btn, cx, cy } = await buttonOf(app, id)
  await mouse(app, id, [
    { type: 'mouseMove', x: cx - 3, y: cy },
    { type: 'mouseMove', x: cx, y: cy },
  ])
  await proofShot(app, shell, 'browser-annotate-hover', { phase: 'canvas-drive' })
  const before = await viewOf(app, id)
  await mouse(app, id, [
    { type: 'mouseDown', x: cx, y: cy },
    { type: 'mouseUp', x: cx, y: cy },
  ])
  // The shell takes the note; the page keeps the mark's outline and doesn't move.
  const field = noteField(shell, id)
  await expect(field).toBeFocused()
  await expect(panel.getByTestId('annotate-mark')).toContainText('button')
  expect(await pickerOpen(app, id)).toBe(true)
  await frames(shell)
  expect(await viewOf(app, id)).toEqual(before)
  await field.pressSequentially('Make this button bigger')
  await proofShot(app, shell, 'browser-annotate-compose', { phase: 'canvas-drive' })
  await field.press('Enter')

  await expect(shell.getByText('Sent to Fixture chat')).toBeVisible()
  const sent = await notes(app)
  expect(sent).toHaveLength(1)
  const { note, workspace } = sent[0]!
  expect(workspace).toMatch(/^chat:|^draft:|^page:/)
  expect(note).toMatchObject({
    surface: 'browser',
    text: 'Make this button bigger',
    url,
    title: 'Page B',
    tabId: id,
    element: { tag: 'button', role: 'button', text: 'Click me', selector: '#btn' },
    region: {
      x: Math.floor(btn.x),
      y: Math.floor(btn.y),
      w: Math.ceil(btn.x + btn.w) - Math.floor(btn.x),
      h: Math.ceil(btn.y + btn.h) - Math.floor(btn.y),
    },
  })
  expect(note.image).toBeTruthy()
  const png = fs.readFileSync(note.image!)
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect(png.length).toBeGreaterThan(100)
  // The picker is gone and the page never saw the pick as a click.
  expect(await pickerOpen(app, id)).toBe(false)
  expect(await guestEval(app, id, `document.body.dataset.clicked ?? null`)).toBeNull()
})

test('a dragged region goes without an element; Escape cancels quietly', async ({ app, shell }) => {
  const id = await openPage(shell, server.url('/b.html'), 'Page B')
  await stubChat(app)
  const panel = webPanel(shell, id)
  const drag = () =>
    mouse(app, id, [
      { type: 'mouseMove', x: 40, y: 120 },
      { type: 'mouseDown', x: 40, y: 120 },
      { type: 'mouseMove', x: 80, y: 150 },
      { type: 'mouseMove', x: 140, y: 180 },
      { type: 'mouseUp', x: 140, y: 180 },
    ])

  // Escape while picking (the page has the keys then) closes the picker.
  await panel.getByTestId('btn-annotate').click()
  await expect.poll(() => pickerOpen(app, id)).toBe(true)
  await sendKey(app, id, 'Escape', [])
  await expect.poll(() => pickerOpen(app, id)).toBe(false)
  await expect(panel.getByTestId('btn-annotate')).not.toHaveAttribute('data-variant', 'light')

  // Escape in the note drops it and the mark on the page.
  await panel.getByTestId('btn-annotate').click()
  await expect.poll(() => pickerOpen(app, id)).toBe(true)
  await drag()
  await noteField(shell, id).pressSequentially('Never mind')
  await noteField(shell, id).press('Escape')
  await expect(panel.getByTestId('annotate-composer')).toHaveCount(0)
  await expect(panel.getByTestId('address-row')).toBeVisible()
  await expect.poll(() => pickerOpen(app, id)).toBe(false)
  expect(await notes(app)).toHaveLength(0)

  await panel.getByTestId('btn-annotate').click()
  await expect.poll(() => pickerOpen(app, id)).toBe(true)
  await drag()
  await writeAndSend(shell, id, 'What is this area?')
  await expect(shell.getByText('Sent to Fixture chat')).toBeVisible()
  const sent = await notes(app)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.note.element).toBeUndefined()
  expect(sent[0]!.note.region).toEqual({ x: 40, y: 120, w: 100, h: 60 })
  expect(fs.existsSync(sent[0]!.note.image!)).toBe(true)
})

test('the page never sees a key of the note', async ({ app, shell }) => {
  // keylog.html records every key event its window and document capture listeners get.
  const id = await openPage(shell, server.url('/keylog.html'), 'Key log')
  await stubChat(app)
  const panel = webPanel(shell, id)
  const keys = () => guestEval(app, id, `window.__keys`)
  expect(await keys()).toEqual([])

  await panel.getByTestId('btn-annotate').click()
  await expect.poll(() => pickerOpen(app, id)).toBe(true)
  const { cx, cy } = await buttonOf(app, id)
  await mouse(app, id, [
    { type: 'mouseMove', x: cx, y: cy },
    { type: 'mouseDown', x: cx, y: cy },
    { type: 'mouseUp', x: cx, y: cy },
  ])
  const field = noteField(shell, id)
  await expect(field).toBeFocused()
  await field.pressSequentially('my secret note')
  await field.press('Shift+Enter')
  await field.pressSequentially('line two')
  await field.press('Enter')

  await expect(shell.getByText('Sent to Fixture chat')).toBeVisible()
  const sent = await notes(app)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.note).toMatchObject({
    text: 'my secret note\nline two',
    element: { tag: 'button', selector: '#btn' },
  })
  expect(sent[0]!.note.region.w).toBeGreaterThan(0)
  expect(fs.existsSync(sent[0]!.note.image!)).toBe(true)
  expect(await keys()).toEqual([])
})

test('a mark goes when its page navigates, and no note goes out on the new page', async ({
  app,
  shell,
}) => {
  const id = await openPage(shell, server.url('/b.html'), 'Page B')
  await stubChat(app)
  const panel = webPanel(shell, id)
  const markButton = async (): Promise<void> => {
    await panel.getByTestId('btn-annotate').click()
    await expect.poll(() => pickerOpen(app, id)).toBe(true)
    const { cx, cy } = await buttonOf(app, id)
    await mouse(app, id, [
      { type: 'mouseMove', x: cx, y: cy },
      { type: 'mouseDown', x: cx, y: cy },
      { type: 'mouseUp', x: cx, y: cy },
    ])
    await expect(noteField(shell, id)).toBeFocused()
  }

  // An in-page navigation keeps the document: the composer closes and the mark leaves it.
  await markButton()
  await noteField(shell, id).pressSequentially('Stale note')
  await guestEval(app, id, `history.pushState({}, '', '#moved')`)
  await expect(panel.getByTestId('annotate-composer')).toHaveCount(0)
  await expect(panel.getByTestId('address-row')).toBeVisible()
  await expect.poll(() => pickerOpen(app, id)).toBe(false)

  // A full navigation: the composer closes on the new page.
  await markButton()
  await noteField(shell, id).pressSequentially('Stale note')
  // The page may tear down its context before the answer comes back.
  await guestEval(app, id, `location.href = '/a.html'`).catch(() => undefined)
  await expect(panel.getByTestId('annotate-composer')).toHaveCount(0)
  await expect(panel.getByTestId('address-row')).toBeVisible()
  await expect.poll(() => guestEval(app, id, `location.pathname`)).toBe('/a.html')
  expect(await notes(app)).toHaveLength(0)
})
