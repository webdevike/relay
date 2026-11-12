// A native WebContentsView paints over the renderer, so a page tab used to stay on top of a chat
// video made HTML-fullscreen. While the window reports HTML fullscreen every web view must be
// hidden; leaving restores each view's visibility and bounds. The window's enter/leave events are
// emitted from main: real fullscreen moves the desktop to a new Space.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/browser-video-fullscreen.spec.ts
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { expectViewOnSlot, openPage, viewOf } from './helpers/web'

const TITLE = 'Fullscreen video'
const VIDEO = '[data-testid=chat-pane] [data-testid=chat-log] [data-testid=md-video] video'

const session = (id: string) =>
  [
    { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: '2026-10-27T09:05:00.000Z' },
    {
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-10-27T09:00:00.000Z',
      cwd: '/fixture/eva-root',
    },
    {
      type: 'message',
      id: 'v001',
      parentId: null,
      timestamp: '2026-10-27T09:01:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Send me the demo clip.' }],
        attribution: 'user',
        timestamp: 1793091660000,
      },
    },
    {
      type: 'message',
      id: 'v002',
      parentId: 'v001',
      timestamp: '2026-10-27T09:02:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "Here's the clip:\n\n![Demo clip](/drops/vid1/tok1)" }],
        stopReason: 'stop',
        timestamp: 1793091720000,
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n'

let root = ''
let server: StaticServer
const test = base.extend<{ port: number }>({
  port: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-video-fs-'))
    const clip = path.join(root, 'clip.mp4')
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30'],
      ...['-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip],
    ])
    const poster = path.join(root, 'poster.jpg')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', clip, '-frames:v', '1', poster])
    const http1 = http.createServer((req, res) => {
      const file = { '/drops/vid1/tok1': clip, '/drops/vid1/tok1/poster': poster }[req.url ?? '']
      if (!file) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': file === poster ? 'image/jpeg' : 'video/mp4',
        'content-length': fs.statSync(file).size,
        'accept-ranges': 'bytes',
      })
      fs.createReadStream(file).pipe(res)
    })
    const listening = Promise.withResolvers<void>()
    http1.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    await use((http1.address() as AddressInfo).port)
    http1.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
  launchEnv: async ({ port: _port }, use) => {
    const sessionsDir = path.join(root, 'agent', 'sessions', '-fixture')
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionsDir, '2026-10-27T09-00-00-000Z_chat-video.jsonl'),
      session('chat-video'),
    )
    await use({
      EVAOS_AGENT_DIR: path.join(root, 'agent'),
      EVAOS_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_LOG: path.join(root, 'fake-omp.log'),
    })
  },
  configDir: async ({ configDir, port }, use) => {
    fs.mkdirSync(path.join(configDir, 'relay'), { recursive: true })
    fs.writeFileSync(path.join(configDir, 'relay', 'serve.json'), JSON.stringify({ port }))
    await use(configDir)
  },
})

interface ShellHooks {
  __evaosShell: { setPanel(open: boolean): void }
}

test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('a page tab hides under an HTML fullscreen chat video and comes back on exit', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator(VIDEO)).toBeAttached()
  await expect
    .poll(() => shell.locator(VIDEO).evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(0)

  // The chat's own workspace starts without tool panes; the panel toggle brings the pane back.
  await shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.setPanel(true))
  const id = await openPage(shell, server.url('/'))
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(true)
  const before = (await viewOf(app, id))!.bounds
  expect(before.width).toBeGreaterThan(0)
  await shell.locator(VIDEO).scrollIntoViewIfNeeded()

  // Real fullscreen would slide the desktop to a new Space, so main emits what Electron emits on
  // the shell's webContents when the renderer enters and leaves HTML fullscreen.
  const shellUrl = shell.url()
  const emit = (event: 'enter-html-full-screen' | 'leave-html-full-screen') =>
    app.evaluate(
      ({ webContents }, [name, url]) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
        if (!wc) throw new Error('no shell webContents')
        wc.emit(name, { sender: wc })
      },
      [event, shellUrl] as const,
    )
  // Twice over: enter and leave are repeatable and each leave restores the exact bounds.
  for (const _round of [1, 2]) {
    await emit('enter-html-full-screen')
    await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)
    await emit('leave-html-full-screen')
    await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(true)
    await expectViewOnSlot(app, shell, id)
  }
})
