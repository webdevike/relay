import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'
import { REPO_ROOT } from './helpers/paths'

type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

test.use({ startOnChat: false, colorScheme: 'dark' })

const sel = (id: string): string => `[data-testid=${id}]`
const PROOF = path.join(REPO_ROOT, 'proof', 'canvas')

/** The fixture boards (fixtures/canvases), as main seeds them into the test's config dir. */
const BOARDS = [
  { slug: 'mind-map', title: 'Q4 roadmap', nodes: 7, edges: 5 },
  { slug: 'moodboard', title: 'Calm ops moodboard', nodes: 12, edges: 0 },
  { slug: 'user-flow', title: 'Sign-in flow', nodes: 5, edges: 4 },
] as const

const boardFile = (configDir: string, slug: string): string =>
  path.join(configDir, 'canvases', `${slug}.json`)

function readBoard(
  configDir: string,
  slug: string,
): {
  title: string
  nodes: Array<{ id: string; type: string; x?: number; data?: { title?: string } }>
  edges: Array<{ source: string; target: string }>
} {
  return JSON.parse(fs.readFileSync(boardFile(configDir, slug), 'utf8'))
}

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

async function scheme(shell: Page, mode: 'dark' | 'light'): Promise<void> {
  const button = shell.locator(sel(`appearance-${mode}`))
  if (!(await button.isVisible())) await shell.locator(sel('sidebar-back')).click()
  await button.click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', mode)
}

async function openCanvas(shell: Page): Promise<void> {
  await shell.locator(sel('nav-canvas')).click()
  await expect(shell.locator(sel('sidebar-sub-canvas'))).toBeVisible()
  await expect(shell.locator(sel('canvas-list'))).toBeVisible()
}

async function openBoard(shell: Page, slug: string, title: string): Promise<void> {
  await shell.locator(sel(`canvas-row-${slug}`)).click()
  await expect(shell.locator(sel('canvas-board'))).toHaveAttribute('data-slug', slug)
  await expect(shell.locator(sel('canvas-title'))).toHaveText(title)
}

const status = (shell: Page) => shell.locator(sel('canvas-status'))

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

test('Canvas lists the boards and opens each with its cards, light and dark', async ({
  app,
  shell,
}) => {
  await size(app, shell, 1600, 1000)
  await openCanvas(shell)
  await expect(shell.locator(sel('sidebar-sub-title'))).toHaveText('Canvas')
  for (const b of BOARDS) {
    await expect(shell.locator(sel(`canvas-row-${b.slug}`))).toContainText(b.title)
    await expect(shell.locator(sel(`canvas-row-${b.slug}`))).toHaveAttribute(
      'title',
      new RegExp(`\\n${b.nodes} nodes?$`),
    )
  }
  await expect(shell.locator(sel('canvas-section-label'))).toHaveText(['Recent'])
  // The nav opened the newest board.
  await expect(shell.locator(sel('canvas-board'))).toBeVisible()

  fs.mkdirSync(PROOF, { recursive: true })
  // The board gets the whole main card for the proof shots.
  const panelToggle = shell.locator(`${sel('panel-toggle')}:visible`).first()
  if ((await panelToggle.getAttribute('aria-pressed')) === 'true') await panelToggle.click()
  for (const mode of ['dark', 'light'] as const) {
    await scheme(shell, mode)
    await openCanvas(shell)
    for (const b of BOARDS) {
      await openBoard(shell, b.slug, b.title)
      // Every fixture board has several nodes and either none or several edges.
      const counts = `${b.nodes} nodes · ${b.edges} edges`
      await expect(status(shell)).toHaveText(`${counts} · saved`, { timeout: 10_000 })
      const board = shell.locator(sel('canvas-board'))
      await expect(board.locator('.react-flow__node')).toHaveCount(b.nodes)
      await expect(board.locator('.react-flow__edge')).toHaveCount(b.edges)
      await expect(board.locator('.react-flow__node').first()).toBeVisible()
      await expect(shell.locator(sel('canvas-tidy'))).toContainText('Tidy · ')
      await expect(shell.locator(sel('canvas-tools'))).toBeVisible()
      await expect(shell.locator(sel('canvas-controls'))).toBeVisible()
      await expect(board.locator('.react-flow__minimap')).toBeVisible()
      if (b.slug === 'moodboard') {
        await expect(board.locator('img.eva-cv-picture')).toHaveCount(3)
        await expect(shell.locator(sel('canvas-wireframe'))).toBeVisible()
        await expect(shell.locator(sel('canvas-card-palette'))).toContainText('#24837B')
      }
      if (b.slug === 'mind-map') {
        await expect(shell.locator(sel('canvas-suggestion-add'))).toBeVisible()
        await expect(shell.locator(sel('canvas-card-proof'))).toContainText('ENG-6180')
      }
      // Let a first layout settle around the drawn sizes, fit, and wait for that to save.
      await shell.waitForTimeout(800)
      await shell.locator(sel('canvas-fit')).click()
      await shell.mouse.move(5, 500)
      await shell.waitForTimeout(1200)
      await expect(status(shell)).toHaveText(`${counts} · saved`, { timeout: 10_000 })
      await shell.screenshot({ path: path.join(PROOF, `${b.slug}-${mode}.png`) })
    }
  }
})

test('adding a note autosaves it; undo, the card toolbar and delete save too', async ({
  configDir,
  shell,
}) => {
  await openCanvas(shell)
  await openBoard(shell, 'user-flow', 'Sign-in flow')
  await expect(status(shell)).toHaveText('5 nodes · 4 edges · saved', { timeout: 10_000 })

  await shell.locator(sel('canvas-tool-note')).click()
  await expect(status(shell)).toContainText('6 nodes · 4 edges')
  await expect(shell.locator(sel('canvas-card-note-6'))).toContainText('New note')
  await expect(status(shell)).toHaveText('6 nodes · 4 edges · saved', { timeout: 10_000 })
  await expect
    .poll(() => readBoard(configDir, 'user-flow').nodes.find((n) => n.id === 'note-6'))
    .toMatchObject({ type: 'note', data: { title: 'New note' } })

  // Undo takes the note back out of the file.
  await shell.locator(sel('canvas-undo')).click()
  await expect(status(shell)).toContainText('5 nodes')
  await expect.poll(() => readBoard(configDir, 'user-flow').nodes.length).toBe(5)
  await shell.locator(sel('canvas-redo')).click()
  await expect.poll(() => readBoard(configDir, 'user-flow').nodes.length).toBe(6)

  // The selected card's toolbar adds a linked note under it.
  await shell.locator(sel('canvas-card-start')).click()
  await expect(shell.locator(sel('canvas-node-toolbar'))).toBeVisible()
  await shell.locator(sel('canvas-node-note')).click()
  await expect(status(shell)).toContainText('7 nodes · 5 edges')
  await expect
    .poll(() =>
      readBoard(configDir, 'user-flow').edges.some(
        (e) => e.source === 'start' && e.target === 'note-7',
      ),
    )
    .toBe(true)

  // Backspace removes the selected note and its edge.
  await shell.keyboard.press('Backspace')
  await expect(status(shell)).toContainText('6 nodes · 4 edges')
  await expect.poll(() => readBoard(configDir, 'user-flow').nodes.length).toBe(6)

  // Escape clears the selection; Cmd+A selects every card.
  await shell.locator(sel('canvas-card-start')).click()
  await shell.keyboard.press('Escape')
  await expect(shell.locator('.react-flow__node.selected')).toHaveCount(0)
  await shell.keyboard.press('Meta+a')
  await expect(shell.locator('.react-flow__node.selected')).toHaveCount(6)
})

test('a suggestion becomes a branch and Tidy lays the board out', async ({ configDir, shell }) => {
  await openCanvas(shell)
  await openBoard(shell, 'mind-map', 'Q4 roadmap')
  await expect(status(shell)).toHaveText('7 nodes · 5 edges · saved', { timeout: 10_000 })
  await expect(shell.locator(sel('canvas-tidy'))).toHaveText('Tidy · tree')
  await shell.locator(sel('canvas-suggestion-add')).click()
  await expect(shell.locator(sel('canvas-card-qa'))).toHaveCount(0)
  await expect(shell.locator('.react-flow__node', { hasText: 'QA checklist' })).toHaveCount(1)
  await expect
    .poll(() => readBoard(configDir, 'mind-map').nodes.some((n) => n.id === 'qa'))
    .toBe(false)
  await shell.locator(sel('canvas-tidy')).click()
  await expect(status(shell)).toHaveText(/7 nodes · \d+ edges · saved/, { timeout: 10_000 })
})

test('an outside edit reloads the open board', async ({ configDir, shell }) => {
  await openCanvas(shell)
  await openBoard(shell, 'user-flow', 'Sign-in flow')
  await expect(status(shell)).toHaveText('5 nodes · 4 edges · saved', { timeout: 10_000 })
  const file = boardFile(configDir, 'user-flow')
  const board = JSON.parse(fs.readFileSync(file, 'utf8'))
  board.nodes.push({ id: 'eva-note', type: 'note', data: { title: 'From Eva' } })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(board, null, 2))
  fs.renameSync(`${file}.tmp`, file)
  await expect(shell.locator(sel('canvas-card-eva-note'))).toContainText('From Eva', {
    timeout: 10_000,
  })
  await expect(status(shell)).toContainText('6 nodes')
})

test('boards are created, pinned, renamed and deleted from the sidebar', async ({
  configDir,
  shell,
}) => {
  await openCanvas(shell)
  await shell.locator(sel('canvas-new')).click()
  await expect(shell.locator(sel('canvas-title'))).toHaveText('Untitled board')
  await expect(shell.locator(sel('canvas-row-untitled-1'))).toBeVisible()
  expect(fs.existsSync(boardFile(configDir, 'untitled-1'))).toBe(true)

  await shell.locator(sel('canvas-row-moodboard')).click({ button: 'right' })
  await shell.locator(sel('canvas-menu-pin')).click()
  await expect(shell.locator(sel('canvas-section-label'))).toHaveText(['Pinned', 'Recent'])

  await shell.locator(sel('canvas-row-mind-map')).click({ button: 'right' })
  await shell.locator(sel('canvas-menu-rename')).click()
  const input = shell.locator(sel('canvas-rename-input'))
  await expect(input).toHaveValue('Q4 roadmap')
  await input.fill('Roadmap for Q4')
  await shell.locator(sel('canvas-rename-ok')).click()
  await expect(shell.locator(sel('canvas-row-mind-map'))).toContainText('Roadmap for Q4')
  await expect.poll(() => readBoard(configDir, 'mind-map').title).toBe('Roadmap for Q4')

  await shell.locator(sel('canvas-row-untitled-1')).click({ button: 'right' })
  await shell.locator(sel('canvas-menu-delete')).click()
  await expect(shell.getByRole('dialog', { name: 'Delete board?' })).toBeVisible()
  await shell.locator(sel('canvas-delete-ok')).click()
  await expect(shell.locator(sel('canvas-row-untitled-1'))).toHaveCount(0)
  expect(fs.existsSync(boardFile(configDir, 'untitled-1'))).toBe(false)
  await expect(shell.locator(sel('canvas-missing'))).toBeVisible()
})

test('a viewport saved off screen fits on open without rewriting the file', async ({
  configDir,
  shell,
}) => {
  const file = boardFile(configDir, 'user-flow')
  const board = JSON.parse(fs.readFileSync(file, 'utf8'))
  // As if saved in a much wider window: the cards sit far left of the pane.
  board.viewport = { x: 4000, y: 60, zoom: 0.75 }
  fs.writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`)
  const before = fs.readFileSync(file, 'utf8')
  await openCanvas(shell)
  await openBoard(shell, 'user-flow', 'Sign-in flow')
  const pane = (await shell.locator(sel('canvas-board')).locator('.react-flow').boundingBox())!
  await expect
    .poll(async () => {
      const card = await shell.locator(sel('canvas-card-start')).boundingBox()
      return card !== null && card.x >= pane.x && card.x + card.width <= pane.x + pane.width
    })
    .toBe(true)
  await shell.waitForTimeout(2500)
  await expect(status(shell)).toHaveText('5 nodes · 4 edges · saved')
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
})

test('the minimap is a small card and hides on a narrow board', async ({ app, shell }) => {
  await size(app, shell, 1600, 1000)
  await openCanvas(shell)
  await openBoard(shell, 'moodboard', 'Calm ops moodboard')
  const panelToggle = shell.locator(`${sel('panel-toggle')}:visible`).first()
  if ((await panelToggle.getAttribute('aria-pressed')) === 'true') await panelToggle.click()
  const minimap = shell.locator(sel('canvas-board')).locator('.react-flow__minimap')
  await expect(minimap).toBeVisible()
  const box = (await minimap.boundingBox())!
  expect(box.width).toBeLessThanOrEqual(162)
  expect(box.height).toBeLessThanOrEqual(112)
  // The tool panes shown in a smaller window leave the board under 640px wide.
  await size(app, shell, 1100, 800)
  await panelToggle.click()
  await expect
    .poll(async () => (await shell.locator(sel('canvas-board')).boundingBox())?.width ?? 0)
    .toBeLessThan(640)
  await expect(minimap).toBeHidden()
  await expect(shell.locator(sel('canvas-controls'))).toBeVisible()
})
