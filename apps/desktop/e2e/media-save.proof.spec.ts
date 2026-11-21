import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, FIXTURES_DIR } from './helpers/paths'
import type { MediaSaveHook } from '../src/main/media/media-ipc'

const UI_CHECK = process.env['EVAOS_MEDIA_UI_CHECK']
const PROOF_PORT = '19541'
const IMAGE = '/drops/proof-image/image-secret'
const SECOND = '/drops/proof-second/second-secret'
const VIDEO = '/drops/proof-video/video-secret'
const TITLE = 'Media actions proof'

type MediaProofMain = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
    hooks: { mediaSave: MediaSaveHook }
  }
}
let expectedVideo: Buffer
const fixtureImage = (name: string) =>
  fs.readFileSync(path.join(FIXTURES_DIR, 'agent-widgets/media', name))

const test = base.extend({
  launchEnv: async ({}, use) => {
    const fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    const relayDir = path.join(fx.root, 'relay')
    const host = await FakeRelayHost.start(relayDir)
    try {
      const movie = path.join(fx.root, 'clip.mp4')
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=2:size=320x180',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        movie,
      ])
      host.serveFile(IMAGE, fixtureImage('before.png'), 'image/png')
      host.serveFile(SECOND, fixtureImage('gallery-1.jpg'), 'image/jpeg')
      expectedVideo = fs.readFileSync(movie)
      host.serveFile(VIDEO, expectedVideo, 'video/mp4')
      host.serveFile(`${VIDEO}/poster`, fixtureImage('gallery-1.jpg'), 'image/jpeg')
      const timestamp = new Date().toISOString()
      const content = [
        `![Captioned image](${IMAGE})`,
        `![Preview still](${SECOND})`,
        `![Proof clip](${VIDEO})`,
        [
          '```openui',
          'root = Gallery([still], "Media gallery")',
          `still = GalleryImage("${SECOND}", "Gallery still")`,
          '```',
        ].join('\n'),
      ].join('\n\n')
      const rows = [
        { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: timestamp },
        { type: 'session', version: 3, id: 'media-actions', timestamp, cwd: evaRoot },
        {
          type: 'message',
          id: 'media-user',
          parentId: null,
          timestamp,
          message: { role: 'user', content: [{ type: 'text', text: 'Show me the media.' }] },
        },
        {
          type: 'message',
          id: 'media-reply',
          parentId: 'media-user',
          timestamp,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: content }],
            stopReason: 'stop',
          },
        },
      ]
      fs.writeFileSync(
        path.join(fx.sessionsDir, '2026-11-20T09-00-00-000Z_media-actions.jsonl'),
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      )
      await use({
        ...fx.launchEnv,
        EVAOS_EVA_ROOT: evaRoot,
        EVAOS_RELAY_DIR: relayDir,
        ...(UI_CHECK ? { EVAOS_CDP_PORT: PROOF_PORT } : {}),
      })
    } finally {
      await host.close()
      fx.cleanup()
    }
  },
})

test.use({ startOnChat: false, toolPanes: false, reducedMotion: 'reduce' })

test('chat media actions in the hidden built app', async ({ app, shell, configDir }, testInfo) => {
  const out = process.env['EVAOS_MEDIA_PROOF_DIR'] ?? testInfo.outputDir
  fs.mkdirSync(out, { recursive: true })
  test.setTimeout(90_000)
  await app.evaluate(() =>
    (globalThis as unknown as MediaProofMain).__evaosTest.win.setContentSize(1100, 900),
  )
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: /^Media actions proof/ })
    .click()
  const log = shell.getByTestId('chat-log')
  const openImage = log.getByRole('button', { name: 'Open Captioned image' })
  const image = openImage.locator('img')
  const video = log.getByTestId('md-video').locator('video')
  const menu = shell.getByTestId('media-menu')
  const probe = () =>
    app.evaluate(() => (globalThis as unknown as MediaProofMain).__evaosTest.hooks.mediaSave)
  const choosePath = (where: string) =>
    app.evaluate((_electron, answer) => {
      const main = globalThis as unknown as MediaProofMain
      main.__evaosTest.hooks.mediaSave.answer = answer
    }, where)

  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
  const imageWidth = await image.evaluate((img: HTMLImageElement) => img.naturalWidth)
  await image.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('media-menu-copy')).toHaveText('Copy Image')
  await expect(menu.getByTestId('media-menu-save')).toContainText('Save Image As')
  await expect(menu.getByTestId('media-menu-address')).toHaveText('Copy Image Address')
  await shell.screenshot({ path: path.join(out, 'desktop-image-menu.png') })
  await menu.getByTestId('media-menu-copy').click()
  await expect
    .poll(async () => (await probe()).clipboard.at(-1))
    .toMatchObject({ kind: 'image', width: imageWidth })

  const imagePath = path.join(configDir, 'image.png')
  await choosePath(imagePath)
  await openImage.click()
  const viewer = shell.getByTestId('image-viewer')
  await expect(viewer.getByAltText('Image 1 of 2')).toBeVisible()
  await expect(viewer.getByTestId('viewer-download')).toBeVisible()
  const download = await viewer.getByTestId('viewer-download').boundingBox()
  const close = await viewer.getByRole('button', { name: 'Close' }).boundingBox()
  const buttonGap = download && close ? close.x - (download.x + download.width) : Infinity
  expect(buttonGap).toBeGreaterThanOrEqual(0)
  expect(buttonGap).toBeLessThan(24)
  await shell.screenshot({ path: path.join(out, 'desktop-viewer.png') })
  if (UI_CHECK) {
    const audit = execFileSync(
      'bun',
      [
        UI_CHECK,
        '--cdp',
        `http://127.0.0.1:${PROOF_PORT}`,
        '--page',
        'index.html',
        '--scope',
        '[data-testid=image-viewer]',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    )
    fs.writeFileSync(path.join(out, 'desktop-viewer-ui-check.json'), audit)
    expect(JSON.parse(audit).counts.error).toBe(0)
  }
  await shell.keyboard.press('Meta+s')
  await expect
    .poll(() =>
      fs.existsSync(imagePath)
        ? fs.readFileSync(imagePath).equals(fixtureImage('before.png'))
        : false,
    )
    .toBe(true)
  expect((await probe()).dialogs.at(-1)?.defaultPath).toBe(
    path.join(os.homedir(), 'Downloads', 'captioned-image.png'),
  )

  const secondPath = path.join(configDir, 'second.jpg')
  await choosePath(secondPath)
  await shell.keyboard.press('ArrowRight')
  const current = viewer.getByAltText('Image 2 of 2')
  await expect(current).toBeVisible()
  await expect
    .poll(() => current.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
  const currentWidth = await current.evaluate((img: HTMLImageElement) => img.naturalWidth)
  await shell.keyboard.press('Meta+c')
  await expect
    .poll(async () => (await probe()).clipboard.at(-1))
    .toMatchObject({
      kind: 'image',
      width: currentWidth,
    })
  await viewer.getByTestId('viewer-download').click()
  await expect
    .poll(() =>
      fs.existsSync(secondPath)
        ? fs.readFileSync(secondPath).equals(fixtureImage('gallery-1.jpg'))
        : false,
    )
    .toBe(true)
  expect((await probe()).dialogs.at(-1)?.defaultPath).toBe(
    path.join(os.homedir(), 'Downloads', 'preview-still.jpg'),
  )
  await shell.keyboard.press('Escape')
  await expect(viewer).not.toBeVisible()

  await video.scrollIntoViewIfNeeded()
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(320)
  await video.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('media-menu-copy')).toHaveCount(0)
  await expect(menu.getByTestId('media-menu-save')).toContainText('Save Video As')
  await expect(menu.getByTestId('media-menu-address')).toHaveText('Copy Video Address')
  await shell.screenshot({ path: path.join(out, 'desktop-video-menu.png') })
  await menu.getByTestId('media-menu-address').click()
  await expect
    .poll(async () => (await probe()).clipboard.at(-1))
    .toMatchObject({
      kind: 'text',
      text: expect.stringContaining(VIDEO),
    })
  const videoPath = path.join(configDir, 'video.mp4')
  await choosePath(videoPath)
  await video.click({ button: 'right' })
  await menu.getByTestId('media-menu-save').click()
  await expect.poll(async () => (await probe()).saves.at(-1)?.path).toBe(videoPath)
  expect(fs.readFileSync(videoPath).equals(expectedVideo)).toBe(true)
  expect((await probe()).dialogs.at(-1)?.defaultPath).toBe(
    path.join(os.homedir(), 'Downloads', 'proof-clip.mp4'),
  )

  const videoViewer = shell.getByTestId('video-viewer')
  const viewerPath = path.join(configDir, 'fullscreen.mp4')
  await choosePath(viewerPath)
  await video.hover()
  await log.getByTestId('video-expand').click()
  await expect(videoViewer.getByTestId('viewer-download')).toBeVisible()
  await expect
    .poll(() =>
      videoViewer
        .getByTestId('video-viewer-video')
        .evaluate((el: HTMLVideoElement) => el.videoWidth),
    )
    .toBe(320)
  await shell.screenshot({ path: path.join(out, 'desktop-video-viewer.png') })
  await shell.keyboard.press('Meta+s')
  await expect.poll(async () => (await probe()).saves.at(-1)?.path).toBe(viewerPath)
  expect(fs.readFileSync(viewerPath).equals(expectedVideo)).toBe(true)
  await shell.keyboard.press('Escape')
  await expect(videoViewer).not.toBeVisible()

  const gallery = log.getByTestId('widget-gallery')
  const galleryImage = gallery.getByRole('button', { name: 'Open Gallery still' }).locator('img')
  await galleryImage.scrollIntoViewIfNeeded()
  await expect
    .poll(() => galleryImage.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
  await galleryImage.click({ button: 'right' })
  await expect(menu.getByTestId('media-menu-copy')).toHaveText('Copy Image')
})
