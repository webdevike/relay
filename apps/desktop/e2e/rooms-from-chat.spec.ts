// Assistants set up rooms from a conversation (Rooms inside Assistants, slice 5). Nova calls the
// rooms.create agent action through the app's control server (as relay-mcp, relay-ctl and
// `relay-linux rooms` do) and her reply carries the `[[room:<id>]]` card token: the Room ready card
// is a live view of the room, rooms.update swaps a member and the card says "Updated ×1", Open room
// lands with Nova's draft unsent in the composer. A council proposal shows Convene / Edit members /
// Not now and stays out of the Rooms nav; Convene starts it with the question as Isaac's first
// message and the card becomes its live strip. Not now on another turns it into a quiet line.
// Screenshots go to proof/rooms-assistants/s5-*.png.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'

const PROOF = path.join(REPO_ROOT, 'proof', 'rooms-assistants')
const THREAD = 'p4-ecard'
const OPUS = 'anthropic/claude-opus-5-5'
const FAKE = 'fake/text-only'

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.rmSync(path.join(evaRoot, 'work', 'rooms'), { recursive: true, force: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({ agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', model: OPUS }] }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({
      ...fx.launchEnv,
      EVAOS_EVA_ROOT: evaRoot,
      EVAOS_RELAY_DIR: relayDir,
      EVAOS_AGENT_CONTROL: '1',
      FAKE_OMP_DELAY_MS: '5',
    })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false, colorScheme: 'dark' })

const ControlFileSchema = z.object({ url: z.string(), token: z.string() })
const ReplySchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
])

/** One agent action on the test app's control server, as Nova's thread (`agent:nova`). */
async function agent(configDir: string, id: string, params: Record<string, unknown>) {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { url, token } = ControlFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  const res = await fetch(`${url}/actions/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params, scope: 'agent:nova' }),
  })
  return ReplySchema.parse(await res.json())
}

const Created = z.object({
  roomId: z.string(),
  link: z.string(),
  state: z.string(),
  card: z.string(),
})

let parent = 'a1'
let seq = 0
/** Nova's reply in her thread file. */
async function reply(text: string): Promise<void> {
  const id = `s5-${++seq}`
  await fx.append(
    THREAD,
    JSON.stringify({
      type: 'message',
      id,
      parentId: parent,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    }),
  )
  parent = id
}

const shot = async (shell: Page, name: string): Promise<void> => {
  await shell.waitForTimeout(200)
  fs.mkdirSync(PROOF, { recursive: true })
  await shell.screenshot({ path: path.join(PROOF, name) })
}

const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

test('S5 rooms.create posts a live Room ready card; rooms.update, Open room, and a proposal convened', async ({
  shell,
  configDir,
}) => {
  host.upsert({ id: THREAD, status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })
  await shell.getByTestId('nav-assistants').click()
  await shell.getByTestId('sidebar-agent-nova').click()
  const log = shell.locator(LOG)

  const setup = {
    title: 'Boxhead weapon system',
    members: [
      { assistant: 'nova', model: OPUS, thinking: 'medium', role: 'Builder' },
      {
        custom: 'Sol',
        model: FAKE,
        thinking: 'off',
        role: 'Critic',
        instructions: 'Review every proposal for balance and scope creep.',
      },
    ],
    effort: 2,
    budget: 3,
    folder: 'work/boxhead-godot',
    draft: 'Start with the 5 weapons the current build ships.',
  }
  // Assistant-made rooms stay within $10 and effort 4.
  const over = await agent(configDir, 'rooms.create', { ...setup, budget: 12 })
  expect(over).toMatchObject({ ok: false, code: 'bad-input' })
  const made = await agent(configDir, 'rooms.create', setup)
  if (!made.ok) throw new Error(made.message)
  const room = Created.parse(made.value)
  expect(room).toMatchObject({
    state: 'idle',
    link: `relay://open/room/${room.roomId}`,
    card: `[[room:${room.roomId} | Boxhead weapon system]]`,
  })
  await reply(
    `Done. Two members, kept cheap: light effort, $3 cap. Nobody starts until you speak.\n${room.card}`,
  )

  const card = log.getByTestId(`room-card-${room.roomId}`)
  await expect(card).toBeVisible()
  await expect(log).not.toContainText('[[room:')
  await expect(card.getByTestId('room-card-title')).toHaveText('Boxhead weapon system')
  await expect(card.getByTestId('room-card-roster')).toHaveText('Nova · Builder, Sol · Critic')
  await expect(card).toContainText('Light · cap $3')
  await expect(card).toContainText('work/boxhead-godot')
  await expect(card.getByTestId('room-card-updated')).toHaveCount(0)
  await shot(shell, 's5-room-ready.png')

  // Nova swaps Sol for Opus: the same card updates in place.
  const swapped = await agent(configDir, 'rooms.update', {
    roomId: room.roomId,
    members: { replace: { from: 'Sol', to: { custom: 'Opus', model: OPUS, thinking: 'medium' } } },
  })
  expect(swapped).toMatchObject({ ok: true, value: { roomId: room.roomId, rev: 1 } })
  await reply('Swapped Sol for Opus. Same critic role. The card above and the room are updated.')
  await expect(card.getByTestId('room-card-updated')).toHaveText('Updated ×1')
  await expect(card.getByTestId('room-card-roster')).toHaveText('Nova · Builder, Opus · Critic')
  await expect(log.locator('[data-testid^="room-card-room-"]')).toHaveCount(1)
  await shot(shell, 's5-room-updated.png')

  // Open room: the room, idle, with Nova's draft waiting unsent.
  await card.getByTestId('room-card-open').click()
  await expect(shell.getByTestId(`room-${room.roomId}`)).toBeVisible()
  await expect(shell.getByTestId('room-empty')).toBeVisible()
  await expect(shell.getByTestId('room-composer')).toHaveValue(setup.draft)
  await expect(shell.getByTestId(`sidebar-room-${room.roomId}`)).toBeVisible()
  await shot(shell, 's5-open-room.png')

  // A council proposal: not listed until Isaac convenes it.
  await shell.getByTestId('sidebar-agent-nova').click()
  const question = 'Should Boxhead go Godot or Unreal?'
  const council = {
    proposal: true,
    draft: question,
    members: [
      { custom: 'Sage', model: FAKE, thinking: 'off', role: 'Argue for' },
      { custom: 'Flint', model: FAKE, thinking: 'off', role: 'Argue against' },
    ],
    effort: 1,
    budget: 2,
  }
  const proposedReply = await agent(configDir, 'rooms.create', council)
  if (!proposedReply.ok) throw new Error(proposedReply.message)
  const proposed = Created.parse(proposedReply.value)
  expect(proposed.state).toBe('proposed')
  await reply(`This is a big call, want a council on it?\n${proposed.card}`)
  const pcard = log.getByTestId(`room-card-${proposed.roomId}`)
  await expect(pcard.getByTestId('room-card-question')).toHaveText(question)
  await expect(pcard).toContainText('Quick · cap $2')
  await expect(shell.getByTestId(`sidebar-room-${proposed.roomId}`)).toHaveCount(0)
  await shot(shell, 's5-proposal.png')

  await pcard.getByTestId('room-card-convene').click()
  await expect(pcard.getByTestId('room-card-strip')).toContainText('Council')
  await expect(shell.getByTestId(`sidebar-room-${proposed.roomId}`)).toBeVisible()
  await shot(shell, 's5-convened.png')
  const listed = await agent(configDir, 'rooms.list', {})
  if (!listed.ok) throw new Error(listed.message)
  const rooms = z
    .object({ rooms: z.array(z.object({ roomId: z.string(), phase: z.string() })) })
    .parse(listed.value).rooms
  expect(rooms.find((r) => r.roomId === proposed.roomId)?.phase).not.toBe('proposed')
  await pcard.getByTestId('room-card-strip').click()
  await expect(shell.getByTestId(`room-${proposed.roomId}`)).toBeVisible()
  await expect(shell.getByTestId('room-feed')).toContainText(question)
  await shot(shell, 's5-convened-room.png')

  // Not now on another proposal: the room goes, the card is one quiet line.
  await shell.getByTestId('sidebar-agent-nova').click()
  const againReply = await agent(configDir, 'rooms.create', {
    ...council,
    draft: 'Rename the game?',
  })
  if (!againReply.ok) throw new Error(againReply.message)
  const again = Created.parse(againReply.value)
  await reply(`Or a council on the name?\n${again.card}`)
  await log.getByTestId(`room-card-${again.roomId}`).getByTestId('room-card-not-now').click()
  await expect(log.getByTestId(`room-card-gone-${again.roomId}`)).toHaveText('Not now')
  await shot(shell, 's5-not-now.png')
})
