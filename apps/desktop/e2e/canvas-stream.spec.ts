import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Frame, Page } from '@playwright/test'
import { expect } from './fixtures'
import {
  agentControl,
  canvasAgentTest,
  encode,
  genLog,
  openBoard,
  record,
  recordGen,
  sel,
  zoomBoard,
} from './helpers/canvas-agent'

// Streamed reveal on the design canvas (widget-runtime runtime/stream.ts, card-gen.machine.ts):
// Nova builds the Assistants page in four edits (title, subtitle, five assistant cards, a text
// section). Each edit's new elements fade and rise in one after another, top to bottom, while
// what was already there never animates again; the card's light, accent border and "Generating"
// label show only while elements arrive and go quiet between edits though her run stays open.
// With motion off the page swaps at once and only the label shows. EVAOS_STREAM_PROOF=<dir>
// records the board (CDP screencast) into <dir>/stream.mp4 with three stills.
const PROOF = process.env.EVAOS_STREAM_PROOF ?? ''

const AGENTS = [
  { id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova-1' },
  { id: 'astra', title: 'Astra', scope: 'Design', avatar: 'astra-2' },
  { id: 'sol', title: 'Sol', scope: 'Reviews', avatar: 'sol-3' },
  { id: 'penny', title: 'Penny', scope: 'Finance', avatar: 'penny-4' },
  { id: 'iris', title: 'Iris', scope: 'Research', avatar: 'iris-5' },
]
const test = canvasAgentTest(AGENTS, 'Design the Assistants page with me')
test.use({ startOnChat: false })

const MORE = '{/* more */}'
const TITLE = `<Stack gap="lg" p="xl">
  <Title order={2}>Assistants</Title>
  ${MORE}
</Stack>`
const STATUS = ['working', 'needs-you', 'idle', 'working', 'not-started'] as const
const EDITS = [
  {
    caption: 'A line under the title',
    add: `<Text c="dimmed">Who works for you, what each is on, and who needs you.</Text>`,
    arrive: ['Who works for you'],
  },
  {
    caption: 'The five assistants',
    add: `<SimpleGrid cols={5} spacing="md">
    ${AGENTS.map((a, i) => `<AssistantCard agent="${a.id}" status="${STATUS[i]}" age="${i + 2}m" />`).join('\n    ')}
  </SimpleGrid>`,
    arrive: AGENTS.map((a) => a.title),
  },
  {
    caption: 'How they work',
    add: `<Stack gap={4}>
    <Title order={4}>How assistants work</Title>
    <Text size="sm" c="dimmed">Each keeps its own thread and asks before anything leaves your Mac.</Text>
  </Stack>`,
    arrive: ['How assistants work', 'Each keeps its own thread'],
  },
]

/** The card's page (its iframe). */
async function pageOf(shell: Page): Promise<Frame> {
  await expect.poll(() => shell.frames().some((f) => f.url().includes('/proto?'))).toBe(true)
  return shell.frames().find((f) => f.url().includes('/proto?'))!
}

/** The elements streaming in now (the reveal's own animations, not CSS ones): text, start order. */
function arriving(page: Frame): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition))
      .map((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target
        const delay = Number(a.effect?.getTiming().delay ?? 0)
        return { text: target?.textContent?.trim() ?? '', delay }
      })
      .sort((x, y) => x.delay - y.delay)
      .map((x) => x.text),
  )
}

/** Waits for the next reveal (polled every 20 ms, so all of it is still running) and returns it. */
async function nextReveal(page: Frame): Promise<string[]> {
  let seen: string[] = []
  await expect
    .poll(
      async () => {
        seen = await arriving(page)
        return seen.length
      },
      { timeout: 5_000, intervals: [20] },
    )
    .toBeGreaterThan(0)
  return seen
}

test('an agent building the Assistants page streams each edit in; the light shows only then', async ({
  shell,
  app,
  configDir,
}) => {
  test.setTimeout(180_000)
  const ok = await agentControl(configDir)
  const { slug, board } = await openBoard(app, shell, ok, 'Assistants', 'Assistants page')
  // e2e runs with motion off; the reveal is the point here.
  await shell.evaluate(() => (document.documentElement.dataset['evaMotion'] = 'on'))
  await recordGen(shell)

  const stills: Record<string, number> = {}
  let stop: (() => Promise<string[]>) | null = null
  let crop = ''
  if (PROOF !== '') {
    fs.rmSync(PROOF, { recursive: true, force: true })
    fs.mkdirSync(PROOF, { recursive: true })
    crop = await zoomBoard(ok, shell, board, slug)
    stop = await record(shell, path.join(PROOF, 'frames'))
  }

  // Edit 1: the card with its title. Its first draw streams in.
  const id = String(
    (
      await ok('canvas.add', {
        slug,
        type: 'proto',
        title: 'Assistants page',
        body: TITLE,
        data: { frame: 'page' },
        caption: 'Starting with the title',
      })
    )['id'],
  )
  const body = shell.locator(sel(`canvas-proto-${id}`))
  const label = shell.locator(sel(`canvas-gen-label-${id}`))
  const glow = body.locator('.eva-cv-gen-glow')
  const page = await pageOf(shell)
  await expect(page.getByText('Assistants', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(body).toHaveAttribute('data-gen', 'settled', { timeout: 8_000 })
  expect(await genLog(shell, id)).toContain('streaming|Generating: Assistants • Assistants page')
  await ok('canvas.zoom', { slug, fit: true })
  await shell.waitForTimeout(1_000)
  for (const [i, edit] of EDITS.entries()) {
    // Between edits: quiet. No label, no light, the plain border, though the run is open.
    await expect(label).toHaveCount(0)
    await expect(glow).toHaveCSS('opacity', '0')
    await ok('canvas.edit', {
      slug,
      node: id,
      edits: [{ find: MORE, replace: `${edit.add}\n  ${MORE}` }],
      caption: edit.caption,
    })
    const reveal = await nextReveal(page)
    // The reveal began within a poll (20 ms) of this.
    const started = Date.now() / 1000
    // Only the new elements arrive, top to bottom; the title (and earlier edits) stay put.
    expect(reveal).toHaveLength(edit.arrive.length)
    edit.arrive.forEach((text, k) => expect(reveal[k]).toContain(text))
    expect(reveal).not.toContain('Assistants')
    // While they arrive: the label in the accent, the light on.
    await expect(body).toHaveAttribute('data-gen', 'streaming')
    await expect(label).toHaveText('Generating: Assistants • Assistants page')
    await expect(glow).toHaveAttribute('data-gen', 'streaming')
    if (i === 1) stills['1-cards-streaming.png'] = started + 0.2
    if (i === 2) stills['3-section-streaming.png'] = started + 0.12
    // Then quiet again until the next edit.
    await expect(body).toHaveAttribute('data-gen', 'settled', { timeout: 5_000 })
    await expect(glow).toHaveCSS('opacity', '0')
    if (i === 1) stills['2-settled-between-edits.png'] = Date.now() / 1000 + 0.6
    await shell.waitForTimeout(1_400)
  }
  for (const a of AGENTS) await expect(page.getByText(a.title, { exact: true })).toBeVisible()

  if (stop) {
    const frames = await stop()
    const out = Object.fromEntries(
      Object.entries(stills).map(([name, t]) => [path.join(PROOF, name), t]),
    )
    encode(frames, crop, path.join(PROOF, 'stream.mp4'), out)
    fs.writeFileSync(path.join(PROOF, 'stills.json'), JSON.stringify(out, null, 2))
  }

  // Motion off: the edit swaps in at once (nothing animates) and only the label says so.
  await shell.evaluate(() => (document.documentElement.dataset['evaMotion'] = 'off'))
  const before = (await genLog(shell, id)).length
  await ok('canvas.edit', {
    slug,
    node: id,
    edits: [{ find: 'needs you.', replace: 'needs you today.' }],
    caption: 'Tighter subtitle',
  })
  await expect(page.getByText('needs you today.')).toBeVisible({ timeout: 5_000 })
  expect(await arriving(page)).toEqual([])
  await expect
    .poll(async () => (await genLog(shell, id)).slice(before))
    .toContain('streaming|Generating: Assistants • Assistants page')
  await expect(body).toHaveAttribute('data-gen', 'settled', { timeout: 5_000 })

  await ok('canvas.done', { slug, summary: 'Assistants page drafted' })
  await expect(body).toHaveAttribute('data-gen', 'idle', { timeout: 3_000 })
})
