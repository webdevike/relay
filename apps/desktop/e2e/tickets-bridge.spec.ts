// The tickets bridge against a stand-in Relay host: a host listing the `tickets` feature serves
// the fixture board (e2e/fixtures/tickets) to `tickets.board`; a host without it gets no
// `tickets.*` frame at all and the app answers a fallback.
//
//   pnpm build && pnpm e2e:run e2e/tickets-bridge.spec.ts --retries 0 --max-failures 1
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'

let host: FakeRelayHost

const test = base.extend<{ hostFeatures: string[] }>({
  hostFeatures: [[], { option: true }],
  launchEnv: async ({ hostFeatures }, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-tickets-bridge-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = hostFeatures
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

type Answer = { ok: boolean; value: Record<string, unknown> }
function board(shell: Page): Promise<Answer> {
  return shell.evaluate(() =>
    (window as unknown as { eva: { invoke(c: string, i: unknown): Promise<Answer> } }).eva.invoke(
      'tickets.board',
      {},
    ),
  )
}

test.describe('a host with tickets', () => {
  test.use({ hostFeatures: ['render.report', TICKETS_FEATURE, TICKETS_WRITES_FEATURE] })

  test('serves the fixture board to the app', async ({ shell }) => {
    await expect
      .poll(async () => (await board(shell)).value.source, { timeout: 30_000 })
      .toBe('host')
    const { value } = await board(shell)
    const tickets = (value.board as { tickets: Array<{ key: string }> }).tickets
    expect(tickets.map((t) => t.key)).toEqual(['ENG-9001', 'ENG-9002'])
    // One subscribe per connection; the held board answers later asks.
    const ops = host.ticketFrames.map((f) => (f.op as { kind: string }).kind)
    expect(ops.filter((k) => k === 'subscribe')).toHaveLength(1)
  })
})

test.describe('a host without tickets', () => {
  test.use({ hostFeatures: ['render.report'] })

  test('gets no tickets frame and the app falls back', async ({ shell }) => {
    await expect
      .poll(async () => (await board(shell)).value.reason, { timeout: 30_000 })
      .toBe('oldHost')
    expect(host.ticketFrames).toEqual([])
  })
})
