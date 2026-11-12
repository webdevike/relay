import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { APP_DIR, EVA_FIXTURE_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// canvas.layout (ELK) on the Cook design-workflow board: the same board as notes at guessed
// positions (before) and as steps in two lanes with explainers and loop-backs, no coordinates
// (after). The board file with no positions lays itself out on load; after Nova scrambles three
// cards, canvas.layout puts it right: no two cards overlap, every link is drawn orthogonally and
// never through another card, and one undo restores the scramble. Also canvas.align, canvas.distribute
// and the graph-relation defaults of canvas.add. Windows stay hidden (EVAOS_E2E); proof frames go
// to test-results/proof/canvas-layout (EVAOS_PROOF=1: proof/canvas-layout).

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
          message: { role: 'user', content: 'Lay the Cook board out' },
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
type FileNode = {
  id: string
  type: string
  x?: number
  y?: number
  w?: number
  h?: number
  parent?: string
  pinned?: boolean
}
type FileEdge = {
  id: string
  source: string
  target: string
  tone?: string
  sourceHandle?: string
  targetHandle?: string
  route?: Array<{ x: number; y: number }>
}

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

interface Rect {
  id: string
  l: number
  t: number
  r: number
  b: number
}

/** Every drawn card's screen rect, from the DOM (what Isaac sees). */
async function cardRects(board: Locator): Promise<Rect[]> {
  return board.locator('.react-flow__node').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.getAttribute('data-id')!, l: r.left, t: r.top, r: r.right, b: r.bottom }
    }),
  )
}

const overlap = (a: Rect, b: Rect, pad = 0): boolean =>
  a.l < b.r - pad && b.l < a.r - pad && a.t < b.b - pad && b.t < a.b - pad

/**
 * Edges drawn through a card that is not their own end: every drawn edge path is sampled every
 * 3px (in screen space) and tested against every other card (frames and lanes excluded: a link
 * may run inside the lane it belongs to).
 */
async function crossings(
  board: Locator,
  skip: ReadonlySet<string>,
): Promise<Array<{ edge: string; card: string }>> {
  return board.evaluate(
    (root, skipIds) => {
      const skipSet = new Set(skipIds)
      const cards = [...root.querySelectorAll('.react-flow__node')]
        .filter((el) => !skipSet.has(el.getAttribute('data-id')!))
        .map((el) => ({ id: el.getAttribute('data-id')!, r: el.getBoundingClientRect() }))
      const hits: Array<{ edge: string; card: string }> = []
      for (const g of root.querySelectorAll('.react-flow__edge')) {
        const id = g.getAttribute('data-id') ?? ''
        const [from, to] =
          (g.getAttribute('aria-label') ?? '').match(/from (\S+) to (\S+)/)?.slice(1) ?? []
        const path = g.querySelector<SVGPathElement>('path.react-flow__edge-path')
        if (!path) continue
        const m = path.getScreenCTM()!
        const len = path.getTotalLength()
        for (let d = 0; d <= len; d += 3) {
          const p = path.getPointAtLength(d)
          const x = p.x * m.a + p.y * m.c + m.e
          const y = p.x * m.b + p.y * m.d + m.f
          for (const c of cards) {
            if (c.id === from || c.id === to) continue
            if (x > c.r.left + 2 && x < c.r.right - 2 && y > c.r.top + 2 && y < c.r.bottom - 2) {
              if (!hits.some((h) => h.edge === id && h.card === c.id))
                hits.push({ edge: id, card: c.id })
            }
          }
        }
      }
      return hits
    },
    [...skip],
  )
}

test('canvas.layout lays the Cook board out: no overlaps, clear links, one undo', async ({
  app,
  shell,
  configDir,
}) => {
  test.setTimeout(240_000)
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
  const boardPath = (slug: string): string => path.join(configDir, 'canvases', `${slug}.json`)
  const boardFile = (slug: string): { nodes: FileNode[]; edges: FileEdge[] } =>
    JSON.parse(fs.readFileSync(boardPath(slug), 'utf8'))
  const boards = path.join(APP_DIR, 'e2e/fixtures/boards')
  fs.mkdirSync(path.join(configDir, 'canvases'), { recursive: true })
  for (const [slug, src] of [
    ['cook-before', 'design-workflow-cook-before.json'],
    ['cook-after', 'design-workflow-cook-after.json'],
  ] as const) {
    fs.copyFileSync(path.join(boards, src), boardPath(slug))
  }
  // Proof frames: the board's pane maximized over the chat so the cards read at full size.
  const shot = async (name: string, slug: string, node?: string): Promise<string> => {
    await run('pane.zoom', { on: true })
    await shell.waitForTimeout(500)
    await ok('canvas.zoom', node ? { slug, node, zoom: 0.8 } : { slug, fit: true })
    await shell.waitForTimeout(900)
    const file = await proofShot(app, shell, name, { phase: 'canvas-layout' })
    await run('pane.zoom', { on: false })
    return file
  }

  await size(app, shell, 2400, 1300)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agent:nova'))
  await expect(shell.locator(sel('chat-log'))).toContainText('Cook board', { timeout: 15_000 })

  // BEFORE: the old board, notes at hand-guessed spots.
  await ok('canvas.open', { slug: 'cook-before', caption: 'Opening the old Cook board' })
  const before = shell.locator(`${sel('canvas-board')}[data-slug="cook-before"]`)
  await expect(before.locator('.react-flow__node')).toHaveCount(16)
  await ok('canvas.zoom', { slug: 'cook-before', fit: true })
  await shell.waitForTimeout(900)
  await shot('cook-before', 'cook-before')

  // AFTER, part 1: a board file with no positions lays itself out on load.
  await ok('canvas.open', { slug: 'cook-after', caption: 'Opening the rebuilt Cook board' })
  const board = shell.locator(`${sel('canvas-board')}[data-slug="cook-after"]`)
  await expect(board.locator('.react-flow__node')).toHaveCount(18)
  await expect
    .poll(() => boardFile('cook-after').nodes.every((n) => n.x !== undefined), { timeout: 20_000 })
    .toBe(true)
  await ok('canvas.zoom', { slug: 'cook-after', fit: true })
  await shell.waitForTimeout(900)
  const lanes = new Set(
    boardFile('cook-after')
      .nodes.filter((n) => n.type === 'frame')
      .map((n) => n.id),
  )
  const flat = async (): Promise<Rect[]> => (await cardRects(board)).filter((r) => !lanes.has(r.id))
  const noOverlaps = async (): Promise<void> => {
    const cards = await flat()
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++)
        expect(overlap(cards[i]!, cards[j]!), `${cards[i]!.id} overlaps ${cards[j]!.id}`).toBe(
          false,
        )
  }
  await noOverlaps()
  expect(await crossings(board, lanes)).toEqual([])
  await shot('cook-after-load', 'cook-after')

  // AFTER, part 2: Nova scrambles three cards onto each other, then canvas.layout fixes them.
  const rows = (): Map<string, { x: number; y: number }> =>
    new Map(boardFile('cook-after').nodes.map((n) => [n.id, { x: n.x!, y: n.y! }]))
  const tidy = rows()
  await ok('canvas.move', {
    slug: 'cook-after',
    node: 'judge',
    x: tidy.get('build')!.x + 20,
    y: tidy.get('build')!.y + 10,
  })
  await ok('canvas.move', {
    slug: 'cook-after',
    node: 'gate',
    x: tidy.get('build')!.x + 40,
    y: tidy.get('build')!.y + 20,
  })
  await ok('canvas.move', {
    slug: 'cook-after',
    node: 'pace',
    x: tidy.get('refs')!.x + 10,
    y: tidy.get('refs')!.y + 10,
  })
  const scrambled = rows()
  await ok('canvas.zoom', { slug: 'cook-after', fit: true })
  await shell.waitForTimeout(700)
  await shot('cook-scrambled', 'cook-after')
  const t0 = Date.now()
  const laid = (await ok('canvas.layout', {
    slug: 'cook-after',
    algorithm: 'layered',
    direction: 'right',
    caption: 'Laying the Cook board out',
  })) as { moved: number; kept: unknown[]; algorithm: string; routed: number }
  expect(Date.now() - t0).toBeGreaterThan(400) // the cards glide, not jump
  expect(laid).toMatchObject({ algorithm: 'layered' })
  expect(laid.moved).toBeGreaterThanOrEqual(3)
  // The layout is deterministic: the scrambled cards go back to where the load put them.
  for (const id of ['judge', 'gate', 'pace']) {
    const now = rows().get(id)!
    expect(Math.abs(now.x - tidy.get(id)!.x), `${id} x`).toBeLessThanOrEqual(1)
    expect(Math.abs(now.y - tidy.get(id)!.y), `${id} y`).toBeLessThanOrEqual(1)
  }
  await ok('canvas.zoom', { slug: 'cook-after', fit: true })
  await shell.waitForTimeout(900)
  await noOverlaps()
  expect(await crossings(board, lanes)).toEqual([])
  const file2 = boardFile('cook-after')
  // Lanes stack as rows of equal width; every step sits inside its lane.
  const at = new Map(file2.nodes.map((n) => [n.id, n]))
  const setup = at.get('lane-setup')!
  const loop = at.get('lane-loop')!
  expect(loop.y!).toBeGreaterThan(setup.y! + setup.h!)
  expect(Math.abs(setup.w! - loop.w!)).toBeLessThanOrEqual(1)
  for (const n of file2.nodes.filter((n) => n.parent)) {
    const lane = at.get(n.parent!)!
    expect(n.x!, n.id).toBeGreaterThanOrEqual(lane.x!)
    expect(n.y!, n.id).toBeGreaterThanOrEqual(lane.y!)
    expect(n.x! + (n.w ?? 300), n.id).toBeLessThanOrEqual(lane.x! + lane.w! + 1)
  }
  // Orthogonal routes stored for every link; the return links are loops; handles from direction.
  for (const e of file2.edges) {
    expect(e.route && e.route.length >= 2, `${e.id} has a route`).toBe(true)
    for (let i = 1; i < e.route!.length; i++) {
      const [a, b] = [e.route![i - 1]!, e.route![i]!]
      expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `${e.id} is orthogonal`).toBe(
        true,
      )
    }
  }
  expect(file2.edges.find((e) => e.id === 'fix-judge')!.tone).toBe('loop')
  expect(file2.edges.find((e) => e.id === 'gate-fix')!.tone).toBe('loop')
  expect(file2.edges.find((e) => e.id === 'refs-intake')).toMatchObject({
    sourceHandle: 'right',
    targetHandle: 'left',
  })
  await shot('cook-after', 'cook-after')
  await shot('cook-after-setup', 'cook-after', 'lane-setup')
  await shot('cook-after-loop', 'cook-after', 'lane-loop')
  await board.locator('.react-flow__node').first().waitFor()

  // One undo step puts all three scrambled cards back.
  await shell.locator(sel('canvas-undo')).click()
  await expect
    .poll(
      () => {
        const now = rows()
        return ['judge', 'gate', 'pace'].every(
          (id) =>
            Math.abs(now.get(id)!.x - scrambled.get(id)!.x) < 1.5 &&
            Math.abs(now.get(id)!.y - scrambled.get(id)!.y) < 1.5,
        )
      },
      { timeout: 10_000 },
    )
    .toBe(true)
})

test('canvas.align, canvas.distribute and canvas.add without coordinates', async ({
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
  const boardFile = (): { nodes: FileNode[]; edges: FileEdge[] } =>
    JSON.parse(fs.readFileSync(path.join(configDir, 'canvases', 'tidy.json'), 'utf8'))
  fs.mkdirSync(path.join(configDir, 'canvases'), { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'canvases', 'tidy.json'),
    JSON.stringify({ version: 1, title: 'Tidy up', nodes: [], edges: [] }),
  )
  await size(app, shell, 1500, 900)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agent:nova'))
  await expect(shell.locator(sel('chat-log'))).toContainText('Cook board', { timeout: 15_000 })
  await ok('canvas.open', { slug: 'tidy', caption: 'Tidying up' })
  const board = shell.locator(`${sel('canvas-board')}[data-slug="tidy"]`)
  await expect(board).toBeVisible()

  // No coordinates: the first card lands, the next ones follow by the graph.
  const a = (await ok('canvas.add', {
    slug: 'tidy',
    type: 'step',
    title: 'Plan',
    data: { step: '1' },
  })) as { id: string }
  const b = (await ok('canvas.add', {
    slug: 'tidy',
    type: 'step',
    title: 'Build',
    from: a.id,
    label: 'go',
    data: { step: '2' },
  })) as { id: string }
  const c = (await ok('canvas.add', {
    slug: 'tidy',
    type: 'step',
    title: 'Ship',
    from: b.id,
    data: { step: '3' },
  })) as { id: string }
  const d = (await ok('canvas.add', {
    slug: 'tidy',
    type: 'explainer',
    title: 'Why',
    body: '- one\n- two',
    near: b.id,
  })) as { id: string }
  const f = boardFile()
  expect(f.edges.map((e) => `${e.source}>${e.target}`)).toEqual([
    `${a.id}>${b.id}`,
    `${b.id}>${c.id}`,
  ])
  const pos = (id: string): FileNode => f.nodes.find((n) => n.id === id)!
  expect(pos(b.id).x!).toBeGreaterThan(pos(a.id).x!)
  expect(pos(b.id).y).toBe(pos(a.id).y)
  expect(pos(c.id).x!).toBeGreaterThan(pos(b.id).x!)
  // No two cards overlap, by the boxes as drawn.
  const read = (await ok('canvas.read', { slug: 'tidy' })) as {
    nodes: Array<{ id: string; x: number; y: number; w: number; h: number }>
  }
  for (let i = 0; i < read.nodes.length; i++)
    for (let j = i + 1; j < read.nodes.length; j++) {
      const [p, q] = [read.nodes[i]!, read.nodes[j]!]
      expect(
        p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h,
        `${p.id} overlaps ${q.id}`,
      ).toBe(false)
    }
  void d

  // Align the three steps on their tops after bumping one; distribute them evenly.
  await ok('canvas.move', { slug: 'tidy', node: b.id, x: pos(b.id).x!, y: pos(b.id).y! + 70 })
  await ok('canvas.align', { slug: 'tidy', nodes: [a.id, b.id, c.id], to: 'top' })
  const g = boardFile()
  const tops = [a.id, b.id, c.id].map((id) => g.nodes.find((n) => n.id === id)!.y)
  expect(new Set(tops).size).toBe(1)
  await ok('canvas.move', { slug: 'tidy', node: b.id, x: pos(b.id).x! + 90, y: tops[0]! })
  await ok('canvas.distribute', { slug: 'tidy', nodes: [a.id, b.id, c.id], axis: 'horizontal' })
  const h = boardFile()
  const [xa, xb, xc] = [a.id, b.id, c.id].map((id) => h.nodes.find((n) => n.id === id)!)
  const gapAB = xb!.x! - (xa!.x! + (xa!.w ?? 300))
  const gapBC = xc!.x! - (xb!.x! + (xb!.w ?? 300))
  expect(Math.abs(gapAB - gapBC)).toBeLessThanOrEqual(1.5)
})

test('relay-today rebuilt with steps and an explainer lays out clean', async ({
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
  const boards = path.join(APP_DIR, 'e2e/fixtures/boards')
  fs.mkdirSync(path.join(configDir, 'canvases'), { recursive: true })
  for (const [slug, src] of [
    ['today-before', 'relay-today-before.json'],
    ['today-after', 'relay-today-after.json'],
  ] as const) {
    fs.copyFileSync(path.join(boards, src), path.join(configDir, 'canvases', `${slug}.json`))
  }
  await size(app, shell, 2400, 1300)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agent:nova'))
  await expect(shell.locator(sel('chat-log'))).toContainText('Cook board', { timeout: 15_000 })
  const shot = async (name: string, slug: string): Promise<void> => {
    await run('pane.zoom', { on: true })
    await shell.waitForTimeout(500)
    await run('canvas.zoom', { slug, fit: true })
    await shell.waitForTimeout(900)
    await proofShot(app, shell, name, { phase: 'canvas-layout' })
    await run('pane.zoom', { on: false })
  }
  await run('canvas.open', { slug: 'today-before' })
  await expect(
    shell.locator(`${sel('canvas-board')}[data-slug="today-before"] .react-flow__node`),
  ).toHaveCount(9)
  await shot('today-before', 'today-before')
  await run('canvas.open', { slug: 'today-after' })
  const board = shell.locator(`${sel('canvas-board')}[data-slug="today-after"]`)
  await expect(board.locator('.react-flow__node')).toHaveCount(10)
  const laid = await run('canvas.layout', { slug: 'today-after', caption: 'Laying out today' })
  expect(laid.ok, laid.message).toBe(true)
  const lane = new Set(['lane'])
  const cards = (await cardRects(board)).filter((r) => !lane.has(r.id))
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      expect(overlap(cards[i]!, cards[j]!), `${cards[i]!.id} / ${cards[j]!.id}`).toBe(false)
  expect(await crossings(board, lane)).toEqual([])
  await shot('today-after', 'today-after')
})
