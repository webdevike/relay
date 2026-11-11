import type { Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'

// Assistants > Rooms. Slice 1: the Rooms section under the assistants, a Debate room made on the
// New room page with a custom member on an exact model from the fake omp catalog, the empty idle
// room with its notch avatar stack and hover card, then Rename, Duplicate and Delete from the
// row's right-click menu. Slice 2: a two-member room talks (fake omp seats answer as themselves),
// the speaking ring, and the one @ picker (Agents + Actions) with inline chips. The Eva root is a
// temp copy, so room.json files land there.
const PROOF = path.join(REPO_ROOT, 'proof', 'rooms-assistants')
let evaRoot = ''

interface SeedMember {
  id: string
  assistant?: string
  name: string
  model: string
  thinking: string
  role: string
}

/** A saved chat room's room.json: its members, title and messages (an empty one is idle). */
const roomFile = (
  id: string,
  title: string,
  members: SeedMember[],
  messages: { author: string; text: string }[],
  effort: number,
  now: number,
): unknown => ({
  version: 1,
  kind: 'chat',
  room: {
    id,
    kind: 'chat',
    title,
    prompt: messages[0]?.text ?? '',
    agents: members.map((m, i) => ({
      id: m.id,
      name: m.name,
      title: m.role,
      role: m.role,
      brief: '',
      model: m.model,
      tools: 'full',
      color: ['blue', 'orange', 'teal'][i],
    })),
    messages: messages.map((m, i) => ({
      id: `m${i + 1}`,
      author: m.author,
      text: m.text,
      ts: now - (messages.length - i) * 60_000,
      reactions: [],
      kind: 'message',
      mentions: [],
    })),
    presence: {},
    phase: 'idle',
    rounds: 0,
    startedAt: now - 3_600_000,
    chat: {
      setup: { title, template: 'blank', members, effort, budget: 3, refs: [] },
      rev: 0,
      spend: { usd: 0, byMember: {} },
    },
  },
})

/** A saved, idle two-member room: Nova (an assistant) and Skeptic (a custom agent). */
const S2_ROOM = 'room-s2-talk'
const s2Room = (now: number): unknown =>
  roomFile(
    S2_ROOM,
    'Store choice',
    [
      {
        id: 'nova',
        assistant: 'nova',
        name: 'Nova',
        model: 'anthropic/claude-opus-5-5',
        thinking: 'medium',
        role: 'Judge',
      },
      {
        id: 'skeptic',
        name: 'Skeptic',
        model: 'fake/text-only',
        thinking: 'off',
        role: 'Argue against',
      },
    ],
    [],
    1,
    now,
  )

/**
 * Slice 4's room: Astra and Polaris argue, Nova judges; an earlier exchange makes the log scroll.
 * Their replies are scripted (FAKE_OMP_ROOM_SCRIPT) with decision markers.
 */
const S4_ROOM = 'room-s4-store'
const S4_MEMBERS: SeedMember[] = [
  { id: 'astra', name: 'Astra', model: 'fake/text-only', thinking: 'off', role: 'Argue for' },
  {
    id: 'polaris',
    name: 'Polaris',
    model: 'fake/text-only',
    thinking: 'off',
    role: 'Argue against',
  },
  {
    id: 'nova',
    assistant: 'nova',
    name: 'Nova',
    model: 'anthropic/claude-opus-5-5',
    thinking: 'medium',
    role: 'Judge',
  },
]
const S4_HISTORY = [
  [
    'isaac',
    'Relay Host keeps its sessions in SQLite. Before the second Mac shows up, sanity check it.',
  ],
  ['astra', 'The worker pool writes from 6 processes and WAL still serialises writers.'],
  ['polaris', 'The host is one Mac Mini. The write rate is what matters, not the process count.'],
  ['astra', 'Fair. I will pull the last 7 days of commit timings.'],
  ['polaris', 'Backups are the real gap today: nothing leaves the Mini.'],
  ['nova', 'Two threads then: write load and backups. Bring numbers next time.'],
  ['astra', 'Peak is 40 writes a second over the last 7 days, p99 commit 3 ms.'],
  ['polaris', 'That is far under what SQLite handles on this machine.'],
  ['nova', 'Noted. Isaac decides when we pick this up again.'],
  ['isaac', 'One more data point: the sessions table is 14 tables now, about 30 by spring.'],
  ['astra', 'Then a migration grows with every table we add.'],
  ['polaris', 'A migration script later is a day of work. Not a reason to run a daemon today.'],
  ['astra', 'FTS5 is the part that worries me, not the tables.'],
  ['nova', 'Park it until Isaac asks. Both of you, keep the numbers handy.'],
].map(([author, text]) => ({ author: author!, text: text! }))
const S4_SCRIPT = {
  Astra: [
    'Postgres still wins on concurrency once a second host writes. @Polaris what do you see?',
    'Postgres. Migration only gets harder as the schema grows. @Polaris\n[[vote: 3]]',
    'FTS5 and JSON queries will not port cleanly either. @Polaris\n[[cons: Staying on SQLite | FTS5 and JSON queries will not port cleanly]]\n[[dispute: Zero ops]]',
    'Fine. Migrating while it is 14 tables would still be cheaper.\n[[vote: 3]]',
  ],
  Polaris: [
    'Three positions on the table, so let us vote. @Astra\n[[poll: Which store for the next 6 months? | SQLite now, Postgres when a second host exists | Stay on SQLite | Move to Postgres now]]\n[[vote: Stay on SQLite]]',
    'Tradeoffs so far, with who said what. @Astra\n[[pros: Staying on SQLite | Peak 40 writes a second, far under the WAL ceiling | Zero ops: no daemon on the Mini | Litestream to R2 covers backups]]\n[[cons: Staying on SQLite | One writer at a time | Cannot serve a second host]]',
    '@Isaac one thing only you know.\n[[ask-isaac: Is a second Relay Host coming this quarter? | Yes | No | Not sure | note: Yes flips this to Postgres now. No keeps SQLite with a revisit trigger.]]',
    'Then SQLite with a revisit trigger holds. Switching to the trigger option.\n[[vote: 1]]',
  ],
  Nova: [
    'Calling it. Isaac, accept or override.\n[[decision: SQLite now, Postgres when a second host exists | Peak load is 40 writes a second on one Mac Mini. Postgres adds a daemon and buys nothing until a second host. | Polaris: Add Litestream backups to R2 today]]',
  ],
}

const test = base.extend({
  launchEnv: async ({}, use, testInfo) => {
    // Slice 2's tests start with a saved two-member room and a second assistant, Penny; slice 4's
    // with a three-member room whose members answer from a script.
    const s2 = testInfo.title.startsWith('S2')
    const s4 = testInfo.title.startsWith('S4')
    evaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-eva-'))
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.rmSync(path.join(evaRoot, 'work', 'rooms'), { recursive: true, force: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [
          { id: 'nova', title: 'Nova', scope: 'Personal', model: 'anthropic/claude-opus-5-5' },
          ...(s2 ? [{ id: 'penny', title: 'Penny', scope: 'Errands' }] : []),
        ],
      }),
    )
    if (s2) {
      const dir = path.join(evaRoot, 'work', 'rooms', S2_ROOM)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'room.json'), JSON.stringify(s2Room(Date.now())))
    }
    const env: Record<string, string> = { EVAOS_EVA_ROOT: evaRoot, FAKE_OMP_DELAY_MS: '5' }
    if (s4) {
      const dir = path.join(evaRoot, 'work', 'rooms', S4_ROOM)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'room.json'),
        JSON.stringify(
          roomFile(S4_ROOM, 'Postgres vs SQLite', S4_MEMBERS, S4_HISTORY, 3, Date.now()),
        ),
      )
      const script = path.join(evaRoot, 'room-script.json')
      fs.writeFileSync(script, JSON.stringify(S4_SCRIPT))
      env.FAKE_OMP_ROOM_SCRIPT = script
      env.FAKE_OMP_SEAT_DELAY_MS = '150'
    }
    await use(env)
    fs.rmSync(evaRoot, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false, toolPanes: false, colorScheme: 'dark' })

const sel = (id: string): string => `[data-testid="${id}"]`
const shot = async (shell: Page, name: string): Promise<void> => {
  fs.mkdirSync(PROOF, { recursive: true })
  await shell.screenshot({ path: path.join(PROOF, name) })
}
const roomIds = (): string[] => {
  const dir = path.join(evaRoot, 'work', 'rooms')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}
const saved = (
  id: string,
): {
  kind: string
  room: {
    phase: string
    title: string
    chat: { setup: { members: { name: string; model: string }[] } }
  }
} => JSON.parse(fs.readFileSync(path.join(evaRoot, 'work', 'rooms', id, 'room.json'), 'utf8'))

test('rooms live under Assistants: new idle room, notch stack, rename, duplicate, delete', async ({
  shell,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await expect(shell.locator(sel('sidebar-sub-assistants'))).toBeVisible()
  await expect(shell.locator(sel('assistants-rooms'))).toBeVisible()
  await expect(shell.locator(sel('sidebar-room-new'))).toBeVisible()
  await expect(shell.locator(sel('nav-rooms'))).toHaveCount(0)

  // New room: Debate fills Nova and two custom agents; one becomes "Skeptic" on an exact model.
  await shell.locator(sel('rooms-new-button')).click()
  await expect(shell.locator(sel('room-form'))).toBeVisible()
  await expect(shell.locator(sel('room-member-row-0'))).toContainText('Nova')
  await shell.locator(sel('room-member-name-1')).fill('Skeptic')
  await shell.locator(sel('room-member-model-picker-1')).click()
  await shell.locator(sel('room-member-model-picker-1-search')).fill('text-only')
  await shell.locator(sel('room-member-model-picker-1-option-fake/text-only')).click()
  await expect(shell.locator(sel('room-member-model-picker-1'))).toContainText('fake/text-only')
  await shot(shell, 's1-new-room.png')
  await shell.locator(sel('room-submit')).click()

  // The empty idle room: notch stack, quiet hint, the composer; the row says Idle.
  await expect(shell.locator(sel('room-empty'))).toBeVisible()
  await expect.poll(roomIds).toHaveLength(1)
  const [id] = roomIds()
  const row = shell.locator(sel(`sidebar-room-${id}`))
  await expect(row).toContainText('New room')
  await expect(row).toContainText('Idle')
  await expect(shell.locator(sel('room-title'))).toHaveText('New room')
  await expect(shell.locator(`${sel('room-stack')} [data-testid^="room-member-"]`)).toHaveCount(3)
  await expect(shell.locator(sel('room-composer'))).toHaveAttribute(
    'placeholder',
    'Message the room, or @mention a member',
  )
  const file = saved(id!)
  expect(file.kind).toBe('chat')
  expect(file.room.phase).toBe('idle')
  expect(file.room.chat.setup.members.map((m) => [m.name, m.model])).toEqual([
    ['Nova', 'anthropic/claude-opus-5-5'],
    ['Skeptic', 'fake/text-only'],
    ['Agent 3', expect.any(String)],
  ])
  // A member keeps the id it was made with ("agent-2") when its name changes.
  await shell.locator(sel('room-member-agent-2')).hover()
  await expect(shell.locator(sel('room-member-model-agent-2'))).toHaveText('fake/text-only')
  await shot(shell, 's1-empty-room-hover.png')

  // Rename in place from the row's menu; an idle room offers no Pause or Resume.
  await row.click({ button: 'right' })
  await expect(shell.locator(sel('room-menu'))).toBeVisible()
  await expect(shell.locator(sel('room-menu-pause'))).toHaveCount(0)
  await expect(shell.locator(sel('room-menu-resume'))).toHaveCount(0)
  await shot(shell, 's1-room-menu.png')
  await shell.locator(sel('room-menu-rename')).click()
  await shell.locator(sel('room-rename-input')).fill('Weapons debate')
  await shell.locator(sel('room-rename-input')).press('Enter')
  await expect(shell.locator(sel('room-title'))).toHaveText('Weapons debate')
  await expect.poll(() => saved(id!).room.title).toBe('Weapons debate')

  // Duplicate: the same setup, idle, " copy" after the title.
  await row.click({ button: 'right' })
  await shell.locator(sel('room-menu-duplicate')).click()
  await expect.poll(roomIds).toHaveLength(2)
  const copy = roomIds().find((r) => r !== id)!
  await expect(shell.locator(sel(`sidebar-room-${copy}`))).toContainText('Weapons debate copy')
  expect(saved(copy).room.chat.setup.members).toEqual(saved(id!).room.chat.setup.members)

  // Delete behind the confirm: the row and its folder go.
  await shell.locator(sel(`sidebar-room-${copy}`)).click({ button: 'right' })
  await shell.locator(sel('room-menu-delete')).click()
  await shell.locator(sel('room-delete-ok')).click()
  await expect(shell.locator(sel(`sidebar-room-${copy}`))).toHaveCount(0)
  expect(roomIds()).toEqual([id])
  await shot(shell, 's1-after-delete.png')
})

test('S2 members talk: @ picker with members and guests, chip, both reply, speaking ring', async ({
  shell,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel(`sidebar-room-${S2_ROOM}`)).click()
  await expect(shell.locator(sel('room-empty'))).toBeVisible()
  await expect(shell.locator(sel('room-spend'))).toContainText('$0.00 / $3.00')

  // One @ menu: the members "in this room", then Penny who would join as a guest.
  const box = shell.locator(sel('room-composer'))
  const menu = shell.locator(sel('room-mentions'))
  await box.pressSequentially('@')
  await expect(menu.locator('[role=option]')).toHaveText([
    /Nova.*in this room/,
    /Skeptic.*in this room/,
    /Penny.*Errands · joins as guest/,
  ])
  await expect(menu).toContainText('Agents')
  await shot(shell, 's2-at-room.png')
  await box.press('ArrowDown')
  await box.press('Enter')
  await expect(box).toHaveValue('@Skeptic ')
  await box.pressSequentially('is SQLite enough for one Mac?')
  await expect(shell.locator(sel('composer-mention-chip'))).toHaveText('@Skeptic')
  await shot(shell, 's2-at-chip.png')
  await box.press('Enter')

  // Skeptic was named, so it speaks first: its avatar wears the ring while it has the turn.
  const skeptic = shell.locator(sel('room-member-skeptic'))
  await expect(skeptic).toHaveAttribute('data-turn', 'true')
  await expect(shell.locator(sel('room-presence'))).toContainText('Skeptic')
  await shot(shell, 's2-speaking.png')
  const reply = (who: string) => shell.locator(`[data-author="${who}"]`)
  await expect(reply('isaac')).toContainText('is SQLite enough for one Mac?')
  await expect(reply('skeptic')).toContainText('Skeptic here, turn 1.')
  await expect(reply('nova')).toContainText('Nova here, turn 1.')
  await expect(reply('nova')).toContainText('Judge')
  await expect(skeptic).not.toHaveAttribute('data-turn', 'true')
  // Order: Isaac, Skeptic (mentioned), then Nova; the room is quiet again.
  const authors = await shell
    .locator(`${sel('room-feed')} [data-author]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-author')))
  expect(authors).toEqual(['isaac', 'skeptic', 'nova'])
  await expect.poll(() => saved(S2_ROOM).room.phase).toBe('idle')
  await skeptic.hover()
  await expect(shell.locator(sel('room-member-card-skeptic'))).toContainText('idle')
  await expect(shell.locator(sel('room-member-cost-skeptic'))).toContainText('$0.00')
  await shot(shell, 's2-exchange.png')
})

test('S2 chat composer @ menu: Agents then Actions, an agent goes in as a chip', async ({
  shell,
}) => {
  await shell.locator(sel('nav-chat')).click()
  await shell.locator(sel('chat-new')).click()
  const box = shell.locator(sel('composer-input'))
  const menu = shell.locator(sel('at-menu'))
  await box.pressSequentially('@')
  await expect(menu.locator('[role=option]')).toHaveText([
    /Nova.*Personal/,
    /Penny.*Errands/,
    /Computer.*Control Mac apps on the Mini/,
  ])
  await expect(menu).toContainText('Agents')
  await expect(menu).toContainText('Actions')
  await shot(shell, 's2-at-menu.png')
  await box.press('ArrowDown')
  await box.press('Enter')
  await expect(box).toHaveValue('@Penny ')
  await box.pressSequentially('find a 2TB SSD under $200')
  await expect(shell.locator(sel('composer-mention-chip'))).toHaveText('@Penny')
  await shot(shell, 's2-chat-chip.png')
  // Computer is still one keystroke away and keeps its chip.
  await box.fill('')
  await box.pressSequentially('@com')
  await box.press('Enter')
  await box.press('Enter')
  await expect(shell.locator(sel('computer-chip'))).toHaveAttribute('data-mode', 'headless')
})

test('S4 decision cards: poll, votes, pros/cons, a question, the call; Where we are, catch-up, since you left', async ({
  shell,
}) => {
  const card = (kind: string) => shell.locator(`[data-testid^="decision-${kind}-"]`)
  const fromDisk = (): {
    messages: {
      author: string
      text: string
      card?: { type: string; state?: string; answered?: string }
    }[]
  } =>
    JSON.parse(fs.readFileSync(path.join(evaRoot, 'work', 'rooms', S4_ROOM, 'room.json'), 'utf8'))
      .room
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel(`sidebar-room-${S4_ROOM}`)).click()
  const feed = shell.locator(sel('room-feed'))
  await expect(feed).toContainText('Peak is 40 writes a second')
  // No card yet: no strip.
  await expect(shell.locator(sel('room-where'))).toHaveCount(0)

  const box = shell.locator(sel('room-composer'))
  await box.fill('Should Relay Host move from SQLite to Postgres now?')
  await box.press('Enter')

  // Isaac reads back while the members talk: the catch-up pill counts what arrives.
  await expect(feed.locator('[data-author="astra"]').last()).toContainText('Postgres still wins', {
    timeout: 20_000,
  })
  await feed.evaluate((el) => {
    el.scrollTop = 0
  })
  const pill = shell.locator(sel('room-catchup-pill'))
  await expect(pill).toContainText('1 question for you', { timeout: 30_000 })
  await expect(pill).toContainText(/\d+ new/)
  await shot(shell, 's4-pill.png')
  await pill.click()
  const panel = shell.locator(sel('room-catchup-panel'))
  await expect(panel).toContainText('Vote opened: Which store for the next 6 months?')
  await expect(panel).toContainText('Tradeoffs listed, 1 disputed')
  await expect(panel).toContainText('Polaris asks you: Is a second Relay Host coming this quarter?')
  await shot(shell, 's4-pill-panel.png')
  // A summary line jumps to its card.
  await panel.getByText('Vote opened').click()
  await expect(card('poll')).toBeInViewport()

  // The poll: members' votes tallied on one card; Isaac taps to vote.
  const poll = card('poll')
  await expect(poll).toContainText('2 of 4')
  await expect(poll.locator(sel('poll-option-o2'))).toContainText('1')
  await expect(poll.locator(sel('poll-option-o3'))).toContainText('1')
  await poll.locator(sel('poll-option-o1')).click()
  await expect(poll).toContainText('3 of 4')
  await expect(poll.locator(sel('poll-option-o1'))).toHaveAttribute('data-mine', 'true')
  await expect(feed).toContainText('Isaac voted SQLite now, Postgres when a second host exists')
  await poll.hover()
  await expect(poll.locator(sel('poll-call'))).toBeVisible()
  await shot(shell, 's4-poll.png')
  // The pill's arrow goes to the latest message; the pill is gone once Isaac is caught up.
  await shell.locator(sel('room-catchup-latest')).click()
  await expect(pill).toHaveCount(0)

  // Pros and cons: two columns, a disputed point.
  const pc = card('proscons')
  await pc.scrollIntoViewIfNeeded()
  await expect(pc).toContainText('Staying on SQLite')
  await expect(pc).toContainText('1 disputed')
  await expect(pc.locator('[data-disputed]')).toContainText('Zero ops: no daemon on the Mini')
  await shot(shell, 's4-proscons.png')

  // Where we are: the question, the leaning, the question waiting on Isaac (a click jumps to it).
  const where = shell.locator(sel('room-where'))
  await expect(where).toContainText('Which store for the next 6 months?')
  await expect(where).toContainText('Split vote')
  await expect(where.locator(sel('room-where-you'))).toHaveText('1 question for you')
  await where.locator(sel('room-where-you')).click()
  const question = card('question')
  await expect(question).toBeInViewport()
  await expect(question).toContainText('Yes flips this to Postgres now.')
  await expect(question).toContainText('For you')
  await shot(shell, 's4-question.png')

  // Back at the bottom, Isaac answers; then he leaves while the members go on.
  await feed.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await question.locator(sel('question-answer-1')).click()
  await expect(feed.locator('[data-author="isaac"]').last()).toContainText(
    'Is a second Relay Host coming this quarter? No',
  )
  await expect(question).toHaveAttribute('data-state', 'answered')
  await shell.locator(sel('sidebar-room-new')).click()
  await expect(shell.locator(sel('room-form'))).toBeVisible()
  await expect
    .poll(() => fromDisk().messages.some((m) => m.card?.type === 'decision'), { timeout: 30_000 })
    .toBe(true)

  // Since you left: a summary where he stopped; the strip now asks for his call.
  await shell.locator(sel(`sidebar-room-${S4_ROOM}`)).click()
  const since = shell.locator(sel('room-since'))
  await expect(since).toBeVisible()
  await expect(since).toContainText('Since you left')
  await expect(since).toContainText(
    'Decided: SQLite now, Postgres when a second host exists. Accept or override',
  )
  await expect(where.locator(sel('room-where-you'))).toHaveText('Your call on the decision')
  await expect(where).toContainText('Decided SQLite now, Postgres when a second host exists')
  await shot(shell, 's4-since.png')

  // The decision record: agree / dissent, the next step; Isaac accepts.
  const record = card('record')
  await record.scrollIntoViewIfNeeded()
  await expect(record).toHaveAttribute('data-state', 'proposed')
  await expect(record).toContainText('Your call')
  await expect(record).toContainText('Add Litestream backups to R2 today')
  await expect(record.locator(sel('decision-override-o2'))).toContainText('Stay on SQLite instead')
  await shot(shell, 's4-decision.png')
  await record.locator(sel('decision-accept')).click()
  await expect(record).toHaveAttribute('data-state', 'accepted')
  await expect(feed).toContainText(
    'Isaac accepted the call: SQLite now, Postgres when a second host exists',
  )
  await expect(where.locator(sel('room-where-you'))).toHaveCount(0)
  await expect(poll).toHaveAttribute('data-state', 'called')
  await shot(shell, 's4-accepted.png')
  await expect
    .poll(() => fromDisk().messages.find((m) => m.card?.type === 'decision')?.card?.state)
    .toBe('accepted')
  expect(fromDisk().messages.find((m) => m.card?.type === 'question')?.card?.answered).toBe('No')
  // No marker reaches the room.
  expect(JSON.stringify(fromDisk().messages)).not.toContain('[[')
})
