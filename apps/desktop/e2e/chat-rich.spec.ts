// Rich reply content works the same wherever a reply is drawn: an assistant's thread, a normal
// chat and a subagent's transcript each draw the one reply below with its compare slider (before
// and after images served as Relay drops), a ```ui widget, an OpenUI card, a mantine page and
// inline images, and never show any of them as raw code. Screenshots go to proof/chat-rich/.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/chat-rich.spec.ts
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, FIXTURES_DIR, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

const OUT = path.join(REPO_ROOT, 'proof', 'chat-rich')
const MEDIA = path.join(FIXTURES_DIR, 'agent-widgets/media')
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

const LEAD = 'Here is the before and after.'
const REPLY = [
  LEAD,
  '',
  '```openui',
  'root = Compare(Side("/drops/img1/tok1", "Before"), Side("/drops/img2/tok2", "After"), "Header fix")',
  '```',
  '',
  '```openui',
  'root = Card([Stat("Open tickets", "12"), Text("In review: 1")], "Platform Assets")',
  '```',
  '',
  '```ui',
  '{"widget":"badge","label":"Dev green","tone":"ok"}',
  '```',
  '',
  '```mantine-widget',
  '<Button>Approve</Button>',
  '```',
  '',
  '![Before the fix](/drops/img1/tok1)',
].join('\n')

const line = (entry: unknown): string => JSON.stringify(entry)

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
        message: { role: 'user', content: [{ type: 'text', text: 'Show me before and after.' }] },
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
    for (const [drop, name, width] of [
      ['/drops/img1/tok1', 'before', 480],
      ['/drops/img2/tok2', 'after', 480],
    ] as const) {
      const out = path.join(fx.root, `${name}.png`)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-i',
        path.join(MEDIA, `${name}.png`),
        '-vf',
        `scale=${width}:-1:flags=neighbor`,
        out,
      ])
      host.serveFile(drop, fs.readFileSync(out), 'image/png')
    }
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-29T09-00-00-000Z_astra-1.jsonl'),
      sessionLines('astra-1', 'Astra', evaRoot),
    )
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-29T09-10-00-000Z_rich-chat.jsonl'),
      sessionLines('rich-chat', 'Rich check', evaRoot),
    )
    // The subagent b of the fixture chat has said the same reply.
    const sub = fx.file('p4-subagents')
    fs.appendFileSync(
      path.join(path.dirname(sub), path.basename(sub, '.jsonl'), 'b.jsonl'),
      line({
        type: 'message',
        id: 'rich-a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: REPLY }],
          stopReason: 'stop',
        },
      }) + '\n',
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

async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  await shell.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
  const tmp = await proofShot(app, shell, name, { phase: 'chat-rich' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

/** Every kind of rich content in `scope` is drawn, none of it as raw code. */
async function expectRich(scope: Locator): Promise<void> {
  const row = scope.locator('.eva-row', { hasText: LEAD })
  const compare = row.getByTestId('widget-compare')
  await expect(compare).toBeVisible({ timeout: 15_000 })
  await expect(compare.getByRole('slider', { name: 'Before and after divider' })).toBeVisible()
  for (const img of await compare.locator('img').all())
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0)
  await expect(row.getByTestId('widget-stat')).toHaveCount(1)
  await expect(row.locator('[data-widget=badge]')).toHaveCount(1)
  await expect(row.getByTestId('widget-page')).toHaveAttribute('data-runtime', 'mantine')
  const inline = row.getByTestId('md-image').locator('img')
  await expect(inline).toHaveCount(1)
  await expect
    .poll(() => inline.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0)
  await expect(row.getByTestId('code-block')).toHaveCount(0)
  // The slider moves: a drag across the frame changes the divider position.
  const frame = compare.getByTestId('compare-frame')
  await frame.scrollIntoViewIfNeeded()
  const box = (await frame.boundingBox())!
  const divider = compare.getByRole('slider', { name: 'Before and after divider' })
  const before = await divider.getAttribute('aria-valuenow')
  await frame.page().mouse.click(box.x + box.width * 0.2, box.y + box.height / 2)
  await expect(divider).not.toHaveAttribute('aria-valuenow', before ?? '')
  // Its top at the top of the log, so a screenshot shows the slider and what follows it.
  await row.evaluate((el) => el.scrollIntoView({ block: 'start' }))
}

test('the same rich reply works in an assistant thread, a chat and a subagent transcript', async ({
  app,
  shell,
}) => {
  test.setTimeout(150_000)
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(w, h),
    [1280, 1000] as const,
  )
  const log = shell.locator(LOG)

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
  await expectRich(log)
  await shot(app, shell, 'assistant-thread')

  await shell.getByTestId('sidebar-back').click()
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: /^Rich check/ })
    .click()
  await expect(shell.getByTestId('chat-header')).toContainText('Rich check')
  await expectRich(log)
  await shot(app, shell, 'inbox-chat')

  for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all())
    await more.click()
  await shell.locator('[data-testid="chat-row-p4-subagents"]').click()
  await shell.locator('[data-testid="subagent-chip-b"]').click()
  await expectRich(shell.locator('[data-testid=subagent-transcript]'))
  await shot(app, shell, 'subagent-transcript')
})
