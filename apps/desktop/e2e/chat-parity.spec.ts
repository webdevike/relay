// An assistant's thread is a chat like any other: Astra's thread (Relay lists it, omp writes its
// file) and a normal chat hold the same reply, prose plus an ```openui widget plus two images shared
// as Relay drops, and both draw it the same way through the one chat pane (same widget, same
// clickable images, same composer). A click on a reply's image opens it full size in the image
// viewer; Esc and a click outside close it. Screenshots go to proof/chat-parity/: astra-thread.png,
// normal-chat.png, image-overlay.png.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/chat-parity.spec.ts
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, FIXTURES_DIR, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

const OUT = path.join(REPO_ROOT, 'proof', 'chat-parity')
const MEDIA = path.join(FIXTURES_DIR, 'agent-widgets/media')
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

const REPLY = [
  'Here is where the Platform Assets work stands.',
  '',
  '```openui',
  'root = Card([stats, Divider(), status], "Platform Assets")',
  'stats = Stack([Stat("Open tickets", "12"), Stat("In review", "1", Delta("2", "down"))], "horizontal")',
  'status = Rows([Row("ENG-6406", "In Review", "accent"), Row("ENG-6545", "In QA", "warn")])',
  '```',
  '',
  'Before and after:',
  '',
  '![Before the fix](/drops/img1/tok1)',
  '![After the fix](/drops/img2/tok2)',
].join('\n')

const line = (entry: unknown): string => JSON.stringify(entry)

/** One session file: a prompt and the shared reply. */
function sessionLines(id: string, title: string, cwd: string): string {
  const at = (m: number): string => new Date(Date.now() - (10 - m) * 60_000).toISOString()
  return (
    [
      line({ type: 'title', v: 1, title, source: 'auto', updatedAt: at(0) }),
      line({ type: 'session', version: 3, id, timestamp: at(0), cwd }),
      line({
        type: 'message',
        id: `${id}-u1`,
        parentId: null,
        timestamp: at(1),
        message: { role: 'user', content: [{ type: 'text', text: 'Where does it stand?' }] },
      }),
      line({
        type: 'message',
        id: `${id}-a1`,
        parentId: `${id}-u1`,
        timestamp: at(2),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: REPLY }],
          stopReason: 'stop',
        },
      }),
    ].join('\n') + '\n'
  )
}

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' }],
      }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    // A small shot (240 px wide, drawn at its own size) and a screenshot-sized one (1440 px, drawn
    // at the column's width and full size in the viewer).
    for (const [drop, name, width] of [
      ['/drops/img1/tok1', 'before', 240],
      ['/drops/img2/tok2', 'after', 1440],
    ] as const) {
      const out = path.join(fx.root, `${name}.png`)
      const scale = `scale=${width}:-1:flags=neighbor`
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-i',
        path.join(MEDIA, `${name}.png`),
        '-vf',
        scale,
        out,
      ])
      host.serveFile(drop, fs.readFileSync(out), 'image/png')
    }
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-29T09-00-00-000Z_astra-1.jsonl'),
      sessionLines('astra-1', 'Astra', evaRoot),
    )
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-29T09-10-00-000Z_parity-chat.jsonl'),
      sessionLines('parity-chat', 'Parity check', evaRoot),
    )
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false, reducedMotion: 'reduce' })

type MainGlobal = {
  __evaosTest: { win: { setContentSize(w: number, h: number): void } }
}

const frames = (shell: Page): Promise<void> =>
  shell.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )

async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  await frames(shell)
  const tmp = await proofShot(app, shell, name, { phase: 'chat-parity' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

/** The reply as drawn: its widget, its images loaded, and the shape of its row. */
async function replyShape(log: Locator) {
  const row = log.locator('.eva-row', { hasText: 'Here is where the Platform Assets work stands.' })
  await expect(row.getByTestId('widget')).toHaveAttribute('data-widget', 'card')
  const images = row.getByTestId('md-image')
  await expect(images).toHaveCount(2)
  for (const img of await images.locator('img').all())
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0)
  // Its top at the top of the log, so a screenshot shows the widget and the images under it.
  await row.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  return row.evaluate((el) => {
    const tags: string[] = []
    const walk = (n: Element): void => {
      tags.push(`${n.tagName}.${[...n.classList].filter((c) => !c.startsWith('m_')).join('.')}`)
      for (const c of n.children) walk(c)
    }
    walk(el)
    return tags.join(' ')
  })
}

test("Astra's thread draws a reply exactly like a normal chat; a clicked image opens full size", async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(w, h),
    [1280, 1000] as const,
  )
  const log = shell.locator(LOG)
  const composer = shell.locator('[data-testid=chat-pane] [data-testid=composer-input]')

  // Relay lists Astra's thread: her page is the conversation in the chat pane.
  host.upsert({
    id: 'astra-1',
    status: 'idle',
    kind: 'assistant',
    assistant: 'astra',
    title: 'Astra',
  })
  await shell.getByTestId('nav-assistants').click()
  await shell.getByTestId('sidebar-agent-astra').click()
  await expect(shell.getByTestId('agent-crumb')).toBeVisible()
  await expect(log).toContainText('Here is where the Platform Assets work stands.', {
    timeout: 15_000,
  })
  const astra = await replyShape(log)
  await expect(composer).toBeVisible()
  await shot(app, shell, 'astra-thread')

  // A click on an image opens it full size among the message's images; Esc closes it, and so does a
  // click outside.
  await log.getByRole('button', { name: 'Open After the fix' }).click()
  const viewer = shell.getByAltText('Image 2 of 2')
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveAttribute('src', /drops%2Fimg2%2Ftok2/)
  await expect.poll(() => viewer.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1440)
  await shot(app, shell, 'image-overlay')
  await shell.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await log.getByRole('button', { name: 'Open Before the fix' }).click()
  await expect(shell.getByAltText('Image 1 of 2')).toHaveAttribute('src', /drops%2Fimg1%2Ftok1/)
  await shell.mouse.click(8, 500)
  await expect(shell.getByAltText('Image 1 of 2')).toHaveCount(0)

  // The same reply in a normal chat draws the same row, element for element.
  // The sidebar shows the Assistants list now; back to the main one.
  await shell.getByTestId('sidebar-back').click()
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: /^Parity check/ })
    .click()
  await expect(shell.getByTestId('chat-header')).toContainText('Parity check')
  await expect(log).toContainText('Here is where the Platform Assets work stands.')
  const normal = await replyShape(log)
  await expect(composer).toBeVisible()
  await shot(app, shell, 'normal-chat')
  expect(astra).toBe(normal)
})
