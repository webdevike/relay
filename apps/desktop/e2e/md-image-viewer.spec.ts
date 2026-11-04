// Clicking a markdown image in a reply opens the viewer with every image of that reply: in order,
// starting at the clicked one, with prev/next buttons, arrow keys and "Image N of M". A video in
// the reply stays inline and is not a viewer page. A stand-in Relay host (port in
// <configDir>/relay/serve.json, as in inline-video.spec.ts) serves four PNG drops and one mp4.
//
// Screenshot: $MD_IMAGE_VIEWER_PROOF_DIR (default test-results/md-image-viewer)/viewer-2-of-4.png
//
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/md-image-viewer.spec.ts --retries 0 --max-failures 1
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { APP_DIR } from './helpers/paths'
import { pickScheme } from './helpers/appearance'

const OUT = process.env.MD_IMAGE_VIEWER_PROOF_DIR ?? path.join(APP_DIR, 'test-results', 'md-image-viewer')
const TITLE = 'Markdown image viewer'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'
const COLORS = ['0x3b82f6', '0xef4444', '0x22c55e', '0xeab308']

const reply = [
  'Four shots and a clip:',
  '![Blue](/drops/img1/tok)',
  '![Red](/drops/img2/tok)',
  '![Clip](/drops/vid/tok)',
  '![Green](/drops/img3/tok)',
  '![Yellow](/drops/img4/tok)',
].join('\n\n')

const session = (id: string) =>
  [
    { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: '2026-10-27T09:05:00.000Z' },
    { type: 'session', version: 3, id, timestamp: '2026-10-27T09:00:00.000Z', cwd: '/fixture/eva-root' },
    {
      type: 'message',
      id: 'm001',
      parentId: null,
      timestamp: '2026-10-27T09:01:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Show me the shots.' }],
        attribution: 'user',
        timestamp: 1793091660000,
      },
    },
    {
      type: 'message',
      id: 'm002',
      parentId: 'm001',
      timestamp: '2026-10-27T09:02:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        stopReason: 'stop',
        timestamp: 1793091720000,
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n'

let root = ''
const test = base.extend<{ host: { port: number } }>({
  host: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-md-images-'))
    const drops: Record<string, { file: string; type: string }> = {}
    COLORS.forEach((color, i) => {
      const file = path.join(root, `img${i + 1}.png`)
      execFileSync('ffmpeg', [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x400`],
        ...['-frames:v', '1', file],
      ])
      drops[`/drops/img${i + 1}/tok`] = { file, type: 'image/png' }
    })
    const clip = path.join(root, 'clip.mp4')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '1'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip],
    ])
    drops['/drops/vid/tok'] = { file: clip, type: 'video/mp4' }
    const poster = path.join(root, 'poster.jpg')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-frames:v', '1', poster])
    drops['/drops/vid/tok/poster'] = { file: poster, type: 'image/jpeg' }
    const server = http.createServer((req, res) => {
      const drop = drops[req.url ?? '']
      if (!drop) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': drop.type,
        'content-length': fs.statSync(drop.file).size,
        'accept-ranges': 'bytes',
      })
      fs.createReadStream(drop.file).pipe(res)
    })
    const listening = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    await use({ port: (server.address() as AddressInfo).port })
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
    fs.rmSync(root, { recursive: true, force: true })
  },
  launchEnv: async ({ host: _host }, use) => {
    const sessionsDir = path.join(root, 'agent', 'sessions', '-fixture')
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionsDir, '2026-10-27T09-00-00-000Z_chat-mdimg.jsonl'),
      session('chat-mdimg'),
    )
    await use({
      EVAOS_AGENT_DIR: path.join(root, 'agent'),
      EVAOS_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_LOG: path.join(root, 'fake-omp.log'),
    })
  },
  configDir: async ({ configDir, host }, use) => {
    fs.mkdirSync(path.join(configDir, 'relay'), { recursive: true })
    fs.writeFileSync(path.join(configDir, 'relay', 'serve.json'), JSON.stringify({ port: host.port }))
    await use(configDir)
  },
})

test.use({ toolPanes: false })

test('a markdown image opens the viewer on all of the reply images, in order', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await app.evaluate(
    (_e, [w, h]) => {
      const hooks = globalThis as unknown as {
        __evaosTest: { win: { setContentSize(w: number, h: number): void } }
      }
      hooks.__evaosTest.win.setContentSize(w, h)
    },
    [1280, 900] as const,
  )
  await pickScheme(shell, 'dark')
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'dark')
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText(TITLE)

  const log = shell.locator(LOG)
  await expect(log.locator('[data-testid=md-video]')).toHaveCount(1)
  await expect(log.locator('[data-testid=md-image]')).toHaveCount(4)

  // Click the first image: all four pages, video not among them.
  await log.getByRole('button', { name: 'Open Blue' }).click()
  const viewer = shell.getByTestId('image-viewer')
  await expect(viewer).toContainText('Image 1 of 4')
  await expect(shell.getByTestId('viewer-prev')).toBeDisabled()

  await shell.getByTestId('viewer-next').click()
  await expect(viewer).toContainText('Image 2 of 4')
  await expect(viewer.locator('img.eva-viewer-img')).toHaveAttribute(
    'src',
    new RegExp(encodeURIComponent('/drops/img2/tok')),
  )
  // Wait for the picture to load before shooting.
  await expect
    .poll(() => viewer.locator('img.eva-viewer-img').evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0)
  fs.mkdirSync(OUT, { recursive: true })
  await shell.screenshot({ path: path.join(OUT, 'viewer-2-of-4.png') })

  // Arrow keys page too, and stop at the ends (the clip is not a page: Green follows Red).
  await shell.keyboard.press('ArrowRight')
  await expect(viewer).toContainText('Image 3 of 4')
  await expect(viewer.locator('img.eva-viewer-img')).toHaveAttribute(
    'src',
    new RegExp(encodeURIComponent('/drops/img3/tok')),
  )
  await shell.keyboard.press('ArrowRight')
  await expect(viewer).toContainText('Image 4 of 4')
  await expect(shell.getByTestId('viewer-next')).toBeDisabled()
  await shell.keyboard.press('ArrowLeft')
  await expect(viewer).toContainText('Image 3 of 4')
  await shell.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  // Clicking the third image starts there.
  await log.getByRole('button', { name: 'Open Green' }).click()
  await expect(shell.getByTestId('image-viewer')).toContainText('Image 3 of 4')
})
