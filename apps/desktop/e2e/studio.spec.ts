import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { z } from 'zod'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { FIXTURES_DIR, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'
import { toolPane } from './helpers/web'

// Studio: image and video jobs on the Relay host. A fake host on a real WebSocket runs Studio
// (four backends, paid Higgsfield with models and a balance, jobs that finish when the test says
// so, assets served from fixture files); the app opens Studio as a tool tab, composes, generates,
// shows the queue and gallery, opens the viewer, remixes, and never sends a paid job without the
// confirm dialog. Agents drive it through the agent control API, as relay-ctl does.
let host: FakeRelayHost
let root: string

const IMAGE_SPEC = {
  mode: 'image',
  backend: 'codex-image',
  prompt: 'A paper boat on a still pond',
  aspect: '16:9',
  resolution: '1536x1024',
}
const VIDEO_SPEC = {
  mode: 'video',
  backend: 'ltx',
  prompt: 'Waves rolling onto a pebble beach',
  aspect: '16:9',
  resolution: '768x432',
  seconds: 5,
}

const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-studio-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.addStudioJob(VIDEO_SPEC)
    host.addStudioJob(IMAGE_SPEC)
    await use({ EVAOS_RELAY_DIR: relayDir, EVAOS_AGENT_CONTROL: '1' })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`
const PROOF = path.join(REPO_ROOT, 'proof', 'studio')

/** A composite proof shot; an EVAOS_PROOF=1 run keeps it in proof/studio/. */
async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  const file = await proofShot(app, shell, name, { phase: 'studio' })
  if (process.env.EVAOS_PROOF !== '1') return
  fs.mkdirSync(PROOF, { recursive: true })
  fs.renameSync(file, path.join(PROOF, `${name}.png`))
  const dir = path.dirname(file)
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
}

const creates = (): Array<Record<string, unknown>> =>
  host.studioOps.filter((op) => op.kind === 'create')

/** Studio's page tool tab (`view:page:studio`) in the tool pane's strip. */
const STUDIO_TAB = sel('pane-tab-view:page:studio')

/** Opens Studio from the tool pane's + menu, as a page tab beside the chat. */
async function openStudioTab(shell: Page): Promise<void> {
  const p = await toolPane(shell)
  await shell.locator(sel(`pane-add-${p}`)).click()
  await shell.locator(sel(`pane-add-tool-studio-${p}`)).click()
  await expect(shell.locator(STUDIO_TAB)).toHaveAttribute('data-active', 'true')
  await expect(shell.locator(sel('page-studio'))).toBeVisible()
}

const ControlFileSchema = z.object({ url: z.string(), token: z.string() })
const ReplySchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
})
const ListSchema = z.object({
  backends: z.array(z.object({ id: z.string() })),
  jobs: z.array(
    z.object({ id: z.string(), outputs: z.array(z.object({ url: z.string(), size: z.number() })) }),
  ),
})
const MadeSchema = z.object({
  job: z.object({ id: z.string(), backend: z.string(), state: z.string() }),
})

/** Runs one agent action the way relay-ctl does: POST /actions/<id> with the control file's token. */
async function agent(
  configDir: string,
  id: string,
  params: Record<string, unknown> = {},
): Promise<z.infer<typeof ReplySchema>> {
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

test('compose, generate, gallery, viewer, remix and the paid confirm', async ({ app, shell }) => {
  await openStudioTab(shell)
  const studio = shell.locator(sel('page-studio'))
  await expect(studio.locator(sel('studio-gallery-item'))).toHaveCount(2)
  expect(host.studioLists).toBeGreaterThan(0)

  // A free image job: a running row with progress, then a gallery tile.
  const prompt = studio.locator(sel('studio-prompt'))
  await prompt.fill('A lighthouse at dusk, film grain')
  await expect(studio.locator(sel('studio-backend'))).toHaveValue('Image (Codex, free)')
  await studio.locator(sel('studio-generate')).click()
  const row = studio.locator(sel('studio-queue-row'))
  await expect(row).toHaveAttribute('data-state', 'running')
  await expect(row).toContainText('A lighthouse at dusk, film grain')
  await expect(row).toContainText('about 20 s left')
  await expect(row.getByRole('progressbar')).toBeVisible()
  expect(creates().at(-1)).toMatchObject({
    origin: 'desktop',
    spec: { backend: 'codex-image', mode: 'image', prompt: 'A lighthouse at dusk, film grain' },
  })
  await shot(app, shell, 'narrow-pane')

  host.finishStudio()
  await expect(studio.locator(sel('studio-gallery-item'))).toHaveCount(3)
  await expect(row).toHaveCount(0)

  // Wide: the tool pane maximized puts the composer column beside the gallery.
  const pane = await toolPane(shell)
  await shell.locator(sel(`pane-add-${pane}`)).click()
  await shell.locator(sel(`pane-add-zoom-${pane}`)).click()
  const side = studio.locator('.eva-studio-side')
  const main = studio.locator('.eva-studio-main')
  await expect
    .poll(async () => {
      const a = await side.boundingBox()
      const b = await main.boundingBox()
      return a !== null && b !== null && b.x >= a.x + a.width - 1
    })
    .toBe(true)
  await shot(app, shell, 'wide-pane')

  // The viewer, then Remix fills the composer from the job.
  await prompt.fill('')
  await studio.locator(sel('studio-gallery-item')).first().click()
  const viewer = shell.locator(sel('studio-viewer'))
  await expect(viewer.locator(sel('studio-viewer-image'))).toBeVisible()
  await expect
    .poll(() =>
      viewer
        .locator(sel('studio-viewer-image'))
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true)
  await shot(app, shell, 'viewer')
  await viewer.locator(sel('studio-remix')).click()
  await expect(viewer.locator(sel('studio-viewer-image'))).toHaveCount(0)
  await expect(prompt).toHaveValue('A lighthouse at dusk, film grain')

  // Use as frame: the image becomes local video's start frame; an end frame comes from a file.
  await studio.locator(sel('studio-gallery-item')).first().click()
  await viewer.locator(sel('studio-use')).click()
  await shell.locator(sel('studio-use-start')).click()
  await expect(studio.locator(sel('studio-backend'))).toHaveValue('Local video (LTX, free)')
  await expect(studio.locator(`${sel('studio-slot-start')} img`)).toBeVisible()
  await studio
    .locator(sel('studio-slot-end-file'))
    .setInputFiles(path.join(FIXTURES_DIR, 'agent-widgets/media/gallery-3.jpg'))
  await expect(studio.locator(`${sel('studio-slot-end')} img`)).toBeVisible()
  expect(host.studioOps.some((op) => op.kind === 'upload')).toBe(true)

  // Paid: the model picker shows prices and the balance; Generate only opens the confirm dialog.
  await studio.locator(sel('studio-backend')).click()
  await shell.getByRole('option', { name: /Higgsfield/ }).click()
  await expect(studio.locator(sel('studio-balance'))).toContainText('500 credits left')
  await studio.locator(sel('studio-model')).click()
  await expect(shell.getByRole('option', { name: /Kling 2\.5/ })).toContainText('40 credits')
  await expect(shell.getByRole('option', { name: /Hailuo 02/ })).toContainText('30 credits')
  await shot(app, shell, 'paid-model-picker')
  await shell.getByRole('option', { name: /Kling 2\.5/ }).click()
  const before = creates().length
  await studio.locator(sel('studio-generate')).click()
  const confirm = shell.locator(sel('studio-confirm'))
  await expect(confirm.locator(sel('studio-confirm-cost'))).toHaveText('40 credits')
  await expect(confirm.locator(sel('studio-confirm-after'))).toHaveText('460 credits')
  await expect(confirm).toContainText('Spend 40 credits on Higgsfield?')
  expect(creates().length).toBe(before)
  await shot(app, shell, 'paid-confirm')
  await confirm.locator(sel('studio-confirm-spend')).click()
  await expect(confirm.locator(sel('studio-confirm-cost'))).toHaveCount(0)
  expect(creates().length).toBe(before + 1)
  expect(creates().at(-1)).toMatchObject({
    origin: 'desktop',
    spec: { backend: 'higgsfield', model: 'kling-2-5', confirmCredits: 40 },
  })
  await expect(studio.locator(sel('studio-queue-row'))).toHaveCount(1)
})

test('agents generate, list and open Studio through the control API', async ({
  shell,
  configDir,
}) => {
  // studio.list: backends and finished jobs with links on the host's http port.
  const listed = await agent(configDir, 'studio.list', { state: 'done' })
  expect(listed.ok).toBe(true)
  const value = ListSchema.parse(listed.value)
  expect(value.backends.map((b) => b.id)).toEqual([
    'ltx',
    'codex-image',
    'codex-edit',
    'kontext',
    'comfyui',
    'higgsfield',
  ])
  expect(value.jobs).toHaveLength(2)
  const url = value.jobs[0]!.outputs[0]!.url
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/studio\//)
  expect((await fetch(url)).status).toBe(200)

  // A paid backend is refused with the way to ask Isaac instead; nothing reaches the host.
  const paid = await agent(configDir, 'studio.generate', {
    prompt: 'A neon city flythrough',
    backend: 'higgsfield',
  })
  expect(paid).toMatchObject({ ok: false, code: 'paid-backend' })
  expect(paid.message).toContain('studio.open')
  expect(creates()).toHaveLength(0)

  // studio.generate queues a free job as the agent and opens it in a Studio tool tab.
  const made = await agent(configDir, 'studio.generate', { prompt: 'A red kite', open: true })
  expect(made.ok).toBe(true)
  const { job } = MadeSchema.parse(made.value)
  expect(job).toMatchObject({ backend: 'codex-image', state: 'queued' })
  expect(creates().at(-1)).toMatchObject({ origin: 'agent', spec: { prompt: 'A red kite' } })
  await expect(shell.locator(STUDIO_TAB)).toBeVisible()
  const studio = shell.locator(sel('page-studio'))
  await expect(studio.locator(sel('studio-queue-row'))).toContainText('A red kite')
  host.finishStudio(job.id)
  const viewer = shell.locator(sel('studio-viewer'))
  await expect(viewer.locator(sel('studio-viewer-image'))).toBeVisible()
  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(viewer.locator(sel('studio-viewer-image'))).toHaveCount(0)

  // studio.open with a draft fills the composer for Isaac and sends nothing.
  const sent = creates().length
  const opened = await agent(configDir, 'studio.open', {
    draft: { prompt: 'Drafted by Eva', mode: 'video', backend: 'higgsfield', model: 'hailuo-02' },
  })
  expect(opened).toMatchObject({ ok: true, value: { tab: 'view:page:studio', draft: true } })
  await expect(studio.locator(sel('studio-prompt'))).toHaveValue('Drafted by Eva')
  await expect(studio.locator(sel('studio-backend'))).toHaveValue('Higgsfield (paid)')
  await expect(studio.locator(sel('studio-model'))).toHaveValue('Hailuo 02')
  expect(creates()).toHaveLength(sent)

  // The new job is in the list with its output.
  const after = await agent(configDir, 'studio.list', { limit: 1 })
  expect(after.value).toMatchObject({ jobs: [{ id: job.id, state: 'done' }] })
})

test('ComfyUI presets: cards, their own settings, references and no-prompt presets', async ({
  app,
  shell,
  configDir,
}) => {
  await openStudioTab(shell)
  const studio = shell.locator(sel('page-studio'))
  await studio.locator(sel('studio-backend')).click()
  await shell.getByRole('option', { name: /ComfyUI presets/ }).click()
  await expect(studio.locator(sel('studio-presets'))).toContainText('See the same subject')
  await expect(studio.locator(sel('studio-preset-angles'))).toHaveAttribute('aria-pressed', 'true')

  // Angles: its camera choice, a required reference, then a create with the preset and its setting.
  await studio.locator(sel('studio-prompt')).fill('Keep the logo sharp')
  await studio.locator(sel('studio-param-angle')).getByText('Top down').click()
  await expect(studio.locator(sel('studio-generate'))).toBeDisabled()
  await expect(studio.locator(sel('studio-problem'))).toHaveText('Add a reference image to edit.')
  await studio
    .locator(sel('studio-slot-ref-0-file'))
    .setInputFiles(path.join(FIXTURES_DIR, 'agent-widgets/media/gallery-3.jpg'))
  await expect(studio.locator(`${sel('studio-slot-ref-0')} img`)).toBeVisible()
  await expect(studio.locator(sel('studio-slot-ref-1'))).toHaveCount(0)
  await shot(app, shell, 'comfyui-angles')
  await studio.locator(sel('studio-generate')).click()
  await expect.poll(() => creates().length).toBe(1)
  expect(creates()[0]).toMatchObject({
    origin: 'desktop',
    spec: { backend: 'comfyui', model: 'angles', params: { angle: 'top' }, resolution: '1mp' },
  })
  expect((creates()[0]!.spec as { refs: string[] }).refs).toHaveLength(1)

  // Upscale takes no prompt: the box goes and the preset's name is sent; Angles' setting is dropped.
  await studio.locator(sel('studio-preset-upscale')).click()
  await expect(studio.locator(sel('studio-prompt'))).toHaveCount(0)
  await expect(studio.locator(sel('studio-param-angle'))).toHaveCount(0)
  await studio.locator(sel('studio-generate')).click()
  await expect.poll(() => creates().length).toBe(2)
  expect(creates()[1]).toMatchObject({ spec: { model: 'upscale', prompt: 'Upscale (SeedVR2)' } })
  expect(creates()[1]!.spec).not.toHaveProperty('params')

  // An agent must name a preset; the error lists them.
  const missing = await agent(configDir, 'studio.generate', { prompt: 'x', backend: 'comfyui' })
  expect(missing).toMatchObject({ ok: false, code: 'invalid-params' })
  expect(missing.message).toContain('angles, upscale')
  const made = await agent(configDir, 'studio.generate', {
    prompt: 'From the left',
    backend: 'comfyui',
    model: 'angles',
    params: { angle: 'left45' },
    refs: [(creates()[0]!.spec as { refs: string[] }).refs[0]],
  })
  expect(made.ok).toBe(true)
  expect(creates().at(-1)).toMatchObject({
    origin: 'agent',
    spec: { model: 'angles', params: { angle: 'left45' } },
  })
})
