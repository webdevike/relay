// A video shared as a Relay drop plays inline in a chat reply. The reply embeds it the way agents
// do, `![Demo clip](/drops/vid1/tok1)`; a stand-in Relay host (its port in
// <configDir>/relay/serve.json, as in widgets.spec.ts) serves a real 10 s H.264 mp4 as video/mp4
// plus its poster JPEG. The row must draw a <video> with the poster and native controls, and the
// clip must seek to 5 s and play through the relay-media: protocol's byte ranges.
//
// Screenshots go to $INLINE_VIDEO_PROOF_DIR (default test-results/inline-video):
// desktop-poster.png before play, desktop-playing.png while playing after the seek.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/inline-video.spec.ts
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { APP_DIR } from './helpers/paths'

const OUT = process.env.INLINE_VIDEO_PROOF_DIR ?? path.join(APP_DIR, 'test-results', 'inline-video')
const TITLE = 'Inline video'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

interface Host {
  port: number
  hits: string[]
}

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
const test = base.extend<{ host: Host }>({
  host: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-inline-video-'))
    const clip = path.join(root, 'clip.mp4')
    const poster = path.join(root, 'poster.jpg')
    // A real 10 s H.264 + AAC clip with the moov atom up front, and a frame from it as the poster.
    execFileSync('ffmpeg', [
      ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '10'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', clip],
    ])
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', clip, '-frames:v', '1', poster])
    const drops: Record<string, { file: string; type: string }> = {
      '/drops/vid1/tok1': { file: clip, type: 'video/mp4' },
      '/drops/vid1/tok1/poster': { file: poster, type: 'image/jpeg' },
    }
    const hits: string[] = []
    const server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
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
        'content-disposition': 'inline',
      })
      fs.createReadStream(drop.file).pipe(res)
    })
    const listening = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    await use({ port: (server.address() as AddressInfo).port, hits })
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
    fs.rmSync(root, { recursive: true, force: true })
  },
  launchEnv: async ({ host: _host }, use) => {
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
  configDir: async ({ configDir, host }, use) => {
    fs.mkdirSync(path.join(configDir, 'relay'), { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'relay', 'serve.json'),
      JSON.stringify({ port: host.port }),
    )
    await use(configDir)
  },
})

test.use({ toolPanes: false })

test('a video drop in a reply plays inline with its poster, and seeks', async ({
  app,
  shell,
  host,
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
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText(TITLE)

  const log = shell.locator(LOG)
  const video = log.locator('[data-testid=md-video] video')
  await expect(video).toBeAttached()
  await expect(log.locator('[data-testid=md-video]')).toContainText('Demo clip')
  expect(await video.getAttribute('poster')).toContain(
    encodeURIComponent('/drops/vid1/tok1/poster'),
  )
  const attrs = await video.evaluate((v: HTMLVideoElement) => ({
    controls: v.controls,
    preload: v.preload,
    autoplay: v.autoplay,
    muted: v.muted,
    playsInline: v.hasAttribute('playsinline'),
  }))
  expect(attrs).toEqual({
    controls: true,
    preload: 'metadata',
    autoplay: false,
    muted: false,
    playsInline: true,
  })
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0)
  const meta = await video.evaluate((v: HTMLVideoElement) => ({
    w: v.videoWidth,
    h: v.videoHeight,
    duration: v.duration,
    paused: v.paused,
    boxW: v.getBoundingClientRect().width,
    boxH: v.getBoundingClientRect().height,
    column: v.closest('.eva-md')!.getBoundingClientRect().width,
  }))
  expect(meta.w).toBe(1280)
  expect(meta.h).toBe(720)
  expect(meta.duration).toBeCloseTo(10, 0)
  expect(meta.paused).toBe(true)
  // Sized like an image: the column's width at the clip's own 16:9.
  expect(meta.boxW).toBeLessThanOrEqual(meta.column + 0.5)
  expect(meta.boxW / meta.boxH).toBeCloseTo(16 / 9, 1)

  // The poster has painted before anything plays.
  await video.evaluate(async (v: HTMLVideoElement) => {
    const img = new Image()
    img.src = v.poster
    await img.decode()
  })
  await video.scrollIntoViewIfNeeded()
  await shell.evaluate(() => {
    const painted = Promise.withResolvers<void>()
    requestAnimationFrame(() => requestAnimationFrame(() => painted.resolve()))
    return painted.promise
  })
  fs.mkdirSync(OUT, { recursive: true })
  await shell.screenshot({ path: path.join(OUT, 'desktop-poster.png') })

  // Seek to 5 s (a byte-range request into the cached drop), then play.
  await video.evaluate(async (v: HTMLVideoElement) => {
    const seeked = Promise.withResolvers<void>()
    v.addEventListener('seeked', () => seeked.resolve(), { once: true })
    v.currentTime = 5
    await seeked.promise
    await v.play()
  })
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(5.5)
  const first = await video.evaluate((v: HTMLVideoElement) => v.currentTime)
  await shell.waitForTimeout(500)
  const state = await video.evaluate((v: HTMLVideoElement) => ({
    t: v.currentTime,
    paused: v.paused,
    error: v.error?.code ?? null,
  }))
  expect(state.paused).toBe(false)
  expect(state.error).toBeNull()
  expect(state.t).toBeGreaterThan(first)
  await shell.screenshot({ path: path.join(OUT, 'desktop-playing.png') })
  console.log(
    `inline video: ${meta.w}x${meta.h} ${meta.duration.toFixed(2)}s, box ${Math.round(meta.boxW)}x${Math.round(meta.boxH)}, ` +
      `playing at ${state.t.toFixed(2)}s (was ${first.toFixed(2)}s), host hits: ${host.hits.join(', ')}`,
  )

  // Main fetched the drop and its poster once each from the Relay host; seeking came from the cache.
  expect(host.hits.filter((h) => h === 'GET /drops/vid1/tok1')).toHaveLength(1)
  expect(host.hits.filter((h) => h === 'GET /drops/vid1/tok1/poster')).toHaveLength(1)
})
