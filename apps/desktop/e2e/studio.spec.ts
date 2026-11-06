import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { z } from 'zod'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// Studio's landing against the fake Relay host: the projects rail, the grid of originals, the
// create bar (count, project, references), the GPU queue, filters, multi-select with the bulk
// bar, Undo toasts, Download, Add to canvas, Send to chat, and agents opening Studio. Nothing
// generates: the fake host finishes jobs with fixture files when the test says so.
let host: FakeRelayHost
let root: string
let portraits: string
let lighthouse: string
let favorite: string

const spec = (prompt: string, over: Record<string, unknown> = {}) => ({
  mode: 'image',
  backend: 'moss',
  model: 'moss-image',
  prompt,
  aspect: '1:1',
  resolution: '1024x1024',
  ...over,
})

const JobSchema = z.object({
  id: z.string(),
  outputs: z.array(z.object({ id: z.string() })).min(1),
})
const outputOf = (job: unknown): string => JobSchema.parse(job).outputs[0]!.id

const test = base.extend({
  startOnChat: false,
  toolPanes: false,
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-studio-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    portraits = String(host.addStudioProject('Portraits').id)
    const first = outputOf(
      host.addStudioJob(spec('Portrait study, red hair'), 'desktop', { project: portraits }),
    )
    host.addStudioJob(
      spec('Portrait study, neon', { backend: 'kontext', model: undefined }),
      'desktop',
      {
        project: portraits,
        parent: { asset: first, how: 'edit' },
      },
    )
    lighthouse = outputOf(
      host.addStudioJob(spec('A lighthouse at dusk', { backend: 'codex-image', model: undefined })),
    )
    favorite = outputOf(host.addStudioJob(spec('A red ceramic cup'), 'desktop', { favorite: true }))
    await use({ EVAOS_RELAY_DIR: relayDir, EVAOS_AGENT_CONTROL: '1' })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`
const PROOF = path.join(REPO_ROOT, 'proof', 'studio-redesign')

type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Shell = { __evaosShell: { openPlace(p: string): void } }

/** A composite proof shot; an EVAOS_PROOF=1 run keeps it in proof/studio-redesign/. */
async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  const file = await proofShot(app, shell, name, { phase: 'studio-redesign' })
  if (process.env.EVAOS_PROOF !== '1') return
  fs.mkdirSync(PROOF, { recursive: true })
  fs.renameSync(file, path.join(PROOF, `${name}.png`))
}

const creates = (): Array<Record<string, unknown>> =>
  host.studioOps.filter((op) => op.kind === 'create')
const ops = (kind: string): Array<Record<string, unknown>> =>
  host.studioOps.filter((op) => op.kind === kind)

/** Studio as the whole page at 1440x900. */
async function openStudio(app: ElectronApplication, shell: Page): Promise<Locator> {
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(w!, h!),
    [1440, 900],
  )
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('studio'))
  const studio = shell.locator(sel('page-studio'))
  await expect(studio).toBeVisible()
  await expect(studio.locator(sel('studio-tile')).first()).toBeVisible()
  return studio
}

const tile = (studio: Locator, id: string): Locator =>
  studio.locator(`${sel('studio-tile')}[data-id="${id}"]`)
const railItem = (studio: Locator, name: string): Locator =>
  studio.locator('.sl-rail-item', { hasText: name })

test('landing: originals, projects with Undo, generate 4, the GPU queue, filters', async ({
  app,
  shell,
}) => {
  const studio = await openStudio(app, shell)
  // Originals only, newest first; the portrait with a version carries its badge.
  await expect(studio.locator(sel('studio-tile'))).toHaveCount(3)
  await expect(studio.locator(sel('studio-count'))).toHaveText('3 images')
  const badge = studio.locator(`${sel('studio-tile')}:has(${sel('studio-tile-count')})`)
  await expect(badge).toHaveCount(1)
  await expect(badge.locator(sel('studio-tile-count'))).toHaveText('1')
  await expect(railItem(studio, 'Portraits').locator('.sl-n')).toHaveText('1')
  await expect(railItem(studio, 'Favorites').locator('.sl-n')).toHaveText('1')
  await shot(app, shell, 'landing')

  // A project: create, rename, delete, then Undo brings it back with its images.
  await studio.getByRole('button', { name: 'New project' }).click()
  const modal = shell.locator(sel('studio-modal'))
  await modal.getByRole('textbox').fill('Moodboard')
  await modal.locator(sel('studio-modal-ok')).click()
  await expect(studio.locator(sel('studio-view-title'))).toHaveText('Moodboard')
  await expect(studio.locator(sel('studio-empty'))).toBeVisible()
  await shot(app, shell, 'empty-state')
  await railItem(studio, 'Moodboard').hover()
  await railItem(studio, 'Moodboard').getByRole('button', { name: 'Moodboard menu' }).click()
  await shell.getByRole('menuitem', { name: 'Rename' }).click()
  await modal.getByRole('textbox').fill('Mood board')
  await modal.locator(sel('studio-modal-ok')).click()
  await expect(railItem(studio, 'Mood board')).toBeVisible()
  expect(ops('project.rename')).toHaveLength(1)
  await railItem(studio, 'Portraits').hover()
  await railItem(studio, 'Portraits').getByRole('button', { name: 'Portraits menu' }).click()
  await shell.getByRole('menuitem', { name: 'Delete project' }).click()
  await expect(modal).toContainText('move to Unsorted')
  await modal.locator(sel('studio-modal-ok')).click()
  await expect(railItem(studio, 'Portraits')).toHaveCount(0)
  await studio.locator(sel('studio-toast')).getByRole('button', { name: 'Undo' }).click()
  await expect(railItem(studio, 'Portraits')).toBeVisible()
  await expect(railItem(studio, 'Portraits').locator('.sl-n')).toHaveText('1')
  expect(ops('project.create').at(-1)).toMatchObject({ id: portraits, name: 'Portraits' })

  // Generate 4 into Portraits: four pending tiles, the queue, a cancel, then three land.
  await railItem(studio, 'Portraits').click()
  await studio.locator(sel('studio-prompt')).click()
  await shot(app, shell, 'create-bar-focus')
  await studio.locator(sel('studio-prompt')).fill('Portrait study, window light')
  await studio.locator('.sl-count').getByRole('button', { name: '4' }).click()
  await studio.locator(sel('studio-generate')).click()
  await expect.poll(() => creates().length).toBe(1)
  expect(creates()[0]).toMatchObject({
    origin: 'desktop',
    count: 4,
    project: portraits,
    spec: { backend: 'moss', model: 'moss-image', prompt: 'Portrait study, window light' },
  })
  await expect(studio.locator(sel('studio-pending'))).toHaveCount(4)
  const queue = studio.locator(sel('studio-queue-button'))
  await expect(queue).toHaveText('1 running · 3 waiting')
  await queue.click()
  const rows = shell.locator(sel('studio-queue-row'))
  await expect(rows).toHaveCount(4)
  await rows.last().getByRole('button', { name: 'Cancel job' }).click()
  await expect.poll(() => ops('cancel').length).toBe(1)
  await expect(studio.locator(sel('studio-pending'))).toHaveCount(3)
  await shell.keyboard.press('Escape')
  for (let i = 0; i < 3; i++) host.finishStudio()
  await expect(studio.locator(sel('studio-pending'))).toHaveCount(0)
  await expect(studio.locator(sel('studio-tile'))).toHaveCount(4)
  await expect(queue).toHaveText('GPU idle')

  // Filters: search, favorites, model, then Clear filters.
  await railItem(studio, 'All images').click()
  await expect(studio.locator(sel('studio-tile'))).toHaveCount(6)
  await studio.locator(sel('studio-search')).fill('lighthouse')
  await expect(studio.locator(sel('studio-tile'))).toHaveCount(1)
  await expect(tile(studio, lighthouse)).toBeVisible()
  await studio.locator(sel('studio-search')).fill('')
  await studio.locator(sel('studio-filter-fav')).click()
  await expect(studio.locator(sel('studio-tile'))).toHaveCount(1)
  await expect(tile(studio, favorite)).toBeVisible()
  await studio.locator(sel('studio-filter-fav')).click()
  await studio.locator(sel('studio-filter-model')).click()
  await shell.getByRole('menuitem', { name: 'Codex image' }).click()
  await shell.keyboard.press('Escape')
  await expect(studio.locator(sel('studio-tile'))).toHaveCount(1)
  await studio.getByRole('button', { name: 'Clear filters' }).click()
  await expect(studio.locator(sel('studio-tile'))).toHaveCount(6)
})

test('multi-select, the bulk bar, Undo, Download, Add to canvas and Send to chat', async ({
  app,
  shell,
  configDir,
}) => {
  const studio = await openStudio(app, shell)
  const tiles = studio.locator(sel('studio-tile'))
  const selected = studio.locator(`${sel('studio-tile')}[data-selected="true"]`)
  const count = studio.locator(sel('studio-bulk-count'))

  // Cmd toggles, Shift extends a range, Cmd+A takes all, Esc clears.
  await tiles.nth(0).click({ modifiers: ['Meta'] })
  await expect(count).toHaveText('1 selected')
  await tiles.nth(2).click({ modifiers: ['Shift'] })
  await expect(count).toHaveText('3 selected')
  await tiles.nth(1).click({ modifiers: ['Meta'] })
  await expect(count).toHaveText('2 selected')
  await shot(app, shell, 'selection')
  await shell.keyboard.press('Escape')
  await expect(selected).toHaveCount(0)
  await expect(studio.locator(sel('studio-composer'))).toBeVisible()
  await shell.keyboard.press('Meta+a')
  await expect(selected).toHaveCount(3)
  await shell.keyboard.press('Escape')

  // Select mode: a plain click toggles.
  await studio.locator(sel('studio-select')).click()
  await tiles.nth(1).click()
  await expect(count).toHaveText('1 selected')
  await studio.getByRole('button', { name: 'Clear selection' }).click()
  await expect(selected).toHaveCount(0)

  // Marquee from the empty space below the grid up over the tiles.
  const feed = await studio.locator(sel('studio-feed')).boundingBox()
  const last = await tiles.nth(2).boundingBox()
  if (!feed || !last) throw new Error('No grid')
  await shell.mouse.move(feed.x + 8, last.y + last.height + 40)
  await shell.mouse.down()
  await shell.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 8 })
  await expect(studio.locator(sel('studio-marquee'))).toBeVisible()
  await shell.mouse.up()
  await expect(selected).toHaveCount(3)
  await shot(app, shell, 'bulk')

  // Bulk favorite, move with Undo, delete with Undo.
  await studio.locator(sel('studio-bulk')).getByRole('button', { name: 'Favorite' }).click()
  await expect.poll(() => ops('favorite').at(-1)).toMatchObject({ value: true })
  await expect(railItem(studio, 'Favorites').locator('.sl-n')).toHaveText('3')
  await studio.locator(sel('studio-bulk')).getByRole('button', { name: 'Move to' }).click()
  await shell.getByRole('menuitem', { name: 'Portraits' }).click()
  await expect(studio.locator(sel('studio-toast')).first()).toContainText(
    'Moved 3 images to Portraits',
  )
  await expect(railItem(studio, 'Portraits').locator('.sl-n')).toHaveText('3')
  await studio.locator(sel('studio-toast')).getByRole('button', { name: 'Undo' }).click()
  await expect(railItem(studio, 'Portraits').locator('.sl-n')).toHaveText('1')
  await railItem(studio, 'All images').click()
  await tiles.nth(0).click({ modifiers: ['Meta'] })
  await tiles.nth(1).click({ modifiers: ['Meta'] })
  await studio.locator(sel('studio-bulk')).getByRole('button', { name: 'Delete' }).click()
  await expect(tiles).toHaveCount(1)
  expect(ops('trash')).toHaveLength(1)
  await studio.locator(sel('studio-toast')).getByRole('button', { name: 'Undo' }).click()
  await expect(tiles).toHaveCount(3)
  expect(ops('restore')).toHaveLength(1)

  // Delete and F from the keyboard.
  await tiles.nth(0).click({ modifiers: ['Meta'] })
  await shell.keyboard.press('f')
  await expect.poll(() => ops('favorite').length).toBe(2)
  await shell.keyboard.press('Backspace')
  await expect(tiles).toHaveCount(2)
  await studio.locator(sel('studio-toast')).getByRole('button', { name: 'Undo' }).last().click()
  await expect(tiles).toHaveCount(3)

  // Download: every file, into the (test) Downloads folder.
  await shell.keyboard.press('Meta+a')
  await studio.locator(sel('studio-bulk')).getByRole('button', { name: 'Download' }).click()
  const downloads = path.join(configDir, 'Downloads')
  await expect.poll(() => (fs.existsSync(downloads) ? fs.readdirSync(downloads).length : 0)).toBe(3)

  // Add to canvas: a new board gets the images as image cards, copied into the boards folder.
  await studio.locator(sel('studio-bulk')).getByRole('button', { name: 'Add to canvas' }).click()
  await shell.getByRole('menuitem', { name: 'New board' }).click()
  await expect(studio.locator(sel('studio-toast')).last()).toContainText('Added 3 images to')
  const canvases = path.join(configDir, 'canvases')
  expect(fs.readdirSync(path.join(canvases, 'studio'))).toHaveLength(3)
  const boards = fs
    .readdirSync(canvases)
    .filter((f) => f.startsWith('untitled') && f.endsWith('.json'))
  const text = boards.map((f) => fs.readFileSync(path.join(canvases, f), 'utf8')).join('\n')
  expect(text.match(/"src": ?"studio\//g)).toHaveLength(3)

  // Send to chat: a recent chat opens with the images attached to its message box.
  await studio.locator(sel('studio-bulk')).getByRole('button', { name: 'Send to chat' }).click()
  const chat = shell.locator(sel('studio-send-menu')).getByRole('menuitem').first()
  await expect(chat).toBeVisible()
  await chat.click()
  await expect(shell.locator(sel('composer-chip'))).toHaveCount(3)
})

const ControlFileSchema = z.object({ url: z.string(), token: z.string() })
const ReplySchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  code: z.string().optional(),
})
const MadeSchema = z.object({ job: z.object({ id: z.string() }) })

/** Runs one agent action the way relay-ctl does: POST /actions/<id> with the control file's token. */
async function agent(configDir: string, id: string, params: Record<string, unknown> = {}) {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { url, token } = ControlFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  const res = await fetch(`${url}/actions/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  })
  return ReplySchema.parse(await res.json())
}

test('references with @ chips, and agents opening jobs and drafts', async ({
  app,
  shell,
  configDir,
}) => {
  const studio = await openStudio(app, shell)

  // Save the selected image as a Character; it shows in the rail.
  await tile(studio, lighthouse).click({ modifiers: ['Meta'] })
  await studio.getByRole('button', { name: 'Save a reference' }).click()
  await shell.getByRole('menuitem', { name: 'Save current version as character' }).click()
  const modal = shell.locator(sel('studio-modal'))
  await modal.getByRole('textbox').fill('Keeper')
  await modal.locator(sel('studio-modal-ok')).click()
  await expect(studio.locator(sel('studio-refs-character'))).toContainText('Keeper')
  expect(ops('reference.create')).toEqual([
    { kind: 'reference.create', asset: lighthouse, referenceKind: 'character', name: 'Keeper' },
  ])
  await shell.keyboard.press('Escape')

  // '@' in the prompt opens the picker; the reference becomes a chip and routes to klein character.
  const prompt = studio.locator(sel('studio-prompt'))
  await prompt.fill('The keeper on a cliff @')
  const picker = studio.locator(sel('studio-at-picker'))
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: /Keeper/ }).click()
  await expect(studio.locator(sel('studio-ref-chip'))).toHaveText(/Keeper/)
  await expect(prompt).toHaveValue('The keeper on a cliff ')
  await expect(studio.locator(sel('studio-klein-hint'))).toBeVisible()
  await studio.locator(sel('studio-generate')).click()
  await expect.poll(() => creates().length).toBe(1)
  const made = creates()[0]!
  expect(made).toMatchObject({
    spec: { backend: 'comfyui', model: 'character', prompt: 'The keeper on a cliff' },
  })
  expect(made).not.toHaveProperty('parent')
  await expect(studio.locator(sel('studio-ref-chip'))).toHaveCount(0)

  // An agent's job opens in the editor once it has an image.
  const generated = await agent(configDir, 'studio.generate', { prompt: 'A red kite', open: true })
  expect(generated.ok).toBe(true)
  const { job } = MadeSchema.parse(generated.value)
  expect(creates().at(-1)).toMatchObject({ origin: 'agent', spec: { prompt: 'A red kite' } })
  const asset = outputOf(host.finishStudio(job.id))
  // The agent opened Studio in a tab of its own beside this one.
  await expect(shell.locator(sel('page-studio'))).toHaveCount(2)
  const beside = shell.locator(sel('page-studio')).last()
  const editor = beside.locator(sel('studio-editor'))
  await expect(editor).toBeVisible()
  await expect(editor.locator(sel('studio-ed-media'))).toHaveAttribute('data-id', asset)
  await shell.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)

  // studio.open with a draft fills the create bar and sends nothing.
  const sent = creates().length
  const opened = await agent(configDir, 'studio.open', {
    draft: { prompt: 'Drafted by Eva', backend: 'codex-image', aspect: '16:9' },
  })
  expect(opened.ok).toBe(true)
  await expect(beside.locator(sel('studio-prompt'))).toHaveValue('Drafted by Eva')
  await expect(beside.locator(sel('studio-model'))).toContainText('Codex image')
  expect(creates()).toHaveLength(sent)
})
