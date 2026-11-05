// An m4a and an mp3 shared as Relay drops play inline in a chat reply. The reply embeds them the way
// agents do, `![Tone](/drops/aud1/tok1)`; a stand-in Relay host (its port in
// <configDir>/relay/serve.json, as in inline-video.spec.ts) serves real 6 s files with the types
// the host gives them (audio/mp4, audio/mpeg). Each row must draw an <audio> with native controls
// that loads its duration and plays, through the relay-media: protocol.
//
// Screenshots go to $INLINE_AUDIO_PROOF_DIR (default test-results/inline-audio): desktop-m4a.png and
// desktop-mp3.png, each while that clip plays.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/inline-audio.spec.ts
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { APP_DIR } from './helpers/paths'

const OUT = process.env.INLINE_AUDIO_PROOF_DIR ?? path.join(APP_DIR, 'test-results', 'inline-audio')
const TITLE = 'Inline audio'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

interface Host {
  port: number
}

const session = (id: string) =>
  [
    { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: '2026-10-27T09:05:00.000Z' },
    { type: 'session', version: 3, id, timestamp: '2026-10-27T09:00:00.000Z', cwd: '/fixture/eva-root' },
    {
      type: 'message',
      id: 'a001',
      parentId: null,
      timestamp: '2026-10-27T09:01:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Send me the recordings.' }],
        attribution: 'user',
        timestamp: 1793091660000,
      },
    },
    {
      type: 'message',
      id: 'a002',
      parentId: 'a001',
      timestamp: '2026-10-27T09:02:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: "Here you go:\n\n![Tone m4a](/drops/aud1/tok1)\n\n![Tone mp3](/drops/aud2/tok2)",
          },
        ],
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-inline-audio-'))
    const m4a = path.join(root, 'tone.m4a')
    const mp3 = path.join(root, 'tone.mp3')
    const sine = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6']
    execFileSync('ffmpeg', [...sine, '-c:a', 'aac', '-movflags', '+faststart', m4a])
    execFileSync('ffmpeg', [...sine, '-c:a', 'libmp3lame', mp3])
    const drops: Record<string, { file: string; type: string }> = {
      '/drops/aud1/tok1': { file: m4a, type: 'audio/mp4' },
      '/drops/aud2/tok2': { file: mp3, type: 'audio/mpeg' },
    }
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
        'content-disposition': 'inline',
      })
      if (req.method === 'HEAD') res.end()
      else fs.createReadStream(drop.file).pipe(res)
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
    fs.writeFileSync(path.join(sessionsDir, '2026-10-27T09-00-00-000Z_chat-audio.jsonl'), session('chat-audio'))
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

test('audio drops in a reply play inline with native controls', async ({ app, shell }) => {
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
  const players = log.locator('[data-testid=md-audio] audio')
  await expect(players).toHaveCount(2)
  fs.mkdirSync(OUT, { recursive: true })
  for (const [i, name] of ['m4a', 'mp3'].entries()) {
    const audio = players.nth(i)
    expect(await audio.evaluate((a: HTMLAudioElement) => a.controls)).toBe(true)
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0)
    expect(await audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeCloseTo(6, 0)
    await audio.evaluate(async (a: HTMLAudioElement) => {
      a.currentTime = 1
      await a.play()
    })
    await expect
      .poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 10_000 })
      .toBeGreaterThan(1.5)
    const state = await audio.evaluate((a: HTMLAudioElement) => ({ paused: a.paused, error: a.error?.code ?? null }))
    expect(state).toEqual({ paused: false, error: null })
    await audio.scrollIntoViewIfNeeded()
    await shell.screenshot({ path: path.join(OUT, `desktop-${name}.png`) })
    await audio.evaluate((a: HTMLAudioElement) => a.pause())
  }
})
