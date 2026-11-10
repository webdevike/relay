// A video with sound plays to its end with a big chat store watched. Isaac's omp stores held
// ~11k session files; the chat watcher kept a descriptor open per file, and past ~10k descriptors
// macOS Chromium could no longer start a sandboxed helper, so the audio service died on launch and
// every video with sound failed with MEDIA_ERR_DECODE (AUDIO_RENDERER_ERROR). The store here
// holds 11,000 session files; the main process must stay far below that in descriptors and the
// clip must play through with its audio decoded by a running audio service.
//
// VIDEO_AUDIO_FILES (comma-separated mp4 paths) plays those files instead of the generated
// 4 s H.264 + AAC clip, each as its own drop. Volume is near zero: the sound goes through the real
// output device without disturbing anyone at the Mac.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/video-audio.spec.ts
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'

const TITLE = 'Video with sound'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'
const STORE_FILES = 11_000

interface Host {
  drops: string[]
  hits: string[]
}

const session = (id: string, drops: readonly string[]) =>
  [
    { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: '2026-11-10T15:05:00.000Z' },
    { type: 'session', version: 3, id, timestamp: '2026-11-10T15:00:00.000Z', cwd: '/fixture' },
    {
      type: 'message',
      id: 'a001',
      parentId: null,
      timestamp: '2026-11-10T15:01:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Share the cut.' }],
        attribution: 'user',
        timestamp: 1794322860000,
      },
    },
    {
      type: 'message',
      id: 'a002',
      parentId: 'a001',
      timestamp: '2026-11-10T15:02:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: drops.map((d, i) => `![Cut ${i + 1}](${d})`).join('\n\n') },
        ],
        stopReason: 'stop',
        timestamp: 1794322920000,
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n'

let root = ''
const test = base.extend<{ host: Host }>({
  host: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-video-audio-'))
    let files = (process.env.VIDEO_AUDIO_FILES ?? '').split(',').filter(Boolean)
    if (files.length === 0) {
      const clip = path.join(root, 'clip.mp4')
      execFileSync('ffmpeg', [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-ac', '2', '-t', '4'],
        ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'],
        clip,
      ])
      files = [clip]
    }
    // Each drop with its poster frame, as the Relay host serves them.
    const byUrl = new Map<string, { file: string; type: string }>()
    files.forEach((file, i) => {
      const poster = path.join(root, `poster${i}.jpg`)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-ss',
        '1',
        '-i',
        file,
        '-frames:v',
        '1',
        poster,
      ])
      byUrl.set(`/drops/vid${i}/tok${i}`, { file, type: 'video/mp4' })
      byUrl.set(`/drops/vid${i}/tok${i}/poster`, { file: poster, type: 'image/jpeg' })
    })
    const hits: string[] = []
    const server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      const drop = byUrl.get(req.url ?? '')
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
      if (req.method === 'HEAD') res.end()
      else fs.createReadStream(drop.file).pipe(res)
    })
    const listening = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    const port = (server.address() as AddressInfo).port
    fs.mkdirSync(path.join(root, 'relay'), { recursive: true })
    fs.writeFileSync(path.join(root, 'relay', 'serve.json'), JSON.stringify({ port }))
    await use({ drops: files.map((_, i) => `/drops/vid${i}/tok${i}`), hits })
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
    fs.rmSync(root, { recursive: true, force: true })
  },
  launchEnv: async ({ host }, use) => {
    const sessionsDir = path.join(root, 'agent', 'sessions', '-fixture')
    fs.mkdirSync(sessionsDir, { recursive: true })
    // Old sessions: they only fill the store the chat watcher sees.
    const old = new Date('2026-09-01T00:00:00Z')
    for (let i = 0; i < STORE_FILES; i++) {
      const f = path.join(sessionsDir, `2026-09-01T00-00-00-000Z_old-${i}.jsonl`)
      fs.writeFileSync(f, '')
      fs.utimesSync(f, old, old)
    }
    fs.writeFileSync(
      path.join(sessionsDir, '2026-11-10T15-00-00-000Z_chat-video-audio.jsonl'),
      session('chat-video-audio', host.drops),
    )
    await use({
      EVAOS_AGENT_DIR: path.join(root, 'agent'),
      EVAOS_SESSIONS_DIR: sessionsDir,
      EVAOS_RELAY_DIR: path.join(root, 'relay'),
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_LOG: path.join(root, 'fake-omp.log'),
    })
  },
})

test.use({ toolPanes: false })

test('a video with sound plays to its end while a big chat store is watched', async ({
  app,
  shell,
  host,
}) => {
  test.setTimeout(300_000)
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText(TITLE)

  const videos = shell.locator(LOG).locator('[data-testid=md-video] video')
  await expect(videos).toHaveCount(host.drops.length)
  for (let i = 0; i < host.drops.length; i++) {
    const video = videos.nth(i)
    await video.scrollIntoViewIfNeeded()
    const played = await video.evaluate(async (v: HTMLVideoElement) => {
      const done = Promise.withResolvers<void>()
      v.addEventListener('ended', () => done.resolve(), { once: true })
      v.addEventListener('error', () => done.resolve(), { once: true })
      v.volume = 0.02
      await v.play().catch(() => done.resolve())
      await done.promise
      return {
        ended: v.ended,
        error: v.error ? `${v.error.code} ${v.error.message}` : null,
        duration: v.duration,
        currentTime: v.currentTime,
        // Chromium's count of audio bytes decoded for this element: 0 when no audio rendered.
        audioBytes: 'webkitAudioDecodedByteCount' in v ? Number(v.webkitAudioDecodedByteCount) : 0,
      }
    })
    const services = await app.evaluate(({ app: a }) =>
      a.getAppMetrics().map((p) => p.serviceName ?? p.type),
    )
    console.log(`video-audio ${host.drops[i]}: ${JSON.stringify(played)}`)
    expect(played.error).toBeNull()
    expect(played.ended).toBe(true)
    expect(played.currentTime).toBeCloseTo(played.duration, 0)
    expect(played.audioBytes).toBeGreaterThan(0)
    expect(services).toContain('audio.mojom.AudioService')
  }
  await expect(shell.getByText("Couldn't load video")).toHaveCount(0)

  // The root cause, measured: the watched store costs the main process no descriptor per file.
  const fds =
    execFileSync('lsof', ['-p', String(app.process().pid)], { encoding: 'utf8' }).split('\n')
      .length - 2
  console.log(`video-audio: main process open descriptors ${fds} with ${STORE_FILES} session files`)
  expect(fds).toBeLessThan(2000)
})
