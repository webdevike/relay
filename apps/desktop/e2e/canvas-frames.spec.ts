import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { FRAME_PRESETS, type FramePreset } from '@relay/widget-runtime/systems'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { blit } from './helpers/image'
import { APP_DIR, EVA_FIXTURE_ROOT } from './helpers/paths'

// Component cards are frames (artboards) of real Relay surfaces. This spec measures every surface
// in the running app against FRAME_PRESETS, then designs the Assistants grid (Isaac's five real
// assistants, their registry portraits) in a `page` frame and the kit's session badge strip in a
// `chips` frame, and checks each lands within 2px of the page the app ships and of the strip's
// preset band (the app's composer shows runs as cards now, so no strip ships to measure).
// Side-by-side screenshots go to EVAOS_FRAMES_PROOF (default test-results/canvas-frames).

let fx: ChatFixture
let host: FakeRelayHost
const REGISTRY = path.join(__dirname, 'fixtures/assistants/agents.json')

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.copyFileSync(REGISTRY, path.join(evaRoot, '.omp/assistant/agents.json'))
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({
      ...fx.launchEnv,
      FAKE_OMP_DELAY_MS: '5',
      EVAOS_EVA_ROOT: evaRoot,
      EVAOS_RELAY_DIR: relayDir,
      EVAOS_AGENT_CONTROL: '1',
    })
    await host.close()
    fx.cleanup()
  },
})
test.use({ toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Shell = {
  __evaosShell: {
    openPlace(page: string, newTab?: boolean, extra?: { settingsSection: string }): void
    setPanel(open: boolean): void
  }
}
type Answer = { ok: boolean; value?: Record<string, unknown>; code?: string; message?: string }
type Box = { x: number; y: number; w: number; h: number }

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
  await shell.waitForTimeout(400)
}

/** Proof shots leave out Nova's cursor and its trail, which park over the card she just touched. */
const NO_CURSOR = '.eva-cv-agent-cursor { display: none !important; }'

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox()
  if (!b) throw new Error('not drawn')
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

const place = (shell: Page, page: string) =>
  shell.evaluate((p) => (window as unknown as Shell).__evaosShell.openPlace(p), page)

/** Two screenshots side by side on a neutral sheet, 24px apart. */
function sideBySide(left: Buffer, right: Buffer, out: string): void {
  const a = PNG.sync.read(left)
  const b = PNG.sync.read(right)
  const sheet = new PNG({
    width: a.width + b.width + 72,
    height: Math.max(a.height, b.height) + 48,
  })
  sheet.data.fill(0x88)
  for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 0xff
  blit(sheet, a, 24, 24)
  blit(sheet, b, a.width + 48, 24)
  fs.writeFileSync(out, PNG.sync.write(sheet))
}

test('component card frames are the real surfaces, and designs in them land where the app ships', async ({
  app,
  shell,
  configDir,
}) => {
  test.setTimeout(180_000)
  const proof = process.env.EVAOS_FRAMES_PROOF ?? path.join(APP_DIR, 'test-results/canvas-frames')
  fs.rmSync(proof, { recursive: true, force: true })
  fs.mkdirSync(proof, { recursive: true })

  // 1. Every surface, measured in the default 1280 x 800 window (widths at their CSS maximum).
  const measured: Partial<Record<FramePreset, { w: number; h: number }>> = {}
  await size(app, shell, 1280, 800)
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[data-testid=chat-tree]')
  for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all())
    await more.click()
  await shell.locator(sel('chat-row-p4-subagents')).click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Hello from p4-subagents')
  measured.window = await shell.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  const sidebar = await box(shell.locator('.eva-sidebar'))
  measured.sidebar = { w: sidebar.w, h: sidebar.h }
  const chatPane = await box(shell.locator(sel('chat-pane')))
  const chatHead = await box(shell.locator('[data-testid=chat-pane] .eva-chat-header'))
  const column = await box(shell.locator('[data-testid=chat-pane] .eva-row-inner').first())
  measured.chat = { w: column.w, h: chatPane.y + chatPane.h - (chatHead.y + chatHead.h) }
  // The Add tab menu.
  await shell.locator(sel('tab-new')).first().click()
  const menu = await box(shell.locator('.eva-add-menu'))
  measured.menu = { w: menu.w, h: menu.h }
  await shell.keyboard.press('Escape')
  await expect(shell.locator('.eva-add-menu')).toHaveCount(0)
  // A tool pane beside the chat at its default share.
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.setPanel(true))
  await shell.waitForSelector('[data-pane-kind=tool]')
  await shell.waitForTimeout(400)
  const tool = await box(shell.locator('[data-pane-kind=tool]'))
  const chatNow = await box(shell.locator(sel('chat-pane')))
  // Its content: inside the card's border, under the tab strip both panes share.
  measured.pane = { w: tool.w - 2, h: chatNow.h }
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.setPanel(false))
  await expect(shell.locator('[data-pane-kind=tool]')).toBeHidden()
  // A page's body under its header, then the page columns at a window wide enough for them.
  await place(shell, 'assistants')
  await expect(shell.locator('.eva-asg-card')).toHaveCount(5)
  const viewport = await box(
    shell
      .locator('[data-testid=assistants-home]')
      .locator('xpath=ancestor::*[contains(@class,"ScrollArea-viewport")][1]'),
  )
  await size(app, shell, 1700, 1000)
  const page = await box(shell.locator(sel('assistants-home')))
  measured.page = { w: page.w, h: viewport.h }
  // Theme is a full-bleed editor; every other section draws in the narrow column.
  await shell.evaluate(() =>
    (window as unknown as Shell).__evaosShell.openPlace('settings', false, {
      settingsSection: 'Chat',
    }),
  )
  const narrow = await box(shell.locator('.eva-settings-col').first())
  measured['page-narrow'] = { w: narrow.w, h: viewport.h }
  fs.writeFileSync(path.join(proof, 'measured.json'), JSON.stringify(measured, null, 2))
  // `phone` is the phone app's screen (iPhone portrait points); this app has none to measure.
  // `chips` is the kit's badge strip; the composer shows runs as cards now (step 4 checks the band).
  for (const [id, m] of Object.entries(measured)) {
    const f = FRAME_PRESETS[id as FramePreset]
    expect(Math.abs(m.w - f.w), `${id} width ${m.w} vs ${f.w}`).toBeLessThanOrEqual(1)
    expect(Math.abs(m.h - f.h), `${id} height ${m.h} vs ${f.h}`).toBeLessThanOrEqual(1)
  }
  expect(Object.keys(measured).sort()).toEqual(
    Object.keys(FRAME_PRESETS)
      .filter((k) => k !== 'phone' && k !== 'chips')
      .sort(),
  )

  // 2. The shipped Assistants page at its full width: five real assistants and their portraits.
  await place(shell, 'assistants')
  const home = shell.locator(sel('assistants-home'))
  await expect(home.locator('.eva-asg-card')).toHaveCount(5)
  await shell.waitForTimeout(500)
  const shipped = await home.evaluate((col) => {
    const o = col.getBoundingClientRect()
    return {
      title: col.querySelector('.eva-as-title')!.textContent!,
      description: col.querySelector('.eva-as-dim')!.textContent!,
      cards: [...col.querySelectorAll('.eva-asg-card')].map((c) => {
        const r = c.getBoundingClientRect()
        return {
          name: c.querySelector('.eva-asg-name')!.textContent!,
          status: c.getAttribute('data-status')!,
          src: c.querySelector('img')!.getAttribute('src')!,
          box: { x: r.x - o.x, y: r.y - o.y, w: r.width, h: r.height },
        }
      }),
    }
  })
  const shippedShot = await home.screenshot()
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as {
    agents: { id: string; title: string }[]
  }
  expect(shipped.cards.map((c) => c.name)).toEqual(registry.agents.map((a) => a.title))

  // 3. Nova designs it on a board, in a `page` frame, from the page's own classes and the kit.
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
      body: JSON.stringify({ params }),
    })
    return (await res.json()) as Answer
  }
  const ok = async (action: string, params: Record<string, unknown>) => {
    const r = await run(action, params)
    expect(r.ok, `${action}: ${r.code} ${r.message}`).toBe(true)
    return r.value!
  }
  const opened = await ok('canvas.open', { title: 'Frames', caption: 'Designing in real frames' })
  const slug = String(opened['slug'])
  const board = shell.locator(`${sel('canvas-board')}[data-slug="${slug}"]`)
  await expect(board).toBeVisible()
  // Room for a 1120px page at 100%: a big window and the board's pane maximized.
  await size(app, shell, 2400, 1300)
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
  const cards = registry.agents
    .map((a, i) => `<AssistantCard agent="${a.id}" status="${shipped.cards[i]!.status}" />`)
    .join('\n      ')
  const grid = `<div className="eva-as-col">
  <div className="eva-as-head">
    <div className="eva-as-head-row">
      <h1 className="eva-as-title">${shipped.title}</h1>
      <Button variant="default" size="xs" leftSection={<TablerIcon name="plus" size={14} />}>New assistant</Button>
    </div>
    <p className="eva-as-dim">${shipped.description}</p>
  </div>
  <div className="eva-asg">
      ${cards}
  </div>
</div>`
  const refused = await run('canvas.add', { slug, type: 'proto', title: 'Assistants', body: grid })
  expect(refused).toMatchObject({ ok: false, code: 'invalid-params' })
  expect(refused.message).toContain('needs data.frame')
  const added = await ok('canvas.add', {
    slug,
    type: 'proto',
    title: 'Assistants',
    body: grid,
    data: { frame: 'page' },
    caption: 'The Assistants grid at the page width',
  })
  expect(added).toMatchObject({ compile: 'ok' })
  const gridId = String(added['id'])
  const gridBody = shell.locator(sel(`canvas-proto-${gridId}`))
  await expect(gridBody).toHaveAttribute('data-phase', 'live', { timeout: 20_000 })
  await expect(gridBody).toHaveAttribute('data-frame', 'page')
  await expect(shell.locator(sel(`canvas-proto-frame-${gridId}`))).toHaveText(
    /Page\s*1120\s*×\s*684/,
  )
  const inGrid = gridBody.frameLocator('iframe')
  await expect(inGrid.locator('.eva-asg-card')).toHaveCount(5)
  await shell.waitForTimeout(500)
  const designed = await inGrid.locator('.eva-as-col').evaluate((col) => {
    const o = col.getBoundingClientRect()
    return {
      col: { w: o.width },
      doc: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
      cards: [...col.querySelectorAll('.eva-asg-card')].map((c) => {
        const r = c.getBoundingClientRect()
        return {
          name: c.querySelector('.eva-asg-name')!.textContent!,
          src: c.querySelector('img')!.getAttribute('src')!,
          box: { x: r.x - o.x, y: r.y - o.y, w: r.width, h: r.height },
        }
      }),
    }
  })
  // The page draws at the frame's real size, 1:1: the column is the shipped one.
  expect(designed.doc).toEqual({ w: 1120, h: 684 })
  expect(designed.col.w).toBe(page.w)
  const deltas = designed.cards.map((c, i) => {
    const s = shipped.cards[i]!
    expect(c.name).toBe(s.name)
    // The registry's real portrait: the very image the shipped card draws.
    expect(c.src).toBe(s.src)
    return Math.max(...(['x', 'y', 'w', 'h'] as const).map((k) => Math.abs(c.box[k] - s.box[k])))
  })
  fs.writeFileSync(
    path.join(proof, 'assistants-grid.json'),
    JSON.stringify(
      {
        shipped: shipped.cards.map((c) => ({ name: c.name, box: c.box })),
        designed: designed.cards.map((c) => ({ name: c.name, box: c.box })),
        maxDeltaPx: deltas,
      },
      null,
      2,
    ),
  )
  for (const d of deltas) expect(d).toBeLessThanOrEqual(2)
  await ok('canvas.zoom', { slug, node: gridId, zoom: 1 })
  await shell.waitForTimeout(600)
  const gridCard = board.locator(`.react-flow__node[data-id="${gridId}"]`)
  await gridCard.screenshot({
    path: path.join(proof, '01-assistants-frame-card.png'),
    style: NO_CURSOR,
  })
  const designedShot = await gridBody.screenshot({ style: NO_CURSOR })
  fs.writeFileSync(path.join(proof, '02-assistants-shipped.png'), shippedShot)
  fs.writeFileSync(path.join(proof, '03-assistants-designed.png'), designedShot)
  sideBySide(shippedShot, designedShot, path.join(proof, '04-assistants-side-by-side.png'))

  // 4. The kit's badge strip in its container (`chips`): the strip lands in the preset's band, the
  // chat column (780 wide) between 20px gutters, 33 tall under a 10px top margin.
  const STRIP = `<ChipStrip end={<button type="button" className="eva-chips-clear eva-label">Clear done</button>}>
  <SessionChip label="b" state="done" />
  <SessionChip label="a" state="done" />
</ChipStrip>`
  const chips = await ok('canvas.add', {
    slug,
    type: 'proto',
    title: 'Badge strip',
    body: STRIP,
    data: { frame: 'chips' },
    near: gridId,
  })
  const chipsId = String(chips['id'])
  const chipsBody = shell.locator(sel(`canvas-proto-${chipsId}`))
  await expect(chipsBody).toHaveAttribute('data-phase', 'live', { timeout: 20_000 })
  const inStrip = chipsBody.frameLocator('iframe')
  await expect(inStrip.locator('.eva-chip')).toHaveCount(2)
  await shell.waitForTimeout(400)
  const stripInFrame = await inStrip.locator('.eva-chips').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  for (const [k, want] of [
    ['x', 20],
    ['y', 10],
    ['w', 780],
    ['h', 33],
  ] as const)
    expect(Math.abs(stripInFrame[k] - want), `strip ${k}`).toBeLessThanOrEqual(1)
  await expect(chipsBody).not.toHaveAttribute('data-overflow', 'true')
  await ok('canvas.zoom', { slug, node: chipsId, zoom: 1 })
  await shell.waitForTimeout(600)
  const chipsCard = board.locator(`.react-flow__node[data-id="${chipsId}"]`)
  await chipsCard.screenshot({
    path: path.join(proof, '05-chips-frame-card.png'),
    style: NO_CURSOR,
  })
  await chipsBody.screenshot({ path: path.join(proof, '06-chips-designed.png'), style: NO_CURSOR })

  // 5. Content taller than its frame is clipped, never stretched, and says by how much.
  await ok('canvas.edit', {
    slug,
    node: chipsId,
    body: `<>\n${STRIP}\n<Text p="md">A second row the strip has no room for</Text>\n</>`,
  })
  await expect(chipsBody).toHaveAttribute('data-overflow', 'true', { timeout: 5_000 })
  await expect(shell.locator(sel(`canvas-proto-overflow-${chipsId}`))).toHaveText(/^\+\d+px below$/)
  expect(await box(chipsBody)).toMatchObject({ w: 822, h: 45 })
  await chipsCard.screenshot({ path: path.join(proof, '09-overflow.png'), style: NO_CURSOR })

  // 6. Isaac resizes the artboard from its header: a preset, then a custom size.
  await shell.locator(sel(`canvas-proto-frame-${chipsId}`)).click()
  await shell.locator(sel('canvas-proto-frame-pick-pane')).click()
  await expect(chipsBody).toHaveAttribute('data-frame', 'pane')
  await expect(chipsBody).not.toHaveAttribute('data-overflow', 'true', { timeout: 5_000 })
  expect(await box(chipsBody)).toMatchObject({ w: 333, h: 730 })
  await shell.locator(sel(`canvas-proto-frame-${chipsId}`)).click()
  await shell.locator(sel(`canvas-proto-frame-w-${chipsId}`)).fill('600')
  await shell.locator(sel(`canvas-proto-frame-h-${chipsId}`)).fill('200')
  await shell.locator(sel(`canvas-proto-frame-apply-${chipsId}`)).click()
  await expect(chipsBody).toHaveAttribute('data-frame', 'custom')
  await expect(shell.locator(sel(`canvas-proto-frame-${chipsId}`))).toHaveText(
    /Custom\s*600\s*×\s*200/,
  )
  await expect
    .poll(async () => {
      const read = await ok('canvas.read', { slug })
      const n = (read['nodes'] as Record<string, unknown>[]).find((c) => c['id'] === chipsId)
      return n?.['frame']
    })
    .toEqual({ preset: 'custom', label: 'Custom', w: 600, h: 200 })
  await chipsCard.screenshot({ path: path.join(proof, '10-custom-frame.png'), style: NO_CURSOR })

  // 7. Zooming the board scales the frame as a whole. Isaac's edits took the board; hand it back.
  const agentFrame = shell.locator(sel('canvas-agent-frame'))
  if ((await agentFrame.getAttribute('data-agent')) === 'paused') {
    await agentFrame.locator(sel('agent-hand-back')).click()
    await expect(agentFrame).toHaveAttribute('data-agent', 'working')
  }
  await ok('canvas.zoom', { slug, node: gridId, zoom: 0.5 })
  await shell.waitForTimeout(600)
  const half = await box(gridBody)
  expect(Math.abs(half.w - 1122 / 2)).toBeLessThanOrEqual(1)
  expect(Math.abs(half.h - 686 / 2)).toBeLessThanOrEqual(1)
  await board.screenshot({ path: path.join(proof, '11-board-half-zoom.png'), style: NO_CURSOR })
})
