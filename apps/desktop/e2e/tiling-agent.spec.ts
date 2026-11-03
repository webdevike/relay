import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// An assistant's thread is a page like any other: dragging its tab out of the app tab bar onto the
// chat's edge splits it into a pane that reads the thread. Real thread file, real Relay session.

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
        agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova-1' }],
      }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    const line = (o: unknown): string => JSON.stringify(o)
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-27T20-00-00-000Z_nova-1.jsonl'),
      [
        line({
          type: 'session',
          version: 3,
          id: 'nova-1',
          timestamp: new Date().toISOString(),
          cwd: evaRoot,
        }),
        line({
          type: 'message',
          id: 'u1',
          parentId: null,
          message: { role: 'user', content: 'Hi Nova' },
        }),
        line({
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi Isaac, dentist at five.' }],
            stopReason: 'stop',
          },
        }),
      ].join('\n') + '\n',
    )
    host.upsert({
      id: 'nova-1',
      status: 'idle',
      kind: 'assistant',
      assistant: 'nova',
      title: 'Nova',
    })
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`

test("Nova's thread tab, dragged onto the chat's edge, splits into a pane that shows the thread", async ({
  shell,
  rendererErrors,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Nova', { timeout: 10_000 })

  const tab = shell.locator('[data-testid=tabbar] [role=tab][aria-selected=true]')
  const t = (await tab.boundingBox())!
  const chat = (await shell.locator(sel('pane-chat')).boundingBox())!
  await shell.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(chat.x + chat.width - 24, chat.y + chat.height / 2, { steps: 12 })
  await expect(shell.locator(sel('drop-zone'))).toHaveAttribute('data-zone', 'right')
  await shell.mouse.up()

  const pane = shell.locator('[data-pane-kind=tool]:visible', { hasText: 'Hi Nova' })
  await expect(pane).toHaveCount(1)
  await expect(pane).toContainText('Hi Nova')
  await expect(pane).toContainText('dentist at five')
  expect(rendererErrors).toEqual([])
})
