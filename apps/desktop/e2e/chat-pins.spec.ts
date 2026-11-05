// Dynamic pins in a chat: a quiet "Pinned" rail in the right gutter (fixed beside the log, never in
// its scroll), a pin count button and popover when the window is narrow, Isaac's pin actions
// (whole message, selected text, hover on a link / code span / number), an assistant's pin by a
// `[[pin: label | value]]` line in its reply (hidden from the text; the fake host reads the
// transcript the way the real host's artifact reader does, which its own unit tests cover), Copy
// with a check, Open with the click rules, unpin, and scroll-to-source from the label. Saves
// screenshots to proof/chat-pins/ (EVAOS_PROOF=1).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   EVAOS_PROOF=1 pnpm -C apps/desktop exec playwright test e2e/chat-pins.spec.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

const OUT = path.join(REPO_ROOT, 'proof', 'chat-pins')
const THREAD = 'session:p4-ecard'
const T0 = 1792486874000
const REPLY_AT = T0 + 6000
const LINK = 'https://stg.example.com/login'
const PR = 'https://github.com/o/r/pull/12'

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
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

const REPLY_TEXT = [
  `Staging is up. Log in at ${LINK} with order number 884412, run \`bun deploy --prod\` when ready, and review [the PR](${PR}).`,
  `[[pin: Staging login | ${LINK}]]`,
  '[[pin: Deploy | `bun deploy --prod`]]',
].join('\n')

/** The chat open on p4-ecard with a long thread: Isaac's prompt, the reply with the pin lines, then filler. */
async function openChat(app: ElectronApplication, shell: Page): Promise<void> {
  await fx.append('p4-ecard', prompt('u2', 'a1', 'Is staging ready for the order check?', T0))
  await fx.append('p4-ecard', reply('a2', 'u2', REPLY_TEXT, REPLY_AT))
  let parent = 'a2'
  for (let i = 0; i < 14; i++) {
    const id = `f${i}`
    await fx.append(
      'p4-ecard',
      prompt(`${id}u`, parent, `Filler question ${i}`, REPLY_AT + 1000 * (2 * i + 1)),
    )
    await fx.append(
      'p4-ecard',
      reply(
        `${id}a`,
        `${id}u`,
        `Filler answer ${i}. Nothing to pin here, just a few lines so the log scrolls.`,
        REPLY_AT + 1000 * (2 * i + 2),
      ),
    )
    parent = `${id}a`
  }
  host.upsert({ id: 'p4-ecard', status: 'idle' })
  await resize(app, 1900, 1000)
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector(sel('chat-tree'))
  await shell.locator(sel('chat-row-p4-ecard')).click()
  await expect(shell.locator(LOG)).toContainText('Filler answer')
  // What the host's transcript reader makes of the reply's two pin lines (by the chat's assistant).
  host.pinsFromTranscript(THREAD, fx.file('p4-ecard'), 'assistant')
  // Nothing real reaches the system clipboard in a test.
  await shell.evaluate(() => {
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void w.__copied.push(t) },
      configurable: true,
    })
  })
}

const copied = (shell: Page): Promise<string[]> =>
  shell.evaluate(() => (window as unknown as { __copied: string[] }).__copied)

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
  const tmp = await proofShot(app, shell, name, { phase: 'chat-pins' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

const pinRows = (shell: Page) =>
  shell.locator(`${sel('pins-rail')} [data-testid^="pin-"][data-kind]`)

test('an assistant pins with a reply line, Isaac pins messages, selections and inline things, and the rail stays put', async ({
  app,
  shell,
}) => {
  test.setTimeout(180_000)
  await openChat(app, shell)
  await scrollTo(shell, 'top')

  // 1. The reply's pin lines never show, and the host made them pins "by the assistant".
  const bubble = shell.locator(sel('bubble-a2'))
  await expect(bubble).toContainText('Staging is up.')
  await expect(shell.locator(LOG)).not.toContainText('[[pin')
  const rail = shell.locator(sel('pins-rail'))
  await expect(rail).toBeVisible()
  await expect(pinRows(shell)).toHaveCount(2)
  const login = rail.locator('[data-kind=link]')
  await expect(login.getByTestId('pin-label')).toHaveText('Staging login')
  await expect(login.getByTestId('pin-value')).toHaveText(LINK)
  await expect(rail.locator('[data-kind=code] [data-testid=pin-value]')).toHaveAttribute(
    'data-mono',
    'true',
  )
  await expect(login.getByRole('img', { name: /^Pinned by/ })).toHaveAttribute(
    'data-by',
    'assistant',
  )
  await shot(app, shell, 'assistant-markup-pin')

  // 2. Isaac pins: a PR link (hover pin), a number (selection) and the whole message (bubble pin).
  const prLink = bubble.getByRole('link', { name: 'the PR' })
  await prLink.hover()
  const inline = shell.locator(sel('pin-inline'))
  await expect(inline).toBeVisible()
  await inline.click()
  await expect(rail.locator('[data-kind=pr]')).toHaveCount(1)
  const number = await bubble.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n.textContent ?? '').indexOf('884412')
      if (at < 0) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + 6)
      const b = r.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    return null
  })
  expect(number).not.toBeNull()
  await shell.mouse.dblclick(number!.x, number!.y)
  const selection = shell.locator(sel('pin-selection'))
  await expect(selection).toBeVisible()
  await expect(selection).toHaveText('Pin selection')
  await selection.click()
  await expect(rail.locator('[data-kind=number] [data-testid=pin-value]')).toHaveText('884412')
  await bubble.hover()
  await shell.locator(sel('pin-btn-a2')).click()
  await expect(rail.locator('[data-kind=message]')).toHaveCount(1)
  await expect(rail.locator('[data-kind=message] [data-testid=pin-label]')).toContainText(
    'Staging is up.',
  )
  await expect(rail.locator(`[data-kind=number] ${sel('pin-label')}`)).toHaveAttribute(
    'data-static',
    '',
  )
  const acts = host.artifactActs.map(
    (f) => (f['action'] as { op: string; kind?: string }).kind ?? '',
  )
  expect(acts.filter(Boolean)).toEqual(['pr', 'number', 'message'])
  expect(host.artifactActs.every((f) => f['by'] === 'isaac')).toBe(true)
  await expect(pinRows(shell)).toHaveCount(5)
  // Isaac's own pins wear his mark, the assistant's its own; pins are newest first.
  await expect(
    rail.locator('[data-kind=message]').getByRole('img', { name: 'Pinned by Isaac' }),
  ).toHaveCount(1)
  await expect(pinRows(shell).first()).toHaveAttribute('data-kind', 'message')

  // 3. A code span and an inline number get the tiny hover pin too (code here; the number is covered by the selection).
  await bubble.locator('code').first().hover()
  await expect(inline).toBeVisible()
  await shell.mouse.move(5, 5)

  // 4. The rail sits right of the message column, aligned with it, and does not move when the log scrolls.
  const column = (await shell.locator('.eva-row-inner').first().boundingBox())!
  const before = (await rail.boundingBox())!
  expect(before.x).toBeGreaterThanOrEqual(column.x + column.width)
  expect(before.x - (column.x + column.width)).toBeLessThanOrEqual(40)
  await scrollTo(shell, 'end')
  const after = (await rail.boundingBox())!
  expect(after).toEqual(before)
  await expect(shell.locator(sel('msg-f13a'))).toBeVisible()
  await shot(app, shell, 'rail-mixed-pins')

  // 5. Copy writes the value and shows a check; Open follows the click rules.
  const code = rail.locator('[data-kind=code]')
  await code.hover()
  await code.getByTestId('pin-copy').click()
  expect(await copied(shell)).toEqual(['bun deploy --prod'])
  await expect(code).toHaveAttribute('data-copied', 'true')
  await expect(code.getByTestId('pin-copy')).toHaveAttribute('aria-label', 'Copied')
  await shot(app, shell, 'copy-feedback')
  await expect(code).not.toHaveAttribute('data-copied', 'true', { timeout: 4000 })
  await expect(rail.locator('[data-kind=number]').getByTestId('pin-open')).toHaveCount(0)
  await expect(login.getByTestId('pin-open')).toHaveCount(1)

  // 6. The label takes the log back to its message and flashes it.
  await login.getByTestId('pin-label').click()
  await expect(shell.locator(sel('msg-a2'))).toBeVisible()
  await expect(shell.locator(sel('msg-a2'))).toHaveAttribute('data-flash', 'true')
  await expect(rail.locator('[data-kind=link]')).toBeVisible()

  // 7. Unpin: the x removes a pin everywhere; the same value pinned again is one pin.
  await code.hover()
  await code.getByTestId('pin-unpin').click()
  await expect(rail.locator('[data-kind=code]')).toHaveCount(0)
  await expect(pinRows(shell)).toHaveCount(4)
  const unpinned = host.artifactActs.at(-1)!['action'] as { op: string; pinned?: boolean }
  expect(unpinned).toMatchObject({ op: 'pin', pinned: false })
})

test('pins outgrowing the height scroll the rail on its own', async ({ app, shell }) => {
  test.setTimeout(120_000)
  await openChat(app, shell)
  for (let i = 0; i < 24; i++) {
    host.actArtifacts(THREAD, 'isaac', {
      op: 'pin.add',
      kind: 'number',
      label: `Order ${i}`,
      value: String(100000 + i),
    })
  }
  const rail = shell.locator(sel('pins-rail'))
  await expect(pinRows(shell)).toHaveCount(26)
  const grows = await rail.evaluate((el) => el.scrollHeight > el.clientHeight + 40)
  expect(grows).toBe(true)
  const log = shell.locator(LOG)
  const logTop = await log.evaluate((el) => (el.firstElementChild as HTMLElement).scrollTop)
  const box = (await rail.boundingBox())!
  await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await shell.mouse.wheel(0, 400)
  await expect.poll(() => rail.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  // The chat did not move, and the rail's box did not either.
  expect(await log.evaluate((el) => (el.firstElementChild as HTMLElement).scrollTop)).toBe(logTop)
  expect(await rail.boundingBox()).toEqual(box)
  await shot(app, shell, 'rail-scrolls-alone')
})

test('a narrow window folds the rail into a pin count button with the same list', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await openChat(app, shell)
  await expect(shell.locator(sel('pins-rail'))).toBeVisible()
  await expect(shell.locator(sel('pins-button'))).toHaveCount(0)
  await resize(app, 1100, 900)
  await expect(shell.locator(sel('pins-rail'))).toHaveCount(0)
  const button = shell.locator(sel('pins-button'))
  await expect(button).toBeVisible()
  await expect(button).toHaveText('2')
  host.actArtifacts(THREAD, 'isaac', {
    op: 'pin.add',
    kind: 'file',
    label: 'Notes',
    value: '/Users/ike/Eva/notes.md',
  })
  await expect(button).toHaveText('3')
  await button.click()
  const pop = shell.locator(sel('pins-popover'))
  await expect(pop).toBeVisible()
  await expect(pop.locator('[data-testid^="pin-"][data-kind]')).toHaveCount(3)
  await expect(pop.locator('[data-kind=file] [data-testid=pin-open]')).toHaveCount(1)
  await shot(app, shell, 'narrow-popover')
  // The popover's rows work: Copy, and a label closes it on its way to the message.
  const first = pop.locator('[data-kind=link]')
  await first.hover()
  await first.getByTestId('pin-copy').click()
  expect(await copied(shell)).toEqual([LINK])
  await first.getByTestId('pin-label').click()
  await expect(pop).toHaveCount(0)
  // Wide again: the rail is back and the button is gone.
  await resize(app, 1900, 1000)
  await expect(shell.locator(sel('pins-rail'))).toBeVisible()
  await expect(button).toHaveCount(0)
})
