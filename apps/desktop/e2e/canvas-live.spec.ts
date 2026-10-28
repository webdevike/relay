import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'

// A live canvas from a chat: the session file's `relay-canvas` start entry is a Join card; Join
// opens the board's live room (the host's page in a frame) in the same tab; Back to chat returns
// to the same transcript offset with the unsent draft still in the composer. A fake host on a real
// WebSocket stands in for Relay and serves a tiny room page; no real session is touched.
let fx: ChatFixture
let host: FakeRelayHost
const AGENT = { name: 'Nova', color: '#7c5cff' }
const ROOM = {
  id: 'room-1',
  slug: 'mind-map',
  board: 'Mind map',
  live: true,
  agent: AGENT,
  chat: { sessionId: 'p4-canvas' },
  humans: [],
  startedAt: Date.now(),
}

/** A long chat with the Join card in the middle, so the log scrolls both above and below it. */
function canvasSession(): string {
  const lines: unknown[] = [
    { type: 'title', v: 1, title: 'Plan the onboarding', updatedAt: Date.now() },
    {
      type: 'session',
      version: 3,
      id: 'p4-canvas',
      timestamp: new Date().toISOString(),
      cwd: '/fixture/eva-root',
    },
  ]
  let parent: string | null = null
  const add = (entry: Record<string, unknown>): void => {
    const id = `e${lines.length}`
    lines.push({ ...entry, id, parentId: parent })
    parent = id
  }
  const turns = (n: number, from: number): void => {
    for (let i = from; i < from + n; i++) {
      add({
        type: 'message',
        message: { role: 'user', content: `Question ${i}`, attribution: 'user' },
      })
      add({
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          content: [
            { type: 'text', text: `Answer ${i}. ${'Some detail about the flow. '.repeat(6)}` },
          ],
          stopReason: 'stop',
        },
      })
    }
  }
  turns(20, 1)
  add({
    type: 'custom_message',
    customType: 'relay-canvas',
    content: 'Nova opened a live canvas on Mind map.',
    display: true,
    details: {
      kind: 'start',
      roomId: ROOM.id,
      slug: ROOM.slug,
      board: ROOM.board,
      agent: AGENT,
      text: 'Sketch the onboarding flow together',
    },
  })
  turns(20, 21)
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-06T03-00-00-000Z_p4-canvas.jsonl'),
      canvasSession(),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.setCanvasRooms([ROOM])
    await use({ ...fx.launchEnv, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`
/** The transcript's scroller (virtua's VList root). */
const scrollTop = (shell: Page): Promise<number> =>
  shell.evaluate(
    () => document.querySelector('[data-testid="chat-log"]')!.firstElementChild!.scrollTop,
  )

/** Scrolls the transcript up from the end until the Join card is on screen, mid-log. */
async function scrollToCard(shell: Page): Promise<void> {
  await expect(async () => {
    await shell.evaluate(() => {
      const c = document.querySelector('[data-testid="canvas-start"]')
      if (c) c.scrollIntoView({ block: 'center' })
      else document.querySelector('[data-testid="chat-log"]')!.firstElementChild!.scrollTop -= 600
    })
    await expect(shell.locator('[data-testid="canvas-start"]')).toBeInViewport({ timeout: 300 })
  }).toPass({ timeout: 20_000 })
}

test('Join opens the live room in the same tab and Back to chat restores scroll and draft', async ({
  shell,
}) => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector(sel('chat-tree'))
  await shell.locator(sel('chat-row-p4-canvas')).click()
  const log = shell.locator(sel('chat-log'))
  await expect(log).toContainText('Answer 40.')

  // An unsent draft, and the transcript scrolled up to the Join card (mid-log, not the end).
  const draft = 'Remember to ask about the login step'
  await shell.locator(sel('composer-input')).fill(draft)
  const card = shell.locator(sel('canvas-start'))
  await scrollToCard(shell)
  await expect(card).toContainText('Join Nova on Mind map')
  await expect(card).toContainText('Sketch the onboarding flow together')
  // Let the list settle, then note where it is.
  await shell.waitForTimeout(300)
  const before = await scrollTop(shell)
  const atEnd = await shell.evaluate(() => {
    const s = document.querySelector('[data-testid="chat-log"]')!.firstElementChild!
    return s.scrollHeight - s.clientHeight
  })
  expect(before).toBeGreaterThan(200)
  expect(before).toBeLessThan(atEnd - 200)

  await card.getByRole('button', { name: 'Join' }).click()

  // The board's live room, in the same tab: the host's page in a frame, the chat hidden.
  const live = shell.locator(sel('canvas-live'))
  await expect(live).toHaveAttribute('data-slug', 'mind-map')
  await expect(shell.locator(sel('chat-pane'))).toBeHidden()
  await expect(live.locator(sel('canvas-title'))).toHaveText('Mind map')
  await expect(live.locator(sel('canvas-live-agent'))).toContainText('Live with Nova')
  const frame = shell.frameLocator(sel('canvas-live-frame'))
  await expect(frame.locator(sel('fake-room'))).toHaveText('Room mind-map')
  expect(host.canvasOpens).toEqual(['mind-map'])
  expect(host.roomPages).toHaveLength(1)
  expect(host.roomPages[0]).toMatch(
    /^\/canvas\/mind-map\/\?token=fake-mind-map&embed=desktop&theme=(light|dark)$/,
  )
  type Tabs = { __evaosShell: { tabs(): { active: number; list: unknown[] } } }
  expect(
    await shell.evaluate(() => (window as unknown as Tabs).__evaosShell.tabs().list.length),
  ).toBe(1)
  await expect(shell.locator(sel('canvas-board'))).toHaveCount(0)

  await shell.locator(sel('canvas-live-back')).click()

  // The chat exactly as it was: same offset, same draft.
  await expect(shell.locator(sel('chat-pane'))).toBeVisible()
  await expect(shell.locator(sel('composer-input'))).toHaveValue(draft)
  await expect.poll(() => scrollTop(shell)).toBeGreaterThan(before - 2)
  expect(Math.abs((await scrollTop(shell)) - before)).toBeLessThanOrEqual(2)
  await expect(card).toBeInViewport()

  // The room ends: the card says so and offers the board instead.
  host.setCanvasRooms([{ ...ROOM, live: false, endedAt: Date.now() }])
  await expect(card).toContainText('Ended')
  await expect(card.getByRole('button', { name: 'Join' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Open board' }).click()
  await expect(shell.locator(`${sel('canvas-board')}[data-slug="mind-map"]`)).toBeVisible()
})

test('a room that ends while open says so, and Open board brings the board back', async ({
  shell,
}) => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector(sel('chat-tree'))
  await shell.locator(sel('chat-row-p4-canvas')).click()
  const card = shell.locator(sel('canvas-start'))
  await scrollToCard(shell)
  await card.getByRole('button', { name: 'Join' }).click()
  await expect(shell.frameLocator(sel('canvas-live-frame')).locator(sel('fake-room'))).toBeVisible()

  host.setCanvasRooms([{ ...ROOM, live: false, endedAt: Date.now() }])
  const ended = shell.locator(sel('canvas-live-ended'))
  await expect(ended).toContainText('This canvas session ended.')
  await expect(shell.locator(sel('canvas-live-agent'))).toContainText('Ended with Nova')
  await shell.locator(sel('canvas-live-board')).click()
  await expect(shell.locator(`${sel('canvas-board')}[data-slug="mind-map"]`)).toBeVisible()
})
