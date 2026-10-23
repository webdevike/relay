import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, FAKE_HERDR } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// Every Eva chat is one shared session through the local Relay host, like native EvaOS: a chat omp
// runs elsewhere streams, takes replies, stops, answers and switches through Relay, and a new chat
// starts in herdr and gets its first prompt once its omp joins Relay. A fake host on a real
// WebSocket stands in for Relay and fake herdr for herdr; no real session is ever touched.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-shared-${process.pid}.log`)
const HERDR_LOG = path.join(os.tmpdir(), `evaos-fake-herdr-shared-${process.pid}.log`)

const OmpEventSchema = z.object({
  event: z.string(),
  detail: z
    .object({ argv: z.array(z.string()).optional() })
    .nullable()
    .catch(null),
})
const HerdrCallSchema = z.object({ argv: z.array(z.string()) })
const AgentStateSchema = z.object({ session: z.string() })
type ShellHooks = {
  __evaosShell: { tabs(): { active: number; list: Array<{ chat: string | null }> } }
}

const readLines = <T>(file: string, schema: z.ZodType<T>): T[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => schema.parse(JSON.parse(l)))
    : []
/** Chats this app ran as its own omp child (`rpc-ui`), as opposed to the model catalog helper. */
const localChats = () =>
  readLines(LOG, OmpEventSchema).filter(
    (e) => e.event === 'spawn' && e.detail?.argv?.includes('rpc-ui'),
  )
const herdrCalls = (): string[][] => readLines(HERDR_LOG, HerdrCallSchema).map((e) => e.argv)

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({
      ...fx.launchEnv,
      FAKE_OMP_DELAY_MS: '5',
      FAKE_OMP_LOG: LOG,
      EVAOS_RELAY_DIR: relayDir,
      EVAOS_HERDR_BIN: FAKE_HERDR,
      FAKE_HERDR_STATE: path.join(fx.root, 'herdr'),
      FAKE_HERDR_SESSIONS_DIR: fx.sessionsDir,
      FAKE_HERDR_LOG: HERDR_LOG,
    })
    await host.close()
    fx.cleanup()
  },
})
test.beforeEach(() => {
  fs.rmSync(LOG, { force: true })
  fs.rmSync(HERDR_LOG, { force: true })
})
test.afterAll(() => {
  fs.rmSync(LOG, { force: true })
  fs.rmSync(HERDR_LOG, { force: true })
})

const sel = (id: string): string => `[data-testid="${id}"]`
const rowOf = (shell: Page, id: string) => shell.locator(sel(`chat-row-${id}`))
const send = async (shell: Page, text: string): Promise<void> => {
  const box = shell.locator(sel('composer-input'))
  await box.fill(text)
  await box.press('Enter')
}
const line = (entry: unknown): string => JSON.stringify(entry)
const prompt = (id: string, parentId: string | null, text: string) =>
  line({
    type: 'message',
    id,
    parentId,
    message: { role: 'user', content: text, attribution: 'user' },
  })
const answer = (id: string, parentId: string, text: string) =>
  line({
    type: 'message',
    id,
    parentId,
    message: {
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
    },
  })
const TAGGED = /^<surface>.+ - EvaOS<\/surface>\n/

test('an outside session streams live and takes replies, stop, answers, model and rename through Relay', async ({
  app,
  shell,
}) => {
  host.upsert({ id: 'p4-ecard', status: 'idle' })
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector(sel('chat-tree'))
  await rowOf(shell, 'p4-ecard').click()
  const log = shell.locator(sel('chat-log'))
  await expect(log).toContainText('Hello from p4-ecard')
  await expect.poll(() => host.subscribed('p4-ecard')).toBe(true)
  await expect(shell.locator(sel('chat-header'))).not.toContainText('Saved session')

  // 1. The reply streams in live, from Relay.
  host.upsert({ id: 'p4-ecard', status: 'working' })
  host.stream('p4-ecard', 'm1', 'Foxes hunt', true)
  const stream = shell.locator(sel('msg-relay-stream'))
  await expect(stream).toContainText('Foxes hunt')
  host.stream('p4-ecard', 'm1', 'Foxes hunt mostly at night.', true)
  await expect(stream).toContainText('Foxes hunt mostly at night.')
  await expect(shell.getByRole('img', { name: 'Eva is replying' })).toBeVisible()

  // 2. A message while it works is a steer.
  await send(shell, 'steer toward owls')
  await expect
    .poll(() => host.replies())
    .toEqual([
      { session: 'p4-ecard', text: expect.stringMatching(TAGGED), mode: 'steer', images: 0 },
    ])
  expect(host.replies()[0]!.text).toMatch(/\nsteer toward owls$/)

  // 3. Stop aborts it through Relay.
  await shell.locator(sel('composer-stop')).click()
  await expect.poll(() => host.kinds()).toContain('agent.abort')

  // 4. The reply ends and omp writes it to the file: it shows once, and the steer is confirmed.
  host.stream('p4-ecard', 'm1', 'Foxes hunt mostly at night.', false)
  host.upsert({ id: 'p4-ecard', status: 'idle' })
  await fx.append('p4-ecard', prompt('u2', 'a1', host.replies()[0]!.text))
  await fx.append('p4-ecard', answer('a2', 'u2', 'Foxes hunt mostly at night.'))
  await expect(shell.locator(sel('msg-a2'))).toBeVisible()
  await expect(stream).toHaveCount(0)
  await expect(log.getByText('Foxes hunt mostly at night.')).toHaveCount(1)
  await expect(shell.locator('[data-testid^="msg-sent-relay-"]')).toHaveCount(0)
  await expect(log.getByText('steer toward owls')).toHaveCount(1)
  await expect(shell.getByRole('img', { name: 'Eva is replying' })).toHaveCount(0)

  // 5. Idle, the next message starts a turn.
  await send(shell, 'one more question')
  await expect.poll(() => host.replies().map((r) => r.mode)).toEqual(['steer', 'prompt'])

  // 6. Relay refusing a message says why and gives the text back.
  host.nackNext = { code: 'agent_cannot_respond', message: 'session is gone' }
  await send(shell, 'refused one')
  await expect(shell.locator(sel('chat-error'))).toHaveText(
    "Relay couldn't send that. session is gone",
  )
  await expect(shell.locator(sel('composer-input'))).toHaveValue('refused one')
  await shell.locator(sel('composer-input')).fill('')

  // 7. Its question shows as the question card and is answered through Relay.
  host.upsert({ id: 'p4-ecard', status: 'working', statusDetail: 'ask' })
  host.ask('p4-ecard', {
    id: 'k1',
    questions: [
      { id: 'q1', question: 'Which animal next?', options: [{ label: 'Owls' }, { label: 'Bats' }] },
    ],
  })
  const card = shell.locator(sel('pending-dialog'))
  await expect(card).toContainText('Which animal next?')
  await card.getByRole('radio', { name: /Bats/ }).click()
  await expect
    .poll(() => host.commands.find((c) => c.cmd.kind === 'agent.ask.answer')?.cmd)
    .toEqual({
      kind: 'agent.ask.answer',
      sessionId: 'p4-ecard',
      askId: 'k1',
      results: [{ id: 'q1', selectedOptions: ['Bats'] }],
    })
  await expect(card).toHaveCount(0)
  await expect(log).toContainText('Answered: Bats')

  // 8. Its tool approval too: approved from the desktop.
  host.upsert({ id: 'p4-ecard', status: 'needs_permission', statusDetail: 'bash' })
  host.approval('p4-ecard', {
    id: 'call-7',
    toolName: 'bash',
    command: 'rm -rf build',
    destructive: 'rm -rf',
    requiresBiometric: true,
  })
  await expect(card).toContainText('bash needs approval')
  await expect(card).toContainText('rm -rf build')
  await proofShot(app, shell, 'shared-session-approval', { phase: 'shared-session' })
  await card.getByRole('button', { name: 'Confirm' }).click()
  await expect
    .poll(() => host.commands.find((c) => c.cmd.kind === 'agent.approve')?.cmd)
    .toEqual({
      kind: 'agent.approve',
      sessionId: 'p4-ecard',
      approvalId: 'call-7',
      confirmed: 'desktop',
    })
  await expect(card).toHaveCount(0)

  // 9. The model picker switches it through Relay.
  host.upsert({ id: 'p4-ecard', status: 'idle' })
  await shell.locator(sel('composer-model')).click()
  await shell.locator(sel('model-option-fake-text-only')).click()
  await expect
    .poll(() => host.commands.find((c) => c.cmd.kind === 'agent.configure')?.cmd)
    .toEqual({
      kind: 'agent.configure',
      sessionId: 'p4-ecard',
      model: { provider: 'fake', id: 'text-only' },
    })

  // 10. So does a rename from the chat list.
  await rowOf(shell, 'p4-ecard').click({ button: 'right' })
  await shell.locator(sel('row-menu-rename')).click()
  await shell.locator(sel('chat-rename-input')).fill('Owls and foxes')
  await shell.locator(sel('chat-rename-input')).press('Enter')
  await expect
    .poll(() => host.commands.filter((c) => c.cmd.kind === 'agent.configure').at(-1)?.cmd)
    .toEqual({ kind: 'agent.configure', sessionId: 'p4-ecard', title: 'Owls and foxes' })
  await expect(rowOf(shell, 'p4-ecard')).toContainText('Owls and foxes')

  // Never a second omp beside the one running it.
  expect(localChats()).toEqual([])
  await proofShot(app, shell, 'shared-session-outside', { phase: 'shared-session' })
})

test('a new chat starts omp in herdr and sends its first prompt once the session joins Relay', async ({
  app,
  shell,
}) => {
  await shell.locator(sel('nav-chat')).click()
  await shell.locator(sel('chat-new')).click()
  await expect(shell.locator(sel('chat-header'))).toContainText('New chat')
  await send(shell, 'reply with the word ok')
  const log = shell.locator(sel('chat-log'))
  await expect(log).toContainText('reply with the word ok')
  const starting = shell.locator(sel('msg-herdr-starting'))
  await expect(starting).toHaveText('Starting omp in herdr')

  // herdr starts omp in a workspace of its own, with the chat's flags.
  await expect.poll(() => herdrCalls().some((a) => a[0] === 'agent' && a[1] === 'start')).toBe(true)
  expect(herdrCalls()[0]).toEqual([
    'workspace',
    'create',
    '--cwd',
    EVA_FIXTURE_ROOT,
    '--label',
    'eva-root',
    '--env',
    'RELAY_HERDR_OWNED=1',
    '--no-focus',
  ])
  const start = herdrCalls().find((a) => a[0] === 'agent' && a[1] === 'start')!
  expect(start.slice(3, 9)).toEqual(['--kind', 'omp', '--pane', 'p-fake', '--timeout', '30000'])
  expect(start.slice(start.indexOf('--') + 1)).toContain('--approval-mode')

  // The tab follows the session file omp will write.
  const herdrState = path.join(fx.root, 'herdr')
  const agent = fs.readdirSync(herdrState).find((n) => n.startsWith('agent-'))!
  const file = AgentStateSchema.parse(
    JSON.parse(fs.readFileSync(path.join(herdrState, agent), 'utf8')),
  ).session
  const id = path.basename(file, '.jsonl').split('_').at(-1)!
  await expect
    .poll(() =>
      shell.evaluate(() => {
        // The shell's e2e hook on the window.
        const hooks = window as unknown as ShellHooks
        const t = hooks.__evaosShell.tabs()
        return t.list[t.active]?.chat ?? null
      }),
    )
    .toBe(file)
  // omp has not joined Relay yet: the prompt waits.
  expect(host.replies()).toEqual([])
  await expect(starting).toBeVisible()

  // It joins: the prompt goes, once, as its first turn.
  host.upsert({ id, status: 'idle' })
  await expect
    .poll(() => host.replies())
    .toEqual([{ session: id, text: expect.stringMatching(TAGGED), mode: 'prompt', images: 0 }])
  expect(host.replies()[0]!.text).toMatch(/\nreply with the word ok$/)
  await expect(starting).toHaveCount(0)
  await expect.poll(() => host.subscribed(id)).toBe(true)

  // From here it is an outside chat: its reply streams, then the file has it.
  host.upsert({ id, status: 'working' })
  host.stream(id, 'm1', 'ok', true)
  await expect(shell.locator(sel('msg-relay-stream'))).toHaveText('ok')
  fs.writeFileSync(
    file,
    [
      line({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: '/x' }),
      prompt('u1', null, host.replies()[0]!.text),
      answer('a1', 'u1', 'ok'),
    ].join('\n') + '\n',
  )
  host.stream(id, 'm1', 'ok', false)
  host.upsert({ id, status: 'idle' })
  await expect(shell.locator(sel('msg-a1'))).toHaveText('ok')
  await expect(shell.locator(sel('msg-relay-stream'))).toHaveCount(0)
  await expect(shell.locator('[data-testid^="msg-sent-relay-"]')).toHaveCount(0)
  await expect(log.getByText('reply with the word ok')).toHaveCount(1)

  // omp names the session: the header and the tab follow, first from Relay, then from the file.
  const header = shell.locator('.eva-chat-title')
  const tab = shell.locator('[role=tab]')
  await expect(header).toHaveText('New chat')
  host.upsert({ id, status: 'idle', title: 'Relay desktop check' })
  await expect(header).toHaveText('Relay desktop check')
  await expect(tab.filter({ hasText: 'Relay desktop check' })).toHaveCount(1)
  fs.appendFileSync(
    file,
    line({ type: 'title', v: 1, title: 'Owl check', updatedAt: Date.now() }) + '\n',
  )
  await expect(header).toHaveText('Owl check')
  await expect(tab.filter({ hasText: 'Owl check' })).toHaveCount(1)
  expect(localChats()).toEqual([])
  await proofShot(app, shell, 'shared-session-herdr', { phase: 'shared-session' })
})
