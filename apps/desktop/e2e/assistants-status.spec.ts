import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { APP_DIR, EVA_FIXTURE_ROOT } from './helpers/paths'

// An assistant's card says what the host says of it (`assistant.agents`): Working with a quiet count
// while work it owns runs in the background under a resting thread, Working alone for its own turn,
// and Idle again once that work ends. The grid's screenshot goes to EVAOS_STATUS_PROOF (default
// test-results/assistants-status.png).

let fx: ChatFixture
let host: FakeRelayHost
const REGISTRY = path.join(__dirname, 'fixtures/assistants/agents.json')

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.copyFileSync(REGISTRY, path.join(evaRoot, '.omp/assistant/agents.json'))
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ toolPanes: false })

type Shell = { __evaosShell: { openPlace(page: string): void } }
const statusOf = (shell: Page, id: string) =>
  shell.locator(`[data-testid="assistant-status-${id}"]`)
const agent = (id: string, title: string, status: string, background: number) => ({
  id,
  title,
  status,
  background,
})

test('a card counts the background work its assistant owns, and rests once it ends', async ({
  shell,
}) => {
  host.upsert(
    { id: 's-nova', status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' },
    { id: 's-astra', status: 'working', kind: 'assistant', assistant: 'astra', title: 'Astra' },
    { id: 's-polaris', status: 'idle', kind: 'assistant', assistant: 'polaris', title: 'Polaris' },
    { id: 's-penny', status: 'idle', kind: 'assistant', assistant: 'penny', title: 'Penny' },
  )
  // Nova's thread rests while three sessions she started run; Astra works on her own turn.
  host.setAssistantAgents([
    agent('astra', 'Astra', 'working', 0),
    agent('nova', 'Nova', 'working', 3),
    agent('polaris', 'Polaris', 'idle', 0),
    agent('penny', 'Penny', 'needs_you', 0),
    agent('iris', 'Iris', 'not_started', 0),
  ])
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('assistants'))
  await expect(statusOf(shell, 'nova')).toHaveText('Working \u00b7 3 tasks')
  await expect(statusOf(shell, 'astra')).toHaveText('Working')
  await expect(statusOf(shell, 'polaris')).toHaveText('Idle')
  await expect(statusOf(shell, 'penny')).toHaveText('Needs you')
  const proof =
    process.env.EVAOS_STATUS_PROOF ?? path.join(APP_DIR, 'test-results/assistants-status.png')
  fs.mkdirSync(path.dirname(proof), { recursive: true })
  await shell.waitForTimeout(400)
  await shell.locator('[data-testid="assistants-grid"]').screenshot({ path: proof })

  // The sessions finished: the host's next list says so and the card rests.
  host.setAssistantAgents([
    agent('astra', 'Astra', 'working', 0),
    agent('nova', 'Nova', 'idle', 0),
    agent('polaris', 'Polaris', 'idle', 0),
    agent('penny', 'Penny', 'needs_you', 0),
    agent('iris', 'Iris', 'not_started', 0),
  ])
  await expect(statusOf(shell, 'nova')).toHaveText('Idle')
})
