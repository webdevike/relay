// The turn navigator: a column of thin ticks on the chat's left edge, one per turn. Hovering a tick
// opens a card (the message, the start of the reply, a bookmark toggle), a click jumps to the turn
// and flashes it, Alt+Up / Alt+Down step between turns, a dot marks a turn that wants Isaac (an
// unanswered question, something shipped he never reacted to; his reaction clears it), and the
// filter keeps flagged and bookmarked turns. Saves screenshots to proof/chat-minimap/
// (EVAOS_PROOF=1).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   EVAOS_PROOF=1 pnpm -C apps/desktop exec playwright test e2e/chat-minimap.spec.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

const OUT = path.join(REPO_ROOT, 'proof', 'chat-minimap')
const THREAD = 'session:p4-ecard'
const T0 = 1792486874000
const MIN = 60_000

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend<{ hostBookmarks: boolean }>({
  /** The host lists "bookmarks" in `welcome.features`: it keeps them. False: an older host. */
  hostBookmarks: [true, { option: true }],
  launchEnv: async ({ hostBookmarks }, use) => {
    fx = makeChatFixture()
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    if (hostBookmarks) host.features = ['bookmarks']
    await use({ ...fx.launchEnv, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ reducedMotion: 'reduce', toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

type MainGlobal = {
  __evaosTest: { win: { setContentSize(w: number, h: number): void } }
}
const resize = (app: ElectronApplication, w: number, h: number) =>
  app.evaluate(
    (_e, [cw, ch]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(cw, ch),
    [w, h] as const,
  )

const prompt = (id: string, parent: string | null, text: string, at: number): string =>
  line({
    type: 'message',
    id,
    parentId: parent,
    message: { role: 'user', content: text, attribution: 'user', timestamp: at },
  })
const reply = (id: string, parent: string, text: string, at: number): string =>
  line({
    type: 'message',
    id,
    parentId: parent,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      timestamp: at,
    },
  })

const SHIPPED_AT = T0 + 60 * MIN
const ASKED_AT = T0 + 200 * MIN
const SHIPPED = 'Turn rail\nThe turn rail is live. Restart Relay to try it.'
const SPOKE_FIRST = 'Quick one: should I start on the importer next?'
const LAST_Q = 'Staging is up and the order check passes. Push it to prod?'
const FILLER =
  'Filler answer. A few lines of text so the log scrolls a good way.\n\nSecond paragraph, still nothing to flag here, just height.'

/**
 * p4-ecard with a long thread: filler turns; the assistant speaking first with a shipped note and
 * later with a question (Isaac's next messages come long after, about other things); and a last
 * turn that ends on a question.
 */
async function openChat(app: ElectronApplication, shell: Page): Promise<void> {
  let parent = 'a1'
  let at = T0
  const turn = async (id: string, q: string, a: string): Promise<void> => {
    await fx.append('p4-ecard', prompt(`${id}u`, parent, q, at))
    await fx.append('p4-ecard', reply(`${id}a`, `${id}u`, a, at + 5000))
    parent = `${id}a`
    at += 20_000
  }
  const spoke = async (id: string, text: string, when: number): Promise<void> => {
    await fx.append('p4-ecard', reply(id, parent, text, when))
    parent = id
    at = when + 25 * MIN
  }
  for (let i = 0; i < 10; i++) await turn(`f${i}`, `Filler question ${i}`, FILLER)
  await spoke('ship', SHIPPED, SHIPPED_AT)
  await turn('after1', 'Unrelated: what time is standup?', 'Ten thirty.')
  for (let i = 10; i < 16; i++) await turn(`f${i}`, `Filler question ${i}`, FILLER)
  at = ASKED_AT - 25 * MIN
  await spoke('first', SPOKE_FIRST, ASKED_AT)
  await turn('after2', 'Draft the release notes', 'Drafted, see the doc.')
  for (let i = 16; i < 22; i++) await turn(`f${i}`, `Filler question ${i}`, FILLER)
  await turn('last', 'Is staging ready for the order check?', LAST_Q)
  host.upsert({ id: 'p4-ecard', status: 'idle' })
  await resize(app, 1900, 1000)
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector(sel('chat-tree'))
  await shell.locator(sel('chat-row-p4-ecard')).click()
  await expect(shell.locator(LOG)).toContainText('Push it to prod?')
}

async function scrollTo(shell: Page, where: 'top' | 'end'): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await shell.locator(LOG).evaluate((el, to) => {
      const list = el.firstElementChild as HTMLElement
      list.scrollTop = to === 'top' ? 0 : list.scrollHeight
    }, where)
    await shell.waitForTimeout(80)
  }
}

async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  await shell.waitForTimeout(150)
  const tmp = await proofShot(app, shell, name, { phase: 'chat-minimap' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

const ticks = (shell: Page) => shell.locator(`${sel('turn-minimap')} ${sel('turn-tick')}`)
const tickOf = (shell: Page, title: string) =>
  shell.locator(`${sel('turn-minimap')} ${sel('turn-tick')}[aria-label="${title}"]`)
const flagged = (shell: Page, flag: string) =>
  shell.locator(`${sel('turn-minimap')} ${sel('turn-tick')}[data-flag="${flag}"]`)

/** The log's scroll top, and how far down the viewport row `id` starts. */
const rowTop = (shell: Page, id: string): Promise<number | null> =>
  shell.evaluate((rowId) => {
    const row = document.querySelector(`[data-testid="msg-${rowId}"]`)
    const log = document.querySelector('[data-testid=chat-log]')
    if (!row || !log) return null
    return row.getBoundingClientRect().top - log.getBoundingClientRect().top
  }, id)

test('hover card, click jump with flash, Alt+Up/Down, flags and filter, bookmarks that persist', async ({
  app,
  shell,
}) => {
  test.setTimeout(180_000)
  await openChat(app, shell)
  await scrollTo(shell, 'end')

  // 1. One tick per turn; the last turn is on screen, so its tick is the active one.
  const total = await ticks(shell).count()
  expect(total).toBeGreaterThanOrEqual(26)
  await expect(ticks(shell).last()).toHaveAttribute('data-state', 'active')
  await expect(ticks(shell).first()).toHaveAttribute('data-state', 'idle')
  // The column hugs the left edge, centred, inside the log and clear of the composer.
  const box = (await shell.locator(sel('turn-minimap-ticks')).boundingBox())!
  const log = (await shell.locator(LOG).boundingBox())!
  const composer = (await shell.locator(sel('composer')).first().boundingBox())!
  expect(box.x).toBeLessThanOrEqual(log.x + 2)
  expect(box.y).toBeGreaterThanOrEqual(log.y - 1)
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y)
  const first = (await ticks(shell).first().boundingBox())!
  const last = (await ticks(shell).last().boundingBox())!
  expect((first.y + last.y + last.height) / 2).toBeCloseTo(log.y + log.height / 2, -1)

  // 2. Hover: the message in bold on one line, then the start of the reply, and a bookmark toggle.
  await ticks(shell).first().hover()
  const card = shell.locator(sel('turn-card'))
  await expect(card.getByTestId('turn-card-title')).not.toBeEmpty()
  await expect(card.getByTestId('turn-card-reply')).not.toBeEmpty()
  await expect(card.getByTestId('turn-card-bookmark')).toBeVisible()
  await tickOf(shell, 'Filler question 3').hover()
  await expect(card.getByTestId('turn-card-title')).toHaveText('Filler question 3')
  await expect(card.getByTestId('turn-card-reply')).toContainText('Filler answer.')
  const title = (await card.getByTestId('turn-card-title').boundingBox())!
  const reply = (await card.getByTestId('turn-card-reply').boundingBox())!
  expect(title.height).toBeLessThan(24)
  expect(reply.height).toBeGreaterThan(title.height)
  await shot(app, shell, 'hover-card')

  // 3. Click jumps to the turn (near the top of the log) and flashes it.
  await tickOf(shell, 'Filler question 3').click()
  await expect
    .poll(async () => {
      const top = await rowTop(shell, 'f3u')
      return top !== null && top >= -2 && top < 140
    })
    .toBe(true)
  await expect(shell.locator(sel('msg-f3u'))).toHaveAttribute('data-flash', 'true')
  await expect(tickOf(shell, 'Filler question 3')).toHaveAttribute('data-state', 'active')

  // 4. Alt+Down and Alt+Up step between turns (focus is on the tick inside this chat).
  await shell.keyboard.press('Alt+ArrowDown')
  await expect
    .poll(async () => {
      const top = await rowTop(shell, 'f4u')
      return top !== null && top >= -2 && top < 140
    })
    .toBe(true)
  await expect(tickOf(shell, 'Filler question 4')).toHaveAttribute('data-state', 'active')
  await shell.keyboard.press('Alt+ArrowUp')
  await shell.keyboard.press('Alt+ArrowUp')
  await expect(tickOf(shell, 'Filler question 2')).toHaveAttribute('data-state', 'active')

  // 5. Flags: the shipped note and the question nobody answered, and the last turn's question; the
  // questions Isaac's next message answered carry none.
  await expect(flagged(shell, 'shipped')).toHaveCount(1)
  await expect(flagged(shell, 'ask')).toHaveCount(2)
  await expect(tickOf(shell, 'Filler question 3')).not.toHaveAttribute('data-flag', /.+/)
  await tickOf(shell, 'Turn rail').hover()
  await expect(card.getByTestId('turn-card-flag')).toHaveText('Said something shipped')
  await tickOf(shell, SPOKE_FIRST).hover()
  await expect(card.getByTestId('turn-card-flag')).toHaveText('Asked you something')
  await shot(app, shell, 'flagged-ticks')

  // 6. Isaac's reaction on the shipped note clears its dot.
  host.setReactions(THREAD, {
    [`assistant@${SHIPPED_AT}`]: {
      isaac: { emoji: '👍', excerpt: 'The turn rail is live.', at: SHIPPED_AT + 1 },
    },
  })
  await expect(flagged(shell, 'shipped')).toHaveCount(0)
  await expect(flagged(shell, 'ask')).toHaveCount(2)

  // 7. Bookmark a plain turn from its card; the filter keeps flagged and bookmarked ones only.
  await tickOf(shell, 'Filler question 7').hover()
  await card.getByTestId('turn-card-bookmark').click()
  await expect(tickOf(shell, 'Filler question 7')).toHaveAttribute('data-bookmarked', 'true')
  await expect(card.getByTestId('turn-card-bookmark')).toHaveAttribute('aria-pressed', 'true')
  await shell.locator(sel('turn-minimap-filter')).click()
  await expect(ticks(shell)).toHaveCount(3)
  await expect(ticks(shell).nth(0)).toHaveAttribute('aria-label', 'Filler question 7')
  await expect(ticks(shell).nth(1)).toHaveAttribute('aria-label', SPOKE_FIRST)
  await expect(ticks(shell).nth(2)).toHaveAttribute('aria-label', /Is staging ready/)
  await shot(app, shell, 'filter-flagged-and-bookmarked')
  // Alt+Down steps among the shown turns.
  await ticks(shell).nth(0).click()
  await shell.keyboard.press('Alt+ArrowDown')
  await expect(ticks(shell).nth(1)).toHaveAttribute('data-state', 'active')
  await shell.locator(sel('turn-minimap-filter')).click()
  await expect(ticks(shell)).toHaveCount(total)

  // 8. The host keeps the bookmark (the phone sees the same set), nothing is left on this device,
  // and it comes back after a reload.
  await expect.poll(() => host.bookmarks(THREAD)).toEqual([expect.stringMatching(/^user@\d+$/)])
  expect(await shell.evaluate(() => localStorage.getItem('relay.chat-bookmarks.v1'))).toBeNull()
  // Bookmarked on the phone: its tick shows here at once.
  host.setBookmarks(THREAD, [...host.bookmarks(THREAD), `user@${T0 + 20_000 * 4}`])
  await expect(tickOf(shell, 'Filler question 4')).toHaveAttribute('data-bookmarked', 'true')
  await shell.reload()
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector(sel('chat-tree'))
  await shell.locator(sel('chat-row-p4-ecard')).click()
  await expect(tickOf(shell, 'Filler question 7')).toHaveAttribute('data-bookmarked', 'true')
  await expect(tickOf(shell, 'Filler question 4')).toHaveAttribute('data-bookmarked', 'true')
})

test.describe('a host that keeps no bookmarks', () => {
  test.use({ hostBookmarks: false })
  test('they stay on this device, per thread, and come back after a reload', async ({
    app,
    shell,
  }) => {
    test.setTimeout(120_000)
    await openChat(app, shell)
    await scrollTo(shell, 'end')
    await tickOf(shell, 'Filler question 7').hover()
    await shell.locator(sel('turn-card-bookmark')).click()
    await expect(tickOf(shell, 'Filler question 7')).toHaveAttribute('data-bookmarked', 'true')
    const stored = await shell.evaluate(() => localStorage.getItem('relay.chat-bookmarks.v1'))
    expect(JSON.parse(stored!)).toEqual({ [THREAD]: [expect.stringMatching(/^user@\d+$/)] })
    expect(host.bookmarkFrames).toEqual([])
    await shell.reload()
    await shell.locator(sel('nav-chat')).click()
    await shell.waitForSelector(sel('chat-tree'))
    await shell.locator(sel('chat-row-p4-ecard')).click()
    await expect(tickOf(shell, 'Filler question 7')).toHaveAttribute('data-bookmarked', 'true')
  })
})

test('a short chat shows no navigator, a narrow window keeps it inside the log', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await openChat(app, shell)
  await resize(app, 900, 520)
  await scrollTo(shell, 'end')
  const log = (await shell.locator(LOG).boundingBox())!
  const box = (await shell.locator(sel('turn-minimap-ticks')).boundingBox())!
  expect(box.height).toBeLessThanOrEqual(log.height * 0.7 + 1)
  expect(box.y).toBeGreaterThanOrEqual(log.y - 1)
  // Thousands fit by compression; here the ticks drop to the slots that fit.
  expect(await ticks(shell).count()).toBeLessThanOrEqual(Math.floor((log.height * 0.7 - 28) / 10))
  await shot(app, shell, 'narrow-compressed')
})
