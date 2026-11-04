import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// "Edit instructions" in an assistant's header menu opens the Markdown files that define it in the
// Files tab: prime.md in front, thread.md as the second tab, with a notice that prime.md changes
// apply when the assistant starts fresh. Saving writes the file. INSTRUCTIONS_PROOF=<dir> also
// writes screenshots there.
const PROOF = process.env.INSTRUCTIONS_PROOF ?? ''

const PRIME = '.omp/assistant/agents/nova/prime.md'
const THREAD = 'work/eva/agents/nova/thread.md'

let fx: ChatFixture
let host: FakeRelayHost
let evaRoot: string
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant/agents/nova'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova' }],
      }),
    )
    fs.writeFileSync(path.join(evaRoot, PRIME), 'You are Nova, Isaac\u2019s assistant.\n')
    fs.mkdirSync(path.join(evaRoot, path.dirname(THREAD)), { recursive: true })
    fs.writeFileSync(path.join(evaRoot, THREAD), '# Thread memory\n\n- Likes short answers\n')
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)

test('Edit instructions opens prime.md and thread.md in the Files tab; saving writes prime.md', async ({
  shell,
}) => {
  const file = path.join(fx.sessionsDir, '2026-11-04T10-00-00-000Z_nova-1.jsonl')
  fs.writeFileSync(
    file,
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
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Isaac!', { timeout: 10_000 })

  const shot = async (name: string): Promise<void> => {
    if (PROOF !== '') await shell.screenshot({ path: path.join(PROOF, `${name}.png`) })
  }

  // The menu item names the two files, dimmed.
  await shell.locator(`${sel('agent-notch')} ${sel('agent-portrait-nova')}`).hover()
  await shell.locator(sel('agent-edit-pencil')).click()
  const item = shell.locator(sel('agent-edit-instructions'))
  await expect(item).toContainText('Edit instructions')
  await expect(item.locator(sel('agent-edit-instructions-hint'))).toHaveText('prime.md, thread.md')
  await shot('1-menu')

  // Click: the Files tab opens prime.md in front and thread.md beside it. Nothing is sent to chat.
  await item.click()
  await expect(shell.locator(sel('files-panel'))).toBeVisible()
  const tabs = shell.locator(sel('files-tab'))
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toContainText('prime.md')
  await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true')
  await expect(tabs.nth(1)).toContainText('thread.md')
  const note = shell.locator(sel('files-prime-note'))
  await expect(note).toHaveText('Changes apply when Nova starts fresh; tell Nova to reload now.')
  await expect(shell.locator(sel('files-editor'))).toContainText('You are Nova')
  expect(host.replies()).toEqual([])
  await shot('2-prime')

  // thread.md has no notice.
  await tabs.nth(1).click()
  await expect(shell.locator(sel('files-editor'))).toContainText('Likes short answers')
  await expect(note).toHaveCount(0)
  await shot('3-thread')

  // Edit prime.md and save: the file on disk changes.
  await tabs.nth(0).click()
  await expect(note).toBeVisible()
  await shell.locator(sel('files-editor')).click()
  await shell.keyboard.press('ControlOrMeta+a')
  await shell.keyboard.type('You are Nova, shorter.')
  await expect(tabs.nth(0)).toHaveAttribute('data-dirty', 'true')
  await shell.keyboard.press('ControlOrMeta+s')
  await expect(tabs.nth(0)).not.toHaveAttribute('data-dirty', 'true')
  expect(fs.readFileSync(path.join(evaRoot, PRIME), 'utf8')).toBe('You are Nova, shorter.')
  await shot('4-saved')
})
