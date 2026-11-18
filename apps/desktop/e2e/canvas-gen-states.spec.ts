import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// Generation states on the design canvas (renderer canvas/agent/card-gen.machine.ts), after
// pen.dev: Nova (a scripted agent on the agent control API) adds an empty frame (creating: a
// spinner in it, a spinner ring at her named cursor's tip), then a component card that she writes
// section by section (generating: "Generating: <board> • <title>" in the accent, an accent border
// and a drifting light), breaks it once (error: the danger label, the last good render kept),
// fixes it, fills the frame, and finishes with canvas.done (done: the label goes plain), after
// which the cards settle back to idle. EVAOS_GEN_PROOF=<dir> also records the window (CDP
// screencast, motion on) into <dir>/gen-states.mp4 with a still per state.
const PROOF = process.env.EVAOS_GEN_PROOF ?? ''

let fx: ChatFixture
let host: FakeRelayHost
const line = (o: unknown): string => JSON.stringify(o)

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova-1' }],
      }),
    )
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
          message: { role: 'user', content: 'Design the session badges page with me' },
        }),
      ].join('\n') + '\n',
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
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
test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Answer = { ok: boolean; value?: Record<string, unknown>; code?: string; message?: string }

/** The page Nova writes, one section per edit after the title; MORE (a JSX comment) marks the end. */
const MORE = '{/* more */}'
const START = `<Stack gap="md" p="xl">
  <Title order={2}>Session badges</Title>
  <Text size="xs" c="dimmed" tt="uppercase">Chat badge strip / live states</Text>
  ${MORE}
</Stack>`
const SECTIONS = [
  `<ChipStrip>
    <SessionChip label="Fix login" state="running" />
    <SpecialistChip label="Web researcher" state="running" clock="0:12" />
    <SpecialistChip label="Design critic" state="done" />
  </ChipStrip>`,
  `<Group gap="xs"><AssistantAvatar face="nova-1" size="sm" /><Text size="sm">Nova is working on 3 badges</Text></Group>`,
  `<SimpleGrid cols={3} spacing="sm">
    <Paper withBorder p="sm"><Text size="sm" fw={500}>Running</Text><Text size="xs" c="dimmed">Spinner and clock</Text></Paper>
    <Paper withBorder p="sm"><Text size="sm" fw={500}>Done</Text><Text size="xs" c="dimmed">Quiet check</Text></Paper>
    <Paper withBorder p="sm"><Text size="sm" fw={500}>Failed</Text><Text size="xs" c="dimmed">Red dot, retry</Text></Paper>
  </SimpleGrid>`,
]

test('cards an agent makes show creating, generating, error and done, then settle', async ({
  shell,
  app,
  configDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  const ok = async (action: string, params: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params, scope: 'agent:nova' }),
    })
    const r = (await res.json()) as Answer
    expect(r.ok, `${action}: ${r.code} ${r.message}`).toBe(true)
    return r.value!
  }

  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(w!, h!),
    [1920, 1080],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(1920)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agent:nova'))
  await expect(shell.locator(sel('chat-log'))).toContainText('session badges', { timeout: 15_000 })

  const opened = await ok('canvas.open', { title: 'Session badges', caption: 'Designing badges' })
  const slug = String(opened['slug'])
  const board = shell.locator(`${sel('canvas-board')}[data-slug="${slug}"]`)
  await expect(board).toBeVisible()
  const cursor = board.locator(sel('canvas-agent-cursor'))

  // The recording shows the light drifting: e2e runs with motion off, the proof turns it on.
  const marks: Record<string, number> = {}
  const mark = (name: string): void => {
    marks[name] = Date.now() / 1000
  }
  let stop: (() => Promise<string[]>) | null = null
  let crop = ''
  if (PROOF !== '') {
    fs.rmSync(PROOF, { recursive: true, force: true })
    fs.mkdirSync(PROOF, { recursive: true })
    // The board's pane over the whole window, so the cards read at a useful zoom.
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
    crop = `crop=${px(b.width)}:${px(b.height)}:${px(b.x)}:${px(b.y)}`
    await shell.evaluate(() => (document.documentElement.dataset['evaMotion'] = 'on'))
    stop = await record(shell, path.join(PROOF, 'frames'))
  }

  // 1. An empty frame: creating, a spinner inside it and at the cursor's tip, until a card lands in it.
  const frame = String(
    (
      await ok('canvas.add', {
        slug,
        type: 'frame',
        title: 'Badge states',
        w: 640,
        h: 380,
        caption: 'Making a frame for the states',
      })
    )['id'],
  )
  const frameLabel = shell.locator(sel(`canvas-gen-label-${frame}`))
  await expect(frameLabel).toHaveAttribute('data-gen', 'creating')
  await expect(frameLabel).toHaveText('Creating: Session badges • Badge states')
  await expect(
    board.locator(`.react-flow__node[data-id="${frame}"] .eva-cv-gen-spinner`),
  ).toBeVisible()
  await expect(cursor).toHaveAttribute('data-making', 'true')
  mark('creating')
  await shell.waitForTimeout(2_500)

  // 2. A component card: creating until its page first draws, then generating as she writes it.
  const id = String(
    (
      await ok('canvas.add', {
        slug,
        type: 'proto',
        title: 'Badges page',
        body: START,
        data: { frame: 'page-narrow' },
        caption: 'Starting with the title',
      })
    )['id'],
  )
  const body = shell.locator(sel(`canvas-proto-${id}`))
  const label = shell.locator(sel(`canvas-gen-label-${id}`))
  await expect(body).toHaveAttribute('data-gen', 'generating', { timeout: 20_000 })
  await expect(label).toHaveText('Generating: Session badges • Badges page')
  await expect(body.frameLocator('iframe').getByText('Session badges')).toBeVisible()
  await ok('canvas.zoom', { slug, fit: true })
  await shell.waitForTimeout(1_200)
  for (const [i, section] of SECTIONS.entries()) {
    await ok('canvas.edit', {
      slug,
      node: id,
      edits: [{ find: MORE, replace: `${section}\n  ${MORE}` }],
      caption: `Writing section ${i + 1}`,
    })
    await expect(body).toHaveAttribute('data-phase', 'live', { timeout: 3_000 })
    await expect(body).toHaveAttribute('data-gen', 'generating')
    if (i === 1) mark('generating')
    await shell.waitForTimeout(1_500)
  }

  // 3. A broken edit: error, in the danger color, over the last good render; the fix generates again.
  await ok('canvas.edit', {
    slug,
    node: id,
    edits: [{ find: '</SimpleGrid>', replace: '' }],
    caption: 'Trying a looser grid',
  })
  await expect(body).toHaveAttribute('data-gen', 'error', { timeout: 3_000 })
  await expect(label).toHaveText('Did not draw: Session badges • Badges page')
  await expect(shell.locator(sel(`canvas-proto-error-${id}`))).toContainText(
    'Showing the last good render',
  )
  mark('error')
  await shell.waitForTimeout(2_500)
  await ok('canvas.edit', {
    slug,
    node: id,
    edits: [{ find: 'retry</Text></Paper>', replace: 'retry</Text></Paper>\n  </SimpleGrid>' }],
    caption: 'Closing the grid',
  })
  await expect(body).toHaveAttribute('data-gen', 'generating', { timeout: 3_000 })

  // 4. A card into the frame: the frame's content arrives, so it is generating too.
  await ok('canvas.add', {
    slug,
    type: 'note',
    title: 'States',
    body: 'Running, done, failed',
    parent: frame,
    caption: 'Filling the frame',
  })
  await expect(frameLabel).toHaveAttribute('data-gen', 'generating', { timeout: 3_000 })
  await expect(cursor).toHaveAttribute('data-making', 'false')
  mark('generating-both')
  await shell.waitForTimeout(2_000)

  // 5. canvas.done: the labels go plain, the light fades; a few seconds later both are idle.
  await ok('canvas.zoom', { slug, fit: true })
  await shell.waitForTimeout(800)
  await ok('canvas.done', { slug, summary: 'Badges page drafted' })
  await expect(label).toHaveAttribute('data-gen', 'done', { timeout: 3_000 })
  await expect(label).toHaveText('Session badges • Badges page')
  await expect(frameLabel).toHaveAttribute('data-gen', 'done')
  mark('done')
  await expect(body).toHaveAttribute('data-gen', 'idle', { timeout: 8_000 })
  await expect(label).toHaveCount(0)
  await expect(frameLabel).toHaveCount(0)
  mark('idle')
  await shell.waitForTimeout(1_000)

  if (stop) {
    const frames = await stop()
    encode(frames, marks, crop)
  }
})

/** Screencast frames (CDP) into `dir`, named by their timestamps; resolves a stopper. */
async function record(shell: Page, dir: string): Promise<() => Promise<string[]>> {
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

/** The frames cropped by `crop` as an mp4 at their real timing, and a still per state (0.8 s in). */
function encode(frames: string[], marks: Record<string, number>, crop: string): void {
  const at = (f: string): number => Number(path.basename(f, '.jpg'))
  const sorted = [...frames].sort((a, b) => at(a) - at(b))
  const list = sorted
    .map((f, i) => {
      const next = sorted[i + 1]
      const dur = next ? Math.max(0.01, at(next) - at(f)) : 0.5
      return `file '${f}'\nduration ${dur.toFixed(3)}`
    })
    .join('\n')
  const listFile = path.join(PROOF, 'frames.txt')
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
    path.join(PROOF, 'gen-states.mp4'),
  ])
  const stills: Record<string, string> = {}
  for (const [i, name] of ['creating', 'generating', 'error', 'done'].entries()) {
    const t = marks[name]! + 0.8
    const still = sorted.reduce((best, f) =>
      Math.abs(at(f) - t) < Math.abs(at(best) - t) ? f : best,
    )
    const out = path.join(PROOF, `${i + 1}-${name}.png`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', still, '-vf', crop, out])
    stills[name] = out
  }
  fs.writeFileSync(path.join(PROOF, 'marks.json'), JSON.stringify({ marks, stills }, null, 2))
  fs.rmSync(path.join(PROOF, 'frames'), { recursive: true, force: true })
  fs.rmSync(listFile)
}
