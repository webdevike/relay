import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { z } from 'zod'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// Studio's full-screen editor against the fake Relay host: the versions strip and stepping,
// compare, SAM 2.1 segments and a masked edit, the generating overlay until the host finishes the
// job, then every tool's `create` op as the host receives it. Nothing generates: the fake host
// finishes jobs with fixture files when the test says so.
let host: FakeRelayHost
let root: string
let original: string
let child: string

const ORIGINAL_SPEC = {
  mode: 'image',
  backend: 'moss',
  model: 'moss-image',
  prompt: 'Portrait study, curly red hair, green jacket, park',
  aspect: '9:16',
  resolution: '768x1344',
}

const test = base.extend({
  startOnChat: false,
  toolPanes: false,
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-studio-editor-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    const first = host.addStudioJob(ORIGINAL_SPEC, 'desktop', { project: 'proj-portraits' })
    original = outputOf(first)
    const second = host.addStudioJob(
      {
        ...ORIGINAL_SPEC,
        backend: 'kontext',
        model: undefined,
        prompt: 'Neon light',
        refs: [original],
      },
      'desktop',
      { project: 'proj-portraits', parent: { asset: original, how: 'edit' } },
    )
    child = outputOf(second)
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`

const JobSchema = z.object({ outputs: z.array(z.object({ id: z.string() })).min(1) })
/** A fake-host job's first output id. */
function outputOf(job: unknown): string {
  return JobSchema.parse(job).outputs[0]!.id
}

/** A `create` op as the host received it. */
const CreateSchema = z.object({
  spec: z.looseObject({
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    seed: z.number().optional(),
  }),
  project: z.string().optional(),
  parent: z.object({ asset: z.string(), how: z.string() }).optional(),
})
type Create = z.infer<typeof CreateSchema>
const CropSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
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

/** The `create` the host got after `before` of them. */
async function nextCreate(before: number): Promise<Create> {
  await expect.poll(() => creates().length).toBe(before + 1)
  return CreateSchema.parse(creates()[before])
}

/** Finishes the newest queued or running job; resolves with its output's asset id. */
function finishNewest(): string {
  const job = host.studio.jobs.find((j) => j.state === 'queued' || j.state === 'running')
  if (!job) throw new Error('No Studio job is running')
  return outputOf(host.finishStudio(String(job.id)))
}

test('editor: versions, compare, segments, a masked edit, every tool op, back to the grid', async ({
  app,
  shell,
}) => {
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(w!, h!),
    [1440, 900],
  )
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('studio'))
  const studio = shell.locator(sel('page-studio'))
  await expect(studio).toBeVisible()

  // Open the original from the grid: the strip holds the original and its child.
  await studio.locator(`${sel('studio-tile')}[data-id="${original}"]`).click()
  const editor = studio.locator(sel('studio-editor'))
  await expect(editor).toBeVisible()
  const versions = editor.locator(sel('studio-ed-version'))
  await expect(versions).toHaveCount(2)
  await expect(versions.nth(0)).toHaveAttribute('data-on', 'true')
  const media = editor.locator(sel('studio-ed-media'))
  await expect(media).toHaveAttribute('data-id', original)

  // Left/Right step through the versions only.
  await shell.keyboard.press('ArrowRight')
  await expect(media).toHaveAttribute('data-id', child)
  await expect(versions.nth(1)).toHaveAttribute('data-on', 'true')
  await shell.keyboard.press('ArrowRight')
  await expect(media).toHaveAttribute('data-id', child)
  await shell.keyboard.press('ArrowLeft')
  await expect(media).toHaveAttribute('data-id', original)
  await editor.locator(sel('studio-ed-next')).click()
  await expect(media).toHaveAttribute('data-id', child)

  // Hold Space: the parent version, labelled; let go: back.
  await shell.keyboard.down('Space')
  await expect(editor.locator(sel('studio-ed-parent-label'))).toBeVisible()
  await expect(media).toHaveAttribute('data-id', original)
  await shell.keyboard.up('Space')
  await expect(editor.locator(sel('studio-ed-parent-label'))).toHaveCount(0)
  await expect(media).toHaveAttribute('data-id', child)

  // Split compare: the parent on the left of a slider.
  await editor.locator(sel('studio-ed-split-toggle')).click()
  await expect(editor.locator(sel('studio-ed-split'))).toBeVisible()
  await expect(editor.locator(sel('studio-ed-split-before'))).toBeVisible()
  await shot(app, shell, 'editor-split-compare')
  await editor.locator(sel('studio-ed-split-toggle')).click()
  await expect(editor.locator(sel('studio-ed-split'))).toHaveCount(0)
  await shot(app, shell, 'editor')

  // Segments: asked for each image version as it shows, then listed; picking one shows its box.
  await expect
    .poll(() => host.studioOps.filter((o) => o.kind === 'segment').map((o) => o.asset))
    .toEqual(expect.arrayContaining([original, child]))
  const segs = editor.locator(sel('studio-ed-seg'))
  await expect(segs.first()).toBeVisible()
  const segId = String(await segs.first().getAttribute('data-id'))
  await segs.first().click()
  await expect(editor.locator(sel('studio-ed-mask'))).toBeVisible()
  await expect(editor.locator(sel('studio-ed-editing-only'))).toContainText('Editing only:')
  await shot(app, shell, 'editor-segments-selected')

  // Describe an edit with Qwen (the default): the masked edit of the current version.
  let n = creates().length
  await editor.locator(sel('studio-ed-prompt')).fill('Make it night')
  await editor.locator(sel('studio-ed-send')).click()
  const edit = await nextCreate(n)
  expect(edit.spec).toMatchObject({
    mode: 'image',
    backend: 'comfyui',
    model: 'qwen-edit',
    prompt: 'Make it night',
    // The fixture images are landscape: the aspect follows the image, not the original's spec.
    aspect: '16:9',
    resolution: '1mp',
    refs: [child],
    mask: segId,
  })
  expect(edit.parent).toEqual({ asset: child, how: 'edit' })
  expect(edit.project).toBe('proj-portraits')
  await expect(editor.locator(sel('studio-ed-overlay'))).toBeVisible()
  await expect(editor.locator(sel('studio-ed-overlay'))).toContainText(
    /Generating \d+%|Waiting in the GPU queue/,
  )
  await expect(editor.locator(sel('studio-ed-pending'))).toHaveCount(1)
  await expect(editor.locator(sel('studio-ed-editing-only'))).toHaveCount(0)
  await shot(app, shell, 'editor-generating')

  // The host finishes it: the new version lands in the strip and is selected.
  let latest = finishNewest()
  await expect(versions).toHaveCount(3)
  await expect(media).toHaveAttribute('data-id', latest)
  await expect(editor.locator(sel(`studio-ed-version`)).last()).toHaveAttribute('data-on', 'true')
  await expect(editor.locator(sel('studio-ed-overlay'))).toHaveCount(0)

  /** Runs one tool on the version on screen, checks its op, finishes it. */
  const tool = async (
    click: () => Promise<void>,
    check: (op: Create, cur: string) => void,
  ): Promise<void> => {
    const cur = latest
    n = creates().length
    await click()
    const op = await nextCreate(n)
    check(op, cur)
    expect(op.project).toBe('proj-portraits')
    await expect(editor.locator(sel('studio-ed-overlay'))).toBeVisible()
    latest = finishNewest()
    await expect(media).toHaveAttribute('data-id', latest)
  }

  await tool(
    async () => {
      await editor.locator(sel('studio-ed-dir-top-left')).click()
      await editor.locator(sel('studio-ed-relight')).click()
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({
        backend: 'comfyui',
        model: 'relight',
        refs: [cur],
        params: { direction: 'top-left' },
        prompt: 'soft natural light',
      })
      expect(op.parent).toEqual({ asset: cur, how: 'relight' })
    },
  )

  await tool(
    async () => {
      await editor.locator(sel('studio-ed-angles')).getByText('Right', { exact: true }).click()
      await editor.locator(sel('studio-ed-angle')).click()
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({
        backend: 'comfyui',
        model: 'angles',
        refs: [cur],
        params: { angle: 'right45' },
        prompt: 'same scene',
      })
      expect(op.parent).toEqual({ asset: cur, how: 'angle' })
    },
  )

  await tool(
    async () => {
      await editor.locator(sel('studio-ed-factors')).getByText('4x', { exact: true }).click()
      await editor.locator(sel('studio-ed-upscale')).click()
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({ backend: 'comfyui', model: 'upscale', refs: [cur] })
      expect(op.spec.params?.size).toEqual(expect.any(String))
      expect(op.parent).toEqual({ asset: cur, how: 'upscale' })
    },
  )

  await tool(
    async () => {
      await editor.locator(sel('studio-ed-regenerate')).click()
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({
        backend: 'comfyui',
        model: 'upscale',
        refs: [expect.any(String)],
      })
      expect(op.spec.seed).toBeUndefined()
      expect(op.parent).toEqual({ asset: cur, how: 'regenerate' })
    },
  )

  // Crop: a rectangle on the canvas, dragged smaller from its corner, then Done.
  await editor.locator(sel('studio-ed-crop-start')).click()
  const cropBox = editor.locator(sel('studio-ed-crop'))
  await expect(cropBox).toBeVisible()
  const box = (await cropBox.boundingBox())!
  await shell.mouse.move(box.x + box.width, box.y + box.height)
  await shell.mouse.down()
  await shell.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 6 })
  await shell.mouse.up()
  await shot(app, shell, 'editor-crop')
  await tool(
    async () => {
      await editor.locator(sel('studio-ed-crop-done')).click()
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({ backend: 'crop', model: 'crop', refs: [cur], prompt: 'Crop' })
      const { x, y, w, h } = CropSchema.parse(op.spec.params)
      expect(x).toBeCloseTo(0.1, 1)
      expect(y).toBeCloseTo(0.1, 1)
      expect(w).toBeLessThan(0.8)
      expect(h).toBeLessThan(0.8)
      expect(x + w).toBeLessThanOrEqual(1)
      expect(op.parent).toEqual({ asset: cur, how: 'crop' })
    },
  )

  await tool(
    async () => {
      await editor.locator(sel('studio-ed-cutout')).click()
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({
        backend: 'sam',
        model: 'cutout',
        refs: [cur],
        prompt: 'Remove background',
      })
      expect(op.parent).toEqual({ asset: cur, how: 'cutout' })
    },
  )

  // Combine: the tool puts '@' in the bar and opens the picker; one more version joins the edit.
  await tool(
    async () => {
      await editor.locator(sel('studio-ed-combine')).click()
      const picker = editor.locator(sel('studio-at-picker'))
      await expect(picker).toBeVisible()
      await picker.getByRole('button', { name: 'Use image' }).first().click()
      await expect(editor.locator(sel('studio-ref-chip'))).toHaveCount(1)
      await expect(editor.locator(sel('studio-ed-engine'))).toContainText('FLUX.2 klein')
      await editor.locator(sel('studio-ed-prompt')).fill('Put them side by side')
      await editor.locator(sel('studio-ed-prompt')).press('Enter')
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({
        backend: 'comfyui',
        model: 'combine',
        prompt: 'Put them side by side',
        refs: [cur, original],
      })
      expect(op.parent).toEqual({ asset: cur, how: 'combine' })
    },
  )

  // Make video: LTX from this version; the video joins the strip with a play badge and plays.
  await editor.locator(sel('studio-ed-seconds')).getByText('8 s', { exact: true }).click()
  await tool(
    async () => {
      await editor.locator(sel('studio-ed-video')).click()
    },
    (op, cur) => {
      expect(op.spec).toMatchObject({
        mode: 'video',
        backend: 'ltx',
        frames: { start: cur },
        seconds: 8,
        prompt: 'Subtle natural motion',
      })
      expect(op.parent).toEqual({ asset: cur, how: 'video' })
    },
  )
  await expect(editor.locator('video[data-testid="studio-ed-media"]')).toBeVisible()
  await expect(editor.locator(sel('studio-ed-cutout'))).toBeDisabled()
  await expect(editor.locator(sel('studio-ed-prompt'))).toBeDisabled()

  // Escape: back to the grid.
  await shell.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(studio.locator(`${sel('studio-tile')}[data-id="${original}"]`)).toBeVisible()
})
