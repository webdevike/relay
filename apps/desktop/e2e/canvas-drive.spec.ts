import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { APP_DIR, EVA_FIXTURE_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// The chat drives a board: Nova's thread asks for the board (canvas.open), it opens beside her
// chat with her ring, caption row and a work card in the chat, and her cursor travels to each
// change before it lands in the board file (canvas.add, canvas.connect). Isaac's comment on a card
// goes into Nova's thread as his message; her reply shows under it. His Take over pauses her.
// Frames of the window are captured while she works; EVAOS_CANVAS_FRAMES=<dir> keeps them for a
// clip (default test-results/canvas-drive).

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
      path.join(fx.sessionsDir, '2026-11-05T09-00-00-000Z_nova-1.jsonl'),
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
          message: { role: 'user', content: 'Can we plan Q4 on the canvas?' },
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

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

type Answer = { ok: boolean; value?: Record<string, unknown>; code?: string; message?: string }

test('the chat drives a board with its cursor; comments come back to the chat', async ({
  app,
  shell,
  configDir,
}) => {
  test.setTimeout(120_000)
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  const run = async (action: string, params: Record<string, unknown>): Promise<Answer> => {
    const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params, scope: 'agent:nova' }),
    })
    return (await res.json()) as Answer
  }
  const ok = async (action: string, params: Record<string, unknown>) => {
    const r = await run(action, params)
    expect(r.ok, `${action}: ${r.code} ${r.message}`).toBe(true)
    return r.value!
  }
  const boardFile = (): {
    nodes: Array<{ id: string; x?: number; y?: number; data?: { title?: string } }>
    edges: Array<{ id: string; source: string; target: string; label?: string }>
    threads?: Array<{ id: string; messages: Array<{ kind: string; name: string; text: string }> }>
  } => JSON.parse(fs.readFileSync(path.join(configDir, 'canvases', 'mind-map.json'), 'utf8'))

  await size(app, shell, 1500, 920)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agent:nova'))
  await expect(shell.locator(sel('chat-log'))).toContainText('plan Q4', { timeout: 15_000 })

  // Frames of the window while Nova works (the shell draws the board; no native views here).
  const frames: Array<{ t: number; png: Buffer }> = []
  let capturing = true
  const t0 = Date.now()
  const capture = (async () => {
    while (capturing && Date.now() - t0 < 60_000) {
      frames.push({ t: Date.now() - t0, png: await shell.screenshot() })
    }
  })()
  const marks: Record<string, number> = {}

  // 1. Nova opens the board beside her chat: ring, caption row, work card.
  const opened = await ok('canvas.open', { slug: 'mind-map', caption: 'Planning Q4 with Isaac' })
  expect(opened).toMatchObject({ slug: 'mind-map', title: 'Q4 roadmap', mounted: true })
  const board = shell.locator(`${sel('canvas-board')}[data-slug="mind-map"]`)
  await expect(board).toBeVisible()
  await expect(shell.locator(sel('chat-log'))).toBeVisible()
  const frame = shell.locator(sel('canvas-agent-frame'))
  await expect(frame).toHaveAttribute('data-agent', 'working')
  await expect(frame.locator(sel('agent-caption'))).toContainText('Planning Q4 with Isaac')
  const card = shell.locator(sel('agent-work-canvas-mind-map'))
  await expect(card).toBeVisible()
  await expect(card).toContainText('Q4 roadmap')

  // 2. Two cards, each placed under the cursor; the second right of the first.
  const before = boardFile().nodes.length
  marks.addStart = Date.now() - t0
  const research = (await ok('canvas.add', {
    slug: 'mind-map',
    title: 'Research',
    body: 'Talk to five customers',
    x: 0,
    y: 900,
    caption: 'Adding the research step',
  })) as { id: string; x: number; y: number }
  const cursor = shell.locator(sel('canvas-agent-cursor'))
  await expect(cursor).toHaveAttribute('data-state', 'shown')
  const build = (await ok('canvas.add', {
    slug: 'mind-map',
    title: 'Build',
    body: 'Ship the beta',
    near: research.id,
    caption: 'Adding the build step',
  })) as { id: string; x: number; y: number }
  expect(build.x).toBeGreaterThan(research.x)
  await expect(board.locator(`.react-flow__node[data-id="${build.id}"]`)).toBeVisible()
  expect(boardFile().nodes.length).toBe(before + 2)
  await expect(frame.locator(sel('agent-caption'))).toContainText('Adding the build step')

  // 3. The link: the cursor runs from one card to the other, then the edge is in the file.
  const edgesBefore = await board.locator('.react-flow__edge').count()
  marks.connectStart = Date.now() - t0
  const link = (await ok('canvas.connect', {
    slug: 'mind-map',
    from: research.id,
    to: build.id,
    label: 'then',
    caption: 'Linking research to build',
  })) as { id: string; existed: boolean }
  marks.connectEnd = Date.now() - t0
  expect(link).toEqual({ id: `${research.id}-${build.id}`, existed: false })
  await expect(cursor).toHaveAttribute('data-aim', build.id)
  expect(boardFile().edges.find((e) => e.id === link.id)).toMatchObject({ label: 'then' })
  await expect(board.locator('.react-flow__edge')).toHaveCount(edgesBefore + 1)
  // The connect waited for the cursor's two glides (route lead + travel each), not instant.
  expect(marks.connectEnd! - marks.connectStart!).toBeGreaterThan(500)
  await proofShot(app, shell, 'canvas-drive-linked', { phase: 'canvas-drive' })

  // 4. canvas.read lists the new cards with their drawn boxes and the link.
  const read = (await ok('canvas.read', { slug: 'mind-map' })) as {
    nodes: Array<{ id: string; title?: string; w?: number }>
    edges: Array<{ id: string }>
  }
  expect(read.nodes.find((n) => n.id === build.id)).toMatchObject({ title: 'Build' })
  expect(read.nodes.find((n) => n.id === build.id)!.w).toBeGreaterThan(0)
  expect(read.edges.map((e) => e.id)).toContain(link.id)

  // 5. Isaac comments on the Build card: it goes into Nova's thread as his message.
  await board.locator(`.react-flow__node[data-id="${build.id}"]`).click()
  // His click on the board is his edit: Nova's run pauses.
  await expect(frame).toHaveAttribute('data-agent', /working|paused/)
  await shell.keyboard.press('/')
  const draft = shell.locator(`${sel('canvas-thread')}[data-thread=draft]`)
  await expect(draft).toBeVisible()
  await draft.locator(sel('canvas-thread-new-input')).fill('Can the beta ship in October?')
  await shell.keyboard.press('Enter')
  await expect(shell.locator(sel('canvas-thread-note'))).toContainText('Sent to Nova')
  const turn = host.commands.find(
    (c) => c.cmd.kind === 'assistant.turn' && String(c.cmd.text).includes('ship in October'),
  )
  expect(turn?.cmd).toMatchObject({ agent: 'nova' })
  expect(String(turn!.cmd.text)).toContain(`card "Build" (${build.id})`)
  expect(String(turn!.cmd.text)).toContain(`relay://open/canvas?canvas=mind-map&node=${build.id}`)
  const thread = boardFile().threads!.at(-1)!
  await proofShot(app, shell, 'canvas-drive-comment', { phase: 'canvas-drive' })
  await shell.keyboard.press('Escape')

  // 6. Take over pauses Nova; her actions are refused until Hand back.
  if ((await frame.getAttribute('data-agent')) !== 'paused') {
    await frame.locator(sel('agent-take-over')).click()
  }
  await expect(frame).toHaveAttribute('data-agent', 'paused')
  const refused = await run('canvas.add', { slug: 'mind-map', title: 'Not now' })
  expect(refused).toMatchObject({ ok: false, code: 'paused-by-isaac' })
  expect(boardFile().nodes.some((n) => n.data?.title === 'Not now')).toBe(false)
  await frame.locator(sel('agent-hand-back')).click()
  await expect(frame).toHaveAttribute('data-agent', 'working')

  // 7. Her reply shows under his comment, as her.
  await ok('canvas.reply', {
    slug: 'mind-map',
    thread: thread.id,
    text: 'Yes, if research ends by mid September.',
  })
  await expect
    .poll(() =>
      boardFile()
        .threads!.find((t) => t.id === thread.id)!
        .messages.at(-1),
    )
    .toMatchObject({ kind: 'agent', name: 'Nova' })

  // 7a. A long carry stays readable and in view: the board pans with the card instead of zooming
  // out to fit the whole path, and the card lands where the file says.
  const buildCard = board.locator(`.react-flow__node[data-id="${build.id}"]`)
  const spot = (): Promise<string> =>
    buildCard.evaluate((el) => (el as HTMLElement).style.transform)
  const zoom = (): Promise<number> =>
    board
      .locator('.react-flow__viewport')
      .evaluate((el) => Number(/scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)![1]))
  /** The least share of the card inside the board, frame by frame for `ms` (1 = always whole). */
  const shownWhile = (ms: number): Promise<number> =>
    buildCard.evaluate(
      (el, ms) =>
        new Promise<number>((resolve) => {
          const wrap = el.closest('.react-flow')!.getBoundingClientRect()
          let least = 1
          const t0 = performance.now()
          const tick = (): void => {
            const r = el.getBoundingClientRect()
            const w = Math.max(0, Math.min(r.right, wrap.right) - Math.max(r.left, wrap.left))
            const h = Math.max(0, Math.min(r.bottom, wrap.bottom) - Math.max(r.top, wrap.top))
            least = Math.min(least, (w * h) / (r.width * r.height))
            if (performance.now() - t0 < ms) requestAnimationFrame(tick)
            else resolve(least)
          }
          tick()
        }),
      ms,
    )
  const kept = boardFile().nodes.find((n) => n.id === build.id)!
  const far = { x: kept.x! + 600, y: kept.y! + 400 }
  let home = await spot()
  const watched = shownWhile(2_500)
  const carried = ok('canvas.move', {
    slug: 'mind-map',
    node: build.id,
    ...far,
    caption: 'Moving build',
  })
  await expect.poll(spot, { intervals: [16], timeout: 10_000 }).not.toBe(home)
  expect(await zoom()).toBeGreaterThanOrEqual(0.99)
  expect(await carried).toMatchObject({ id: build.id, ...far })
  expect(boardFile().nodes.find((n) => n.id === build.id)).toMatchObject(far)
  expect(await zoom()).toBeGreaterThanOrEqual(0.99)
  expect(await watched).toBeGreaterThan(0.95)
  // A Take over right after the move lands leaves the card where the file has it.
  const landedAt = await spot()
  await frame.locator(sel('agent-take-over')).click()
  await expect(frame).toHaveAttribute('data-agent', 'paused')
  await shell.waitForTimeout(400)
  expect(await spot()).toBe(landedAt)
  expect(boardFile().nodes.find((n) => n.id === build.id)).toMatchObject(far)
  await frame.locator(sel('agent-hand-back')).click()
  await expect(frame).toHaveAttribute('data-agent', 'working')

  // 7b. Take over mid-carry: the card goes back to its spot, the board back to where the carry
  // began (the card in view), and the file keeps it where it was.
  // He presses Take over a few frames into the carry (watched in the page: the window's frame
  // capture makes round trips from here too slow to land mid-carry reliably).
  const pressed = buildCard.evaluate(
    (el, button) =>
      new Promise<void>((resolve) => {
        const start = (el as HTMLElement).style.transform
        let frames = -1
        const tick = (): void => {
          if (frames < 0 && (el as HTMLElement).style.transform !== start) frames = 0
          if (frames >= 0 && ++frames > 8) {
            ;(document.querySelector(button) as HTMLElement).click()
            resolve()
          } else requestAnimationFrame(tick)
        }
        tick()
      }),
    `${sel('canvas-agent-frame')} ${sel('agent-take-over')}`,
  )
  home = await spot()
  const moving = run('canvas.move', {
    slug: 'mind-map',
    node: build.id,
    x: kept.x!,
    y: kept.y!,
    caption: 'Moving build back',
  })
  await pressed
  expect(await moving).toMatchObject({ ok: false, code: 'paused-by-isaac' })
  expect(boardFile().nodes.find((n) => n.id === build.id)).toMatchObject(far)
  await expect.poll(spot).toBe(home)
  await shell.waitForTimeout(500)
  expect(await shownWhile(50)).toBeGreaterThan(0.95)
  await frame.locator(sel('agent-hand-back')).click()
  await expect(frame).toHaveAttribute('data-agent', 'working')

  // 8. Done: the caption becomes the summary.
  await ok('canvas.done', { slug: 'mind-map', summary: 'Added research and build, linked' })
  await expect(frame.locator(sel('agent-caption'))).toContainText('Added research and build')
  await proofShot(app, shell, 'canvas-drive-done', { phase: 'canvas-drive' })

  capturing = false
  await capture
  expect(frames.length).toBeGreaterThan(20)
  // Frames during the link: the cursor was on screen while it travelled.
  const during = frames.filter((f) => f.t >= marks.connectStart! && f.t <= marks.connectEnd!)
  expect(during.length).toBeGreaterThan(3)
  const dir = process.env.EVAOS_CANVAS_FRAMES ?? path.join(APP_DIR, 'test-results/canvas-drive')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  frames.forEach((f, i) =>
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), f.png),
  )
  fs.writeFileSync(
    path.join(dir, 'frames.json'),
    JSON.stringify({ marks, frames: frames.map((f) => f.t) }),
  )
})
