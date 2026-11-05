import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// A session an assistant started with its own omp (agent-session.ts: RELAY_OWNER=nova, cwd a project
// folder) shows as a chip above the composer on the assistant's page. Its transcript sits in that
// folder's own sessions dir, which the chat list does not span, so the chip had no row to open and
// fell back to the assistant page it was already on: a click did nothing. Now it opens the live
// transcript beside the chat, and the tab follows the file while the session runs.
//
// PROOF_DIR=<dir> PROOF_STAGE=before|after writes the screenshots; with `before` the spec records
// what a click did on a build without the fix instead of asserting the transcript opens.
const PROOF_DIR = process.env.PROOF_DIR ?? ''
const STAGE = process.env.PROOF_STAGE ?? 'after'

let fx: ChatFixture
let host: FakeRelayHost
let sessionFile: string
const SESSION_ID = '01a1accd-9a36-76be-ac95-a333e82b76db'
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'astra-2' }],
      }),
    )
    // The session's file: a project folder's own sessions dir, far from the fixture's sessions dir.
    const projectDir = path.join(fx.root, 'profiles/personal/agent/sessions/-Eva-work-relay')
    fs.mkdirSync(projectDir, { recursive: true })
    sessionFile = path.join(projectDir, `2026-11-05T17-41-57-942Z_${SESSION_ID}.jsonl`)
    fs.writeFileSync(sessionFile, transcript(['Per-chat layouts: reading the dock store.']))
    const ledger = path.join(evaRoot, 'work/eva/agents/nova')
    fs.mkdirSync(ledger, { recursive: true })
    fs.writeFileSync(
      path.join(ledger, 'sessions.json'),
      JSON.stringify([
        {
          id: SESSION_ID,
          sessionFile,
          title: 'Per-chat isolated pane layouts',
          startedAt: new Date().toISOString(),
        },
      ]),
    )
    host = await FakeRelayHost.start(path.join(fx.root, 'relay'))
    await use({
      ...fx.launchEnv,
      EVAOS_EVA_ROOT: evaRoot,
      EVAOS_RELAY_DIR: path.join(fx.root, 'relay'),
    })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: true, reducedMotion: 'reduce' })

function transcript(lines: string[]): string {
  const entries: unknown[] = [
    { type: 'session', version: 3, id: SESSION_ID, timestamp: new Date().toISOString(), cwd: '/p' },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      message: { role: 'user', content: 'Isolate layouts per chat' },
    },
    ...lines.map((text, i) => ({
      type: 'message',
      id: `a${i}`,
      parentId: i === 0 ? 'u1' : `a${i - 1}`,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })),
  ]
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

const sel = (id: string): string => `[data-testid="${id}"]`
const NOVA_THREAD: HostSession = {
  id: 'nova-1',
  status: 'idle',
  kind: 'assistant',
  assistant: 'nova',
  title: 'Nova',
}
const startedAt = Date.now() - 7 * 60_000

test('an agent-session chip opens that session live transcript beside the chat', async ({
  shell,
}) => {
  const shot = async (name: string): Promise<void> => {
    if (PROOF_DIR === '') return
    fs.mkdirSync(PROOF_DIR, { recursive: true })
    await shell.screenshot({ path: path.join(PROOF_DIR, `${STAGE}-${name}.png`) })
  }

  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await shell.locator(sel('start-nova')).click()
  await expect.poll(() => host.kinds()).toContain('assistant.turn')
  host.upsert(NOVA_THREAD)
  fs.writeFileSync(
    path.join(fx.sessionsDir, '2026-11-04T10-00-00-000Z_nova-1.jsonl'),
    [
      { type: 'session', version: 3, id: 'nova-1', timestamp: new Date().toISOString(), cwd: '/' },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Hi Nova' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  )
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Nova', { timeout: 10_000 })

  // The host's activity list as it reports a session of Nova's own (sessionItems: owned by the
  // assistant, opened by its own `session:` thread and omp session id).
  const chipId = `session:${SESSION_ID}`
  host.setActivity([
    {
      id: chipId,
      kind: 'session',
      owner: 'assistant:nova',
      title: 'Per-chat isolated pane layouts',
      status: 'working',
      intent: 'Reading the dock store',
      startedAt,
      updatedAt: Date.now(),
      model: 'claude-opus-5-5',
      open: { to: 'chat', thread: `session:${SESSION_ID}`, session: SESSION_ID },
    },
  ])
  const chip = shell.locator(sel(`activity-chip-${chipId}`))
  await expect(chip).toBeVisible()
  await shot('1-chip-above-composer')

  // Hover: the session's title, its model and how long it has run.
  await chip.hover()
  const tip = shell.locator(sel(`activity-chip-tip-${chipId}`))
  if (STAGE === 'after') {
    await expect(tip).toContainText('Per-chat isolated pane layouts')
    await expect(tip).toContainText('claude-opus-5-5')
    await expect(tip).toContainText('running 7m')
    await expect(tip).toContainText('Reading the dock store')
    await shot('2-hover-title-model-elapsed')
  }

  await chip.click()
  const transcriptView = shell.locator(sel('subagent-transcript'))
  if (STAGE === 'before') {
    // What the click did on the build without the fix.
    await shell.waitForTimeout(2500)
    const opened = {
      transcript: await transcriptView.count(),
      tabs: await shell.locator('[data-testid^="pane-tab-subagent:"]').count(),
    }
    fs.mkdirSync(PROOF_DIR, { recursive: true })
    fs.writeFileSync(path.join(PROOF_DIR, 'before-observations.json'), JSON.stringify(opened))
    await shot('3-after-click-nothing-opened')
    return
  }
  await expect(transcriptView).toBeVisible()
  await expect(transcriptView).toContainText('Isolate layouts per chat')
  await expect(transcriptView).toContainText('Per-chat layouts: reading the dock store.')
  await expect(shell.locator('[data-testid^="pane-tab-subagent:"]')).toHaveCount(1)
  // Still on Nova's page: the transcript opened beside it, it did not replace it.
  await expect(shell.locator(sel('chat-pane')).locator(sel('chat-log'))).toContainText('Hi Nova')
  await shot('3-transcript-open-beside-nova')

  // Live: a line the session writes while its tab is open shows without another click.
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'message',
      id: 'a9',
      parentId: 'a0',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the per-chat layout map.' }],
      },
    }) + '\n',
  )
  await expect(transcriptView).toContainText('Wrote the per-chat layout map.', { timeout: 8000 })
  await shot('4-live-append')

  // Clicking it again focuses the same tab; it does not open a second.
  await chip.click()
  await expect(shell.locator('[data-testid^="pane-tab-subagent:"]')).toHaveCount(1)
})
