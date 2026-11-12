import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { guestEval, newPage, navigate, webPanel, type BrowserHooks } from './helpers/web'

// Every submitted comment lands in the one owning chat as an inline background row (a slim line
// like a system line: icon, "You commented on <element or card> · <page or board>", the note, a
// tiny thumbnail, Show), never as a user bubble. The chat here is the real Fixture chat run by the
// fake omp (no test hook stands in for it): the note reaches omp as a prompt and the row shows in
// the chat log. 1: a note on a page element (the note picker). 2: a comment on a board card.
// Screenshots go to proof/phase-comment-rows/ (EVAOS_PROOF=1).

const LOG = path.join(os.tmpdir(), `evaos-fake-omp-comment-rows-${process.pid}.log`)
const PHASE = 'phase-comment-rows'

type Ev = { event: string; detail: Record<string, unknown> | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []

/** The text of every prompt the fake omp got, oldest first. */
const prompts = (): string[] =>
  readLog()
    .filter((e) => e.event === 'prompt')
    .map((e) => String(e.detail?.['message'] ?? ''))

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
  fs.rmSync(LOG, { force: true })
})

test.use({
  launchEnv: { FAKE_OMP_DELAY_MS: '5', FAKE_OMP_LOG: LOG, EVAOS_AGENT_CONTROL: '1' },
})

type Shell = {
  __evaosShell: {
    setPanel(open: boolean): void
    tabs(): { active: number; list: Array<{ chat: string | null }> }
  }
}

/** Opens the Fixture chat in the chat tree and waits for its history; answers its session file. */
async function openFixtureChat(shell: Page): Promise<string> {
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: /^Fixture chat(?:,|$)/ })
    .click()
  await expect(shell.locator('[data-testid=chat-log]')).toContainText(
    'Please sketch a tiny greeter.',
  )
  const file = await shell.evaluate(() => {
    const t = (window as unknown as Shell).__evaosShell.tabs()
    return t.list[t.active]!.chat ?? ''
  })
  expect(file).toMatch(/\.jsonl$/)
  return file
}

/** The inline comment row whose note says `note`. */
const rowOf = (shell: Page, note: string): Locator =>
  shell.locator('[data-testid=background-event]').filter({ hasText: note })

/** Mouse input inside page `id` as the guest's own (trusted) events, in view px. */
const mouse = (
  app: ElectronApplication,
  id: string,
  steps: Array<{ type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number }>,
): Promise<void> =>
  app.evaluate(
    (_e, a) => {
      const wc = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host.tabById(
        a.id,
      )
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

test('a note on a page element lands in its chat as one inline row, not a bubble', async ({
  app,
  shell,
}) => {
  fs.rmSync(LOG, { force: true })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeGreaterThan(1700)
  await openFixtureChat(shell)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.setPanel(true))
  await expect(shell.locator('[data-pane-kind=tool]')).toBeVisible()

  // A page beside the chat, on the design fixture.
  const id = await newPage(shell)
  const panel = webPanel(shell, id)
  await navigate(shell, id, server.url('/design.html'))
  await expect.poll(() => guestEval(app, id, 'document.readyState')).toBe('complete')

  // The note picker, the same way browser-annotate does it: the page's own (trusted) input.
  await panel.getByTestId('btn-annotate').click()
  await expect
    .poll(() => guestEval(app, id, `!!document.getElementById('relay-note-picker')`))
    .toBe(true)
  const { x, y } = (await guestEval(
    app,
    id,
    `(() => { const r = document.getElementById('save').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`,
  )) as { x: number; y: number }
  await mouse(app, id, [
    { type: 'mouseMove', x: x - 3, y },
    { type: 'mouseMove', x, y },
  ])
  await mouse(app, id, [
    { type: 'mouseDown', x, y },
    { type: 'mouseUp', x, y },
  ])
  const field = panel.getByTestId('annotate-composer').getByTestId('annotate-note')
  await expect(field).toBeFocused()
  await expect(panel.getByTestId('annotate-mark')).toContainText('button')
  const note = 'Make the save button quieter'
  await field.pressSequentially(note)
  await field.press('Enter')

  // The fake omp got it as a page note prompt.
  await expect
    .poll(() => prompts().some((p) => p.includes('[Note on web page')), { timeout: 15_000 })
    .toBe(true)
  const prompt = prompts().find((p) => p.includes('[Note on web page'))!
  expect(prompt).toContain(`web page ${id}`)
  expect(prompt).toContain('selector "#save"')
  expect(prompt).toContain(note)

  // The chat shows exactly one slim row for it: no user bubble, the element, a thumbnail, Show.
  const row = rowOf(shell, note)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('You commented on')
  await expect(row.locator('[data-testid=background-chip]')).toHaveText('#save')
  await expect(row.locator('[data-testid=background-note]')).toHaveText(note)
  await expect(row.locator('.eva-bg-thumbs img')).toBeVisible()
  await expect(shell.locator('.eva-bubble').filter({ hasText: note })).toHaveCount(0)
  await expect(row.locator('[data-testid=background-body]')).toHaveCount(0)
  await row.getByRole('button', { name: 'Show' }).click()
  await expect(row.locator('[data-testid=background-body]')).toContainText('Note on web page')
  await proofShot(app, shell, 'page-note-row', { phase: PHASE })
  // Still one row and still no bubble once it is open.
  await expect(rowOf(shell, note)).toHaveCount(1)
  await expect(shell.locator('.eva-bubble').filter({ hasText: note })).toHaveCount(0)
})

test('a comment on a board card lands in the chat that owns the board as one inline row', async ({
  app,
  shell,
  configDir,
}) => {
  fs.rmSync(LOG, { force: true })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeGreaterThan(1700)
  const file = await openFixtureChat(shell)

  // The chat's agent opens a board beside the chat (canvas.open through the app's agent-control
  // server, scoped to the chat's workspace), so the board belongs to this chat.
  const control = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(control), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(control, 'utf8')) as {
    port: number
    token: string
  }
  const res = await fetch(`http://127.0.0.1:${port}/actions/canvas.open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params: { slug: 'mind-map' }, scope: `chat:${file}` }),
  })
  const opened = (await res.json()) as {
    ok: boolean
    value?: { title?: string }
    code?: string
    message?: string
  }
  expect(opened.ok, `canvas.open: ${opened.code} ${opened.message}`).toBe(true)
  const boardTitle = opened.value?.title ?? 'Q4 roadmap'
  const board = shell.locator('[data-testid=canvas-board][data-slug="mind-map"]')
  await expect(board).toBeVisible()
  await expect(shell.locator('[data-testid=chat-log]')).toBeVisible()

  // Isaac comments on a card: click it, '/', write, Enter (as canvas-comments and canvas-drive).
  const card = board.locator('.react-flow__node').first()
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute('data-id'))!
  const saved = JSON.parse(
    fs.readFileSync(path.join(configDir, 'canvases', 'mind-map.json'), 'utf8'),
  ) as { nodes: Array<{ id: string; data?: { title?: string } }> }
  const cardName = saved.nodes.find((n) => n.id === cardId)?.data?.title ?? cardId
  await card.click()
  await expect(card).toHaveClass(/selected/)
  await shell.keyboard.press('/')
  const draft = shell.locator('[data-testid=canvas-thread][data-thread=draft]')
  await expect(draft).toBeVisible()
  const note = 'Can this step ship earlier'
  await draft.locator('[data-testid=canvas-thread-new-input]').fill(note)
  await shell.keyboard.press('Enter')

  // The fake omp got it as a board comment prompt.
  await expect
    .poll(() => prompts().some((p) => p.includes('[Comment ')), { timeout: 15_000 })
    .toBe(true)
  const prompt = prompts().find((p) => p.includes('[Comment '))!
  expect(prompt).toContain('board "')
  expect(prompt).toContain(note)

  // One slim row in the chat: the card and the board, the note, no user bubble.
  const row = rowOf(shell, note)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('You commented on')
  await expect(row.locator('[data-testid=background-chip]')).toHaveText(cardName)
  await expect(row).toContainText(boardTitle)
  await expect(row.locator('[data-testid=background-note]')).toHaveText(note)
  await expect(shell.locator('.eva-bubble').filter({ hasText: note })).toHaveCount(0)
  await row.getByRole('button', { name: 'Show' }).click()
  await expect(row.locator('[data-testid=background-body]')).toContainText('Comment')
  await proofShot(app, shell, 'canvas-comment-row', { phase: PHASE })
  await expect(rowOf(shell, note)).toHaveCount(1)
})
