import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// Reply widgets and widget training on a host that has both ("reply.widgets", "widget.training"):
// 🎯 on an assistant's reply asks one question ("Train on this") and sends the answer up as
// `widget.label` (surface desktop); a follow-up ```openui block the host pushes for a reply shows
// under it without moving the reply on screen. A fake host on a real WebSocket stands in for Relay.

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
      JSON.stringify({ agents: [{ id: 'nova', title: 'Nova', scope: 'Personal' }] }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', 'reply.widgets', 'widget.training']
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)
const THREAD = 'assistant:nova'
const PROMPT_AT = 1792486874000
const REPLY_AT = 1792486880000
const REPLY = 'Sales rose 12% this month, led by the north region.'

test('🎯 asks one question and sends the answer; a pushed follow-up widget shows under the reply without moving it', async ({
  shell,
}) => {
  fs.writeFileSync(
    path.join(fx.sessionsDir, '2026-11-04T10-00-00-000Z_nova-1.jsonl'),
    [
      line({
        type: 'session',
        version: 3,
        id: 'nova-1',
        timestamp: new Date().toISOString(),
        cwd: fx.root,
      }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'How are sales?', timestamp: PROMPT_AT },
      }),
      line({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: REPLY }],
          stopReason: 'stop',
          timestamp: REPLY_AT,
        },
      }),
    ].join('\n') + '\n',
  )
  host.upsert({ id: 'nova-1', status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  const bubble = shell.locator(sel('bubble-a1'))
  await expect(bubble).toContainText('Sales rose 12%', { timeout: 10_000 })
  // The thread asks the host for its reply widgets when it opens; it has none yet.
  await expect
    .poll(() => host.widgetFrames.some((f) => f.t === 'widgets.get' && f.thread === THREAD))
    .toBe(true)
  await expect(shell.locator(sel('reply-widget'))).toHaveCount(0)

  // 1. 🎯 is a quick pick; on this reply it opens the one-question sheet.
  await bubble.hover()
  await shell.locator(sel('react-btn-a1')).click()
  await shell.locator(sel('reaction-pick-🎯')).click()
  const sheet = shell.locator(sel('train-sheet'))
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Train on this')
  await expect(sheet.locator(sel('train-keep'))).toHaveText('Keep it like this')
  await expect(shell.locator(sel('reaction-badge-a1'))).toHaveText('🎯')

  // 2. One tap answers and closes; the host hears the label from the desktop.
  await sheet.locator(sel('train-chart')).click()
  await expect(sheet).toHaveCount(0)
  await expect
    .poll(() => host.widgetFrames.filter((f) => f.t === 'widget.label'))
    .toEqual([
      {
        t: 'widget.label',
        thread: THREAD,
        message: `assistant@${REPLY_AT}`,
        label: 'chart',
        surface: 'desktop',
        excerpt: REPLY,
      },
    ])

  // 3. The host pushes a follow-up widget for the reply: it shows under it, and the reply stays put.
  await shell.mouse.move(0, 0)
  const before = (await bubble.boundingBox())!
  host.addReplyWidget(
    THREAD,
    `assistant@${REPLY_AT}`,
    '```openui\nroot = Card([Text("North led the month")], "Sales")\n```',
  )
  const widget = shell.locator(sel('msg-a1')).locator(sel('reply-widget'))
  await expect(widget).toContainText('North led the month')
  // It came live, so it slides in.
  await expect(widget).toHaveAttribute('data-arrived', 'true')
  // Let the slide in (220 ms) and any row measuring settle before measuring.
  await shell.waitForTimeout(500)
  const after = (await bubble.boundingBox())!
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
  const box = (await widget.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(after.y + after.height - 1)
})
