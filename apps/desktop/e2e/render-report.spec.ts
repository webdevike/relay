// Media that fails to show in a reply is told to the host, so the owning agent can repost it in a
// form that renders. A stand-in Relay host (advertising "render.report") serves four drops; the
// chat carries one reply each: a GLB embedded as markdown (markdown can't draw 3D, so a file card
// and exactly one `render.failed` frame), the same GLB in an openui Model block (a canvas, no
// report), a markdown png and a markdown mp4 (both draw, no report).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/render-report.spec.ts
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { FIXTURES_DIR } from './helpers/paths'

const SESSION = 'p4-ecard'
const THREAD = `session:${SESSION}`
const GLB = '/drops/glb1/tok1'
const PNG_DROP = '/drops/png1/tok1'
const MP4 = '/drops/mp41/tok1'
// omp stamps every message; a bubble's reaction key (the report's `message`) is role@timestamp.
const MD_GLB_AT = 1792486880000
const UI_GLB_AT = 1792486881000
const PNG_AT = 1792486882000
const MP4_AT = 1792486883000

const sel = (id: string): string => `[data-testid="${id}"]`
const answer = (id: string, parentId: string, text: string, at: number): string =>
  JSON.stringify({
    type: 'message',
    id,
    parentId,
    message: {
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      timestamp: at,
    },
  })

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    expect(host.features).toContain('render.report')
    host.serveFile(
      GLB,
      fs.readFileSync(path.join(FIXTURES_DIR, 'agent-widgets', 'media', 'cube.glb')),
      'model/gltf-binary',
    )
    const picture = new PNG({ width: 160, height: 120 })
    for (let i = 0; i < picture.data.length; i += 4) picture.data.set([60, 120, 200, 255], i)
    host.serveFile(PNG_DROP, PNG.sync.write(picture), 'image/png')
    const clip = path.join(fx.root, 'clip.mp4')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '2'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip],
    ])
    // The host makes a poster for every video drop; without one the probe's HEAD logs a 404.
    const poster = path.join(fx.root, 'poster.jpg')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-frames:v', '1', poster])
    host.serveFile(`${MP4}/poster`, fs.readFileSync(poster), 'image/jpeg')
    host.serveFile(MP4, fs.readFileSync(clip), 'video/mp4')
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5', EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})

test.use({ toolPanes: false })

test('a markdown GLB reports once to the host; openui Model, png and mp4 render without a report', async ({
  shell,
}) => {
  await fx.append(SESSION, answer('r1', 'a1', `Here it is:\n\n![Cube](${GLB})`, MD_GLB_AT))
  await fx.append(
    SESSION,
    answer(
      'r2',
      'r1',
      `As a model:\n\n\`\`\`openui\nroot = Model("${GLB}", "Cube")\n\`\`\``,
      UI_GLB_AT,
    ),
  )
  await fx.append(SESSION, answer('r3', 'r2', `A picture:\n\n![Swatch](${PNG_DROP})`, PNG_AT))
  await fx.append(SESSION, answer('r4', 'r3', `A clip:\n\n![Clip](${MP4})`, MP4_AT))
  host.upsert({ id: SESSION, status: 'idle' })
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector(sel('chat-tree'))
  await shell.locator(sel(`chat-row-${SESSION}`)).click()

  // The log is virtual and sticks to the bottom: only rows near the viewport mount, so wheel up
  // until the first reply mounts before checking it.
  await expect(shell.locator(sel('msg-r4'))).toBeAttached()
  await shell.locator(sel('chat-log')).hover()
  const mdGlb = shell.locator(sel('msg-r1'))
  await expect(async () => {
    await shell.mouse.wheel(0, -2000)
    await expect(mdGlb).toBeAttached({ timeout: 500 })
  }).toPass()
  // Markdown can't draw 3D: a file card, never a broken image.
  await expect(mdGlb.locator(sel('md-file'))).toBeVisible()
  await expect(mdGlb.locator('img')).toHaveCount(0)

  // The openui Model block of the same drop draws the model.
  const uiGlb = shell.locator(sel('msg-r2'))
  await uiGlb.scrollIntoViewIfNeeded()
  await expect(uiGlb.locator('[data-testid=widget-model] canvas')).toBeVisible()
  await expect(uiGlb.locator('.eva-w-model')).toHaveAttribute('data-state', 'ready')

  // The png draws as an image, the mp4 as a video.
  const r3 = shell.locator(sel('msg-r3'))
  await r3.scrollIntoViewIfNeeded()
  const swatch = r3.getByAltText('Swatch')
  await expect(swatch).toBeVisible()
  await expect.poll(() => swatch.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(160)
  await shell.mouse.wheel(0, 4000)
  const video = shell.locator(sel('msg-r4')).locator('video')
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(1)

  // Exactly one report reached the host, for the markdown GLB.
  await expect.poll(() => host.renderFailures.length).toBe(1)
  // Give any straggler (a late image or video error) a moment to arrive before the final check.
  await shell.waitForTimeout(500)
  expect(host.renderFailures).toEqual([
    {
      t: 'render.failed',
      thread: THREAD,
      message: `assistant@${MD_GLB_AT}`,
      kind: 'model',
      form: 'markdown',
      src: GLB,
      error: 'served model/gltf-binary: 3D models only render in an openui Model block',
      surface: 'desktop',
    },
  ])
})
