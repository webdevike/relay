import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { APP_DIR, EVA_FIXTURE_ROOT } from './helpers/paths'

// An assistant whose turn failed before it started (its profile's Claude sign-in expired, so omp
// had no API key) is never silent: the host's `assistant.agents` row carries the failure and the
// profile's sign-in state, and the app shows the failure at the end of the thread with "Sign in
// again", a warning mark on its sidebar row and home card, and the profile's sign-in under
// Settings > Connections. Nothing here clicks Sign in again: that would run omp's real login.

let fx: ChatFixture
let host: FakeRelayHost
let evaRoot: string
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [
          { id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' },
          { id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova-17' },
        ],
      }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)
/** Screenshots of each surface go to EVAOS_SIGNIN_PROOF (default test-results/assistant-signin). */
const proof = (name: string): string =>
  path.join(
    process.env.EVAOS_SIGNIN_PROOF ?? path.join(APP_DIR, 'test-results/assistant-signin'),
    `${name}.png`,
  )
type Shell = {
  __evaosShell: {
    openPlace(page: string, newTab?: boolean, extra?: Record<string, string>): void
  }
}

const EXPIRED = 'oauth refresh failed: 400 invalid_grant, Refresh token expired.'
const FAILURE_TEXT =
  'No API key found for anthropic. Your message did not reach Nova. Sign in to Claude again under the personal profile.'

function hostAgents(failed: boolean) {
  return [
    {
      id: 'astra',
      title: 'Astra',
      status: 'idle',
      background: 0,
      auth: { provider: 'anthropic', state: 'ok', account: 'isaac@example.com' },
    },
    {
      id: 'nova',
      title: 'Nova',
      status: 'idle',
      background: 0,
      profile: 'personal',
      auth: { profile: 'personal', provider: 'anthropic', state: 'signed_out', detail: EXPIRED },
      ...(failed && {
        failure: {
          at: Date.now(),
          kind: 'auth',
          title: "Nova couldn't reply",
          text: FAILURE_TEXT,
          fix: { kind: 'signin', provider: 'anthropic', profile: 'personal' },
        },
      }),
    },
  ]
}

const openPlace = (shell: Page, page: string, extra?: Record<string, string>) =>
  shell.evaluate(([p, x]) => (window as unknown as Shell).__evaosShell.openPlace(p, false, x), [
    page,
    extra,
  ] as const)

test("a failed turn shows in the thread with Sign in again, on the assistant's marks, and in Connections", async ({
  shell,
}) => {
  // Nova's thread as omp wrote it: Isaac's earlier exchange. The failed turn is in no session file.
  fs.writeFileSync(
    path.join(fx.sessionsDir, '2026-11-19T08-00-00-000Z_nova-1.jsonl'),
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
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi Isaac!' }],
          stopReason: 'stop',
        },
      }),
    ].join('\n') + '\n',
  )
  host.upsert({ id: 'nova-1', status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })
  host.setAssistantAgents(hostAgents(true))

  // 1. The thread ends on the failure, over the composer, with Sign in again.
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Isaac!', { timeout: 10_000 })
  const strip = shell.locator(sel('turn-failure-nova'))
  await expect(strip).toBeVisible()
  await expect(strip).toHaveAttribute('data-tone', 'danger')
  await expect(strip).toContainText("Nova couldn't reply")
  await expect(strip).toContainText('No API key found for anthropic.')
  await expect(shell.locator(sel('turn-failure-nova-signin'))).toHaveText('Sign in again')
  await shell.locator(sel('chat-pane')).screenshot({ path: proof('thread') })

  // 2. Nova's sidebar row carries the warning mark; Astra's, signed in, does not.
  await expect(shell.locator(sel('sidebar-trouble-nova'))).toBeVisible()
  await expect(shell.locator(sel('sidebar-trouble-astra'))).toHaveCount(0)
  await shell.locator(sel('sidebar-trouble-nova')).hover()
  await expect(shell.getByRole('tooltip')).toContainText(FAILURE_TEXT)
  await shell.locator(sel('chat-log')).hover()
  await expect(shell.getByRole('tooltip')).toHaveCount(0)

  // 3. So does her home card.
  await openPlace(shell, 'assistants')
  await expect(shell.locator(sel('assistant-trouble-nova'))).toBeVisible()
  await expect(shell.locator(sel('assistant-trouble-astra'))).toHaveCount(0)
  await shell.locator(sel('assistants-grid')).screenshot({ path: proof('home') })

  // 4. Settings > Connections lists each profile sign-in the assistants use, with who uses it.
  await openPlace(shell, 'settings', { settingsSection: 'Connections' })
  const personal = shell.locator(sel('connection-profile-personal-anthropic'))
  await expect(personal).toBeVisible()
  await expect(personal).toHaveAttribute('data-status', 'signed_out')
  await expect(personal).toContainText('Claude, personal profile')
  await expect(personal).toContainText('Signed out')
  await expect(personal).toContainText(EXPIRED)
  await expect(personal).toContainText('Used by Nova')
  await expect(shell.locator(sel('connection-profile-personal-anthropic-signin'))).toHaveText(
    'Sign in again',
  )
  const fallback = shell.locator(sel('connection-profile-default-anthropic'))
  await expect(fallback).toHaveAttribute('data-status', 'ok')
  await expect(fallback).toContainText('Used by Astra')
  // The default profile's own Claude row is still there.
  await expect(shell.locator(sel('connection-anthropic'))).toBeVisible()
  await shell.locator(sel('connections-profiles')).screenshot({ path: proof('connections') })

  // 5. A reply landed: the host clears the failure, so the strip drops it; the profile's expired
  //    sign-in still shows there as a warning until it signs in again.
  await openPlace(shell, 'agent:nova')
  await expect(strip).toHaveAttribute('data-tone', 'danger')
  host.setAssistantAgents(hostAgents(false))
  await expect(strip).toHaveAttribute('data-tone', 'warn')
  await expect(strip).toContainText('Claude, personal profile: signed out')
  await shell.locator(sel('chat-pane')).screenshot({ path: proof('thread-warn') })
})
