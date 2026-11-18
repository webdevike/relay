/**
 * A scripted agent on the design canvas, for e2e specs: Nova's thread with an assistant registry,
 * the agent control API (`ok(action, params)` as `agent:nova`), a recorder of every card's
 * generation state as the board shows it (card-gen.machine.ts), and the proof kit (the board's
 * pane over the window, a CDP screencast, an mp4 at real timing, stills).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test as base, expect } from '../fixtures'
import { makeChatFixture } from './chat-fixture'
import { FakeRelayHost } from './fake-relay-host'
import { EVA_FIXTURE_ROOT } from './paths'

export interface RegistryAgent {
  id: string
  title: string
  scope: string
  avatar: string
}

const line = (o: unknown): string => JSON.stringify(o)

/** The app with Nova's thread open on `prompt`, `agents` in the registry, agent control on. */
export function canvasAgentTest(agents: readonly RegistryAgent[], prompt: string) {
  return base.extend({
    launchEnv: async ({}, use) => {
      const fx = makeChatFixture()
      const evaRoot = path.join(fx.root, 'eva-root')
      fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
      fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
      fs.writeFileSync(path.join(evaRoot, '.omp/assistant/agents.json'), JSON.stringify({ agents }))
      fs.writeFileSync(
        path.join(fx.sessionsDir, '2026-11-18T09-00-00-000Z_nova-1.jsonl'),
        [
          line({
            type: 'session',
            version: 3,
            id: 'nova-1',
            timestamp: new Date().toISOString(),
            cwd: evaRoot,
          }),
          line({
            type: 'message',
            id: 'u1',
            parentId: null,
            message: { role: 'user', content: prompt },
          }),
        ].join('\n') + '\n',
      )
      const relayDir = path.join(fx.root, 'relay')
      const host = await FakeRelayHost.start(relayDir)
      host.upsert({
        id: 'nova-1',
        status: 'idle',
        kind: 'assistant',
        assistant: 'nova',
        title: 'Nova',
      })
      await use({
        ...fx.launchEnv,
        EVAOS_EVA_ROOT: evaRoot,
        EVAOS_RELAY_DIR: relayDir,
        EVAOS_AGENT_CONTROL: '1',
      })
      await host.close()
      fx.cleanup()
    },
  })
}

type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Answer = { ok: boolean; value?: Record<string, unknown>; code?: string; message?: string }
export type Act = (
  action: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export const sel = (id: string): string => `[data-testid="${id}"]`

/** Agent control as Nova, once the app wrote its port; a failed action fails the test. */
export async function agentControl(configDir: string): Promise<Act> {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  return async (action, params) => {
    const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params, scope: 'agent:nova' }),
    })
    const r = (await res.json()) as Answer
    expect(r.ok, `${action}: ${r.code} ${r.message}`).toBe(true)
    return r.value!
  }
}

/** A 1920x1080 window on Nova's thread, a new board `title` open: its slug and board. */
export async function openBoard(
  app: ElectronApplication,
  shell: Page,
  ok: Act,
  title: string,
  chatText: string,
): Promise<{ slug: string; board: Locator }> {
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(w!, h!),
    [1920, 1080],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(1920)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agent:nova'))
  await expect(shell.locator(sel('chat-log'))).toContainText(chatText, { timeout: 15_000 })
  const opened = await ok('canvas.open', { title, caption: `Designing ${title}` })
  const slug = String(opened['slug'])
  const board = shell.locator(`${sel('canvas-board')}[data-slug="${slug}"]`)
  await expect(board).toBeVisible()
  return { slug, board }
}

/**
 * Every generation state each card shows, as the board draws it: per card id, the run of
 * `<data-gen>|<label text>` (a component card's frame) or `|<label text>` (a frame), deduplicated.
 */
export async function recordGen(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const w = window as unknown as { __gen: Record<string, string[]> }
    w.__gen = {}
    const snap = (): void => {
      const ids = new Set(Object.keys(w.__gen))
      for (const el of document.querySelectorAll<HTMLElement>(
        '[data-gen][data-testid^="canvas-proto-"], [data-testid^="canvas-gen-label-"]',
      )) {
        ids.add((el.dataset['testid'] ?? '').replace(/^canvas-(proto|gen-label)-/, ''))
      }
      for (const id of ids) {
        const body = document.querySelector<HTMLElement>(`[data-testid="canvas-proto-${id}"]`)
        const label = document.querySelector(`[data-testid="canvas-gen-label-${id}"]`)
        const s = `${body?.dataset['gen'] ?? ''}|${label?.textContent ?? ''}`
        const log = (w.__gen[id] ??= [])
        if (log.at(-1) !== s) log.push(s)
      }
    }
    new MutationObserver(snap).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-gen'],
    })
  })
}

/** What `recordGen` saw of card `id` so far. */
export function genLog(shell: Page, id: string): Promise<string[]> {
  return shell.evaluate(
    (key) => (window as unknown as { __gen: Record<string, string[]> }).__gen[key] ?? [],
    id,
  )
}

/** The board's pane over the whole window (so the cards read at a useful zoom): the crop of it. */
export async function zoomBoard(
  ok: Act,
  shell: Page,
  board: Locator,
  slug: string,
): Promise<string> {
  const panes: { pane: string; tabs: unknown[] }[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>
      if (typeof o['pane'] === 'string' && Array.isArray(o['tabs'])) panes.push(o as never)
      Object.values(o).forEach(walk)
    }
  }
  walk(await ok('layout.read', {}))
  const boardPane = panes.find((p) => JSON.stringify(p.tabs).includes(slug))
  expect(boardPane, 'the pane holding the board').toBeDefined()
  await ok('pane.zoom', { pane: boardPane!.pane, on: true })
  await shell.waitForTimeout(500)
  const dpr = await shell.evaluate(() => window.devicePixelRatio)
  const b = (await board.boundingBox())!
  const px = (n: number): number => 2 * Math.floor((n * dpr) / 2)
  return `crop=${px(b.width)}:${px(b.height)}:${px(b.x)}:${px(b.y)}`
}

/** Screencast frames (CDP) into `dir`, named by their timestamps; resolves a stopper. */
export async function record(shell: Page, dir: string): Promise<() => Promise<string[]>> {
  fs.mkdirSync(dir, { recursive: true })
  const frames: string[] = []
  const cdp = await shell.context().newCDPSession(shell)
  cdp.on('Page.screencastFrame', (f) => {
    const out = path.join(dir, `${f.metadata.timestamp!.toFixed(3)}.jpg`)
    fs.writeFileSync(out, Buffer.from(f.data, 'base64'))
    frames.push(out)
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 })
  return async () => {
    await cdp.send('Page.stopScreencast')
    await cdp.detach()
    return frames
  }
}

/**
 * The frames cropped by `crop` as `video` (an mp4 at their real timing) and a PNG still per
 * `stills` entry (the frame nearest its time, seconds since the epoch); the frames are removed.
 */
export function encode(
  frames: string[],
  crop: string,
  video: string,
  stills: Record<string, number>,
): void {
  const at = (f: string): number => Number(path.basename(f, '.jpg'))
  const sorted = [...frames].sort((a, b) => at(a) - at(b))
  const list = sorted
    .map((f, i) => {
      const next = sorted[i + 1]
      const dur = next ? Math.max(0.01, at(next) - at(f)) : 0.5
      return `file '${f}'\nduration ${dur.toFixed(3)}`
    })
    .join('\n')
  const dir = path.dirname(video)
  const listFile = path.join(dir, 'frames.txt')
  fs.writeFileSync(listFile, `${list}\nfile '${sorted.at(-1)!}'\n`)
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-vf',
    `${crop},fps=30,scale='min(1600,iw)':-2`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '20',
    video,
  ])
  for (const [out, t] of Object.entries(stills)) {
    const still = sorted.reduce((best, f) =>
      Math.abs(at(f) - t) < Math.abs(at(best) - t) ? f : best,
    )
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', still, '-vf', crop, out])
  }
  fs.rmSync(path.dirname(sorted[0]!), { recursive: true, force: true })
  fs.rmSync(listFile)
}
