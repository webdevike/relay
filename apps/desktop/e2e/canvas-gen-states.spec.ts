import * as fs from 'node:fs'
import * as path from 'node:path'
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

// Generation states on the design canvas (renderer canvas/agent/card-gen.machine.ts), after
// pen.dev: Nova (a scripted agent on the agent control API) adds an empty frame (creating: a
// spinner in it, a spinner ring at her named cursor's tip), then a component card that she writes
// section by section. Each section streaming in shows "Generating: <board> • <title>" (e2e runs
// with motion off: the label alone, no light, the page swaps at once) and between edits the card
// is settled, looking as always while her run stays open. A broken edit is an error (the danger
// label, the last good render kept) until she fixes it; a card landing in the frame streams the
// frame; canvas.done makes both idle. EVAOS_GEN_PROOF=<dir> also records the window (CDP
// screencast, motion on) into <dir>/gen-states.mp4 with a still per state.
const PROOF = process.env.EVAOS_GEN_PROOF ?? ''

const test = canvasAgentTest(
  [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova-1' }],
  'Design the session badges page with me',
)
test.use({ startOnChat: false })

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
const STREAMING = 'streaming|Generating: Session badges • Badges page'

test('cards an agent makes show creating, streaming, settled and error, then idle', async ({
  shell,
  app,
  configDir,
}) => {
  test.setTimeout(180_000)
  const ok = await agentControl(configDir)
  const { slug, board } = await openBoard(app, shell, ok, 'Session badges', 'session badges')
  const cursor = board.locator(sel('canvas-agent-cursor'))
  await recordGen(shell)
  const streams = async (id: string): Promise<number> =>
    (await genLog(shell, id)).filter((s) => s === STREAMING).length

  const marks: Record<string, number> = {}
  const mark = (name: string): void => {
    marks[name] = Date.now() / 1000
  }
  let stop: (() => Promise<string[]>) | null = null
  let crop = ''
  if (PROOF !== '') {
    fs.rmSync(PROOF, { recursive: true, force: true })
    fs.mkdirSync(PROOF, { recursive: true })
    crop = await zoomBoard(ok, shell, board, slug)
    // The recording shows the light: e2e runs with motion off, the proof turns it on.
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

  // 2. A component card: its first draw streams in, then it settles while her run stays open.
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
  await expect.poll(() => streams(id), { timeout: 20_000 }).toBe(1)
  await expect(body.frameLocator('iframe').getByText('Session badges')).toBeVisible()
  await expect(body).toHaveAttribute('data-gen', 'settled', { timeout: 5_000 })
  await expect(label).toHaveCount(0)
  await ok('canvas.zoom', { slug, fit: true })
  await shell.waitForTimeout(1_200)
  for (const [i, section] of SECTIONS.entries()) {
    await ok('canvas.edit', {
      slug,
      node: id,
      edits: [{ find: MORE, replace: `${section}\n  ${MORE}` }],
      caption: `Writing section ${i + 1}`,
    })
    if (i === 1) mark('streaming')
    // Each section streams in once, then the card goes quiet until the next edit.
    await expect.poll(() => streams(id), { timeout: 5_000 }).toBe(i + 2)
    await expect(body).toHaveAttribute('data-gen', 'settled', { timeout: 5_000 })
    await expect(label).toHaveCount(0)
    await shell.waitForTimeout(800)
  }

  // 3. A broken edit: error, in the danger color, over the last good render; the fix streams again.
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
  await expect(body).toHaveAttribute('data-gen', 'settled', { timeout: 5_000 })

  // 4. A card into the frame: the frame's content arrives, so it streams for a moment.
  await ok('canvas.add', {
    slug,
    type: 'note',
    title: 'States',
    body: 'Running, done, failed',
    parent: frame,
    caption: 'Filling the frame',
  })
  await expect
    .poll(() => genLog(shell, frame), { timeout: 3_000 })
    .toContain('|Generating: Session badges • Badge states')
  await expect(cursor).toHaveAttribute('data-making', 'false')
  await expect(frameLabel).toHaveCount(0, { timeout: 5_000 })

  // 5. canvas.done: both are idle at once (nothing is streaming).
  await ok('canvas.zoom', { slug, fit: true })
  await shell.waitForTimeout(800)
  await ok('canvas.done', { slug, summary: 'Badges page drafted' })
  await expect(body).toHaveAttribute('data-gen', 'idle', { timeout: 3_000 })
  await expect(label).toHaveCount(0)
  await expect(frameLabel).toHaveCount(0)
  mark('idle')
  await shell.waitForTimeout(1_000)

  if (stop) {
    const stills: Record<string, number> = {}
    for (const [i, name] of ['creating', 'streaming', 'error', 'idle'].entries()) {
      stills[path.join(PROOF, `${i + 1}-${name}.png`)] = marks[name]! + 0.4
    }
    encode(await stop(), crop, path.join(PROOF, 'gen-states.mp4'), stills)
    fs.writeFileSync(path.join(PROOF, 'marks.json'), JSON.stringify({ marks, stills }, null, 2))
  }
})
