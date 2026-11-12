import type { Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'
import { startThrowawayHost, type ThrowawayHost } from './helpers/throwaway-host'

// '/' and the Comment button on both Canvas surfaces. The desktop Canvas page with no live room
// saves pins and threads into the board file, and each comment goes to the chat that owns the board
// as Isaac's note (a comment that names @Nova is hers); in a live room the host's page takes '/'
// wherever focus sits and shows the Comment button with its shortcut hint. The host is the real
// room page, board file and canvas service with a scripted mind (apps/linux
// test/canvas-throwaway-host.ts), never the live one. The registry (what `@` lists) holds Nova.
const PROOF = path.join(REPO_ROOT, 'proof', 'slash-comment')
let host: ThrowawayHost

const test = base.extend({
  launchEnv: async ({}, use) => {
    const evaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-eva-'))
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({ agents: [{ id: 'nova', title: 'Nova', scope: 'Personal' }] }),
    )
    host = await startThrowawayHost()
    await use({ ...host.env, EVAOS_EVA_ROOT: evaRoot, EVAOS_AGENT_CONTROL: '1' })
    await host.stop()
    fs.rmSync(evaRoot, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false, colorScheme: 'dark' })

const sel = (id: string): string => `[data-testid=${id}]`
const board = (): {
  threads?: Array<{
    id: string
    node?: string
    x: number
    y: number
    resolved?: boolean
    assignee?: string
    messages: Array<{ kind: string; name: string; text: string }>
  }>
  nodes: Array<{ id: string }>
} => JSON.parse(fs.readFileSync(path.join(host.canvasDir, 'mind-map.json'), 'utf8'))

const shot = async (shell: Page, name: string): Promise<void> => {
  fs.mkdirSync(PROOF, { recursive: true })
  await shell.screenshot({ path: path.join(PROOF, name) })
}

async function openBoard(shell: Page): Promise<void> {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  await shell.locator(sel('nav-canvas')).click()
  await shell.locator(sel('canvas-row-mind-map')).click()
  await expect(shell.locator(sel('canvas-board'))).toHaveAttribute('data-slug', 'mind-map')
  await expect(shell.locator(sel('canvas-status'))).toContainText('saved')
  await expect(shell.locator('.react-flow__node').first()).toBeVisible()
}

/** A point on bare board (the pane itself, no card, no chrome), in page coordinates. */
async function emptySpot(shell: Page): Promise<{ x: number; y: number }> {
  const spot = await shell.evaluate(() => {
    const pane = document.querySelector('.eva-cv-flow')!.getBoundingClientRect()
    for (let y = pane.top + 80; y < pane.bottom - 80; y += 24) {
      for (let x = pane.left + 24; x < pane.right - 24; x += 24) {
        const el = document.elementFromPoint(x, y)
        if (el?.classList.contains('react-flow__pane')) return { x, y }
      }
    }
    return null
  })
  if (!spot) throw new Error('no bare board to point at')
  return spot
}

test('the Canvas page with no live room: / drops a pin on the selected card, on nothing, and right after a click, saved in the board file', async ({
  shell,
}) => {
  await openBoard(shell)
  const card = shell.locator('.react-flow__node').first()
  const cardId = (await card.getAttribute('data-id'))!
  await expect(shell.locator(sel('canvas-pin'))).toHaveCount(0)

  // The tooltip names the key.
  await shell.locator(sel('canvas-tool-comment')).hover()
  await expect(shell.getByRole('tooltip')).toHaveText('Comment (press /)')
  await expect(shell.locator(sel('canvas-tool-comment'))).toHaveAttribute('aria-keyshortcuts', '/')

  // A card selected: the pin goes on it.
  await card.click()
  await expect(card).toHaveClass(/selected/)
  await shell.keyboard.press('/')
  const draft = shell.locator(`${sel('canvas-thread')}[data-thread=draft]`)
  await expect(draft).toBeVisible()
  await shot(shell, 'after-1-slash-on-selected-card.png')
  await draft.locator(sel('canvas-thread-new-input')).fill('Is this still the Q4 plan?')
  await shell.keyboard.press('Enter')
  const pin = shell.locator(sel('canvas-pin')).first()
  await expect(pin).toHaveAttribute('data-open', 'true')
  await expect(shell.locator(sel('canvas-thread'))).toContainText('Is this still the Q4 plan?')
  const saved = board().threads
  expect(saved).toHaveLength(1)
  expect(saved![0]).toMatchObject({
    node: cardId,
    messages: [{ kind: 'human', text: 'Is this still the Q4 plan?' }],
  })
  await shot(shell, 'after-2-thread-saved.png')
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('canvas-thread'))).toHaveCount(0)

  // Nothing selected: the pin goes where the pointer is, on the board itself.
  const spot = await emptySpot(shell)
  await shell.mouse.click(spot.x, spot.y)
  await expect(card).not.toHaveClass(/selected/)
  await shell.mouse.move(spot.x, spot.y)
  await shell.keyboard.press('/')
  await expect(draft).toBeVisible()
  await draft.locator(sel('canvas-thread-new-input')).fill('Park this here')
  await shell.keyboard.press('Enter')
  await expect.poll(() => board().threads?.length).toBe(2)
  expect(board().threads![1]).toMatchObject({ messages: [{ text: 'Park this here' }] })
  expect(board().threads![1]!.node).toBeUndefined()
  await shell.keyboard.press('Escape')

  // Right after clicking the board (focus sits on it), and again by the button.
  await shell.mouse.click(spot.x, spot.y)
  await shell.keyboard.press('/')
  await expect(draft).toBeVisible()
  await shell.keyboard.press('Escape')
  await expect(draft).toHaveCount(0)
  await shell.locator(sel('canvas-tool-comment')).click()
  await expect(draft).toBeVisible()
  await shell.keyboard.press('Escape')
  // Nothing saved by the drafts nobody sent; the cards and the earlier threads are untouched.
  expect(board().threads).toHaveLength(2)

  // Pins show on the board; a thread takes a reply and resolves.
  await expect(shell.locator(sel('canvas-pin'))).toHaveCount(2)
  await shell
    .locator(`${sel('canvas-pin')}`)
    .first()
    .click()
  const reply = shell.locator(sel('canvas-thread-reply-input'))
  await reply.fill('Yes, until review')
  await shell.keyboard.press('Enter')
  await expect.poll(() => board().threads![0]!.messages.length).toBe(2)
  await shell.locator(sel('canvas-thread-resolve')).click()
  await expect.poll(() => board().threads![0]!.resolved).toBe(true)
  await expect(shell.locator(sel('canvas-pin'))).toHaveCount(1)
})

/** Runs agent action `action` as Nova's thread through the app's agent-control server. */
async function run(
  configDir: string,
  action: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string }> {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params, scope: 'agent:nova' }),
  })
  return (await res.json()) as { ok: boolean; message?: string }
}

test('a comment that names @Nova is hers and goes to the chat as a note; / works with focus anywhere in a live room', async ({
  shell,
  configDir,
}) => {
  await openBoard(shell)
  await shell.locator('.react-flow__node').first().click()
  await shell.keyboard.press('/')
  const input = shell.locator(sel('canvas-thread-new-input'))
  // `@` lists the registry's assistants; Enter picks one and the comment goes on after it.
  await input.pressSequentially('@No')
  await expect(shell.locator(sel('canvas-mention-option'))).toHaveText(['NovaPersonal'])
  await shot(shell, 'after-3-mention-nova.png')
  await shell.keyboard.press('Enter')
  await expect(input).toHaveValue('@Nova ')
  await input.pressSequentially('Can you tighten this?')
  await shell.keyboard.press('Enter')

  // The thread is Nova's; the comment goes to her chat as Isaac's note and the thread says how
  // that went (sent, or why not), quietly under the reply field.
  await expect.poll(() => board().threads?.[0]?.assignee).toBe('nova')
  await expect
    .poll(() => board().threads![0]!.messages.map((m) => `${m.name}: ${m.text}`))
    .toEqual(['Isaac: @Nova Can you tighten this?'])
  await expect(
    shell.locator(`${sel('canvas-thread-note')}, ${sel('canvas-thread-note-error')}`),
  ).toBeVisible()
  await expect(shell.getByText('Sending to chat')).toHaveCount(0)
  await shot(shell, 'after-4-note.png')

  // An agent starts a live room on the board (the older room mode): the board gives way to it,
  // carrying the open thread over.
  const started = await run(configDir, 'canvas.live', { slug: 'mind-map', prompt: 'Tighten it' })
  expect(started.ok, started.message).toBe(true)
  await expect(shell.locator(sel('canvas-live'))).toHaveAttribute('data-slug', 'mind-map')
  const room = shell.frameLocator(sel('canvas-live-frame'))
  await expect(room.locator('.cv-fab')).toBeVisible()
  await expect(room.locator('.cv-fab')).toHaveAttribute('title', 'Comment (press /)')
  await expect(room.locator(sel('canvas-thread'))).toContainText('Can you tighten this?')
  await shot(shell, 'after-4-room-thread.png')
  // Focus outside the frame (the header): '/' still opens the comment in the room.
  await room.getByRole('button', { name: 'Close' }).click()
  await expect(room.locator(sel('canvas-thread'))).toHaveCount(0)
  await shell.locator(sel('canvas-title')).click()
  await shell.keyboard.press('/')
  const composer = room.getByLabel('Comment for Nova')
  await expect(composer).toBeVisible()
  await shot(shell, 'after-5-room-slash-from-header.png')
  await composer.press('Escape')
  await expect(composer).toHaveCount(0)

  // Focus inside the frame (right after clicking the board): the page takes it itself.
  await room.locator('.react-flow__pane').click({ position: { x: 40, y: 400 } })
  await shell.keyboard.press('/')
  await expect(composer).toBeVisible()
})
