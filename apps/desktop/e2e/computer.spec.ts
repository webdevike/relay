import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// `@computer` in the composer (SPEC.md): main takes the message in `chat.send`, so it never reaches
// omp, and the run's rows show in the chat. The fixture Eva root has no OpenAI key and the launch
// env blanks OPENAI_API_KEY, so a run fails before it could touch this Mac.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-computer-${process.pid}.log`)

const prompts = (): string[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; detail: { message?: string } | null })
        .filter((e) => e.event === 'prompt')
        .map((e) => e.detail?.message ?? '')
    : []

let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use({
      ...fx.launchEnv,
      FAKE_OMP_DELAY_MS: '5',
      FAKE_OMP_LOG: LOG,
      FAKE_OMP_REAL_TIME: '1',
      OPENAI_API_KEY: '',
    })
    fx.cleanup()
  },
})

test.beforeEach(() => fs.rmSync(LOG, { force: true }))
test.afterAll(() => fs.rmSync(LOG, { force: true }))

const send = async (shell: Page, text: string): Promise<void> => {
  const box = shell.locator('[data-testid=composer-input]')
  await box.fill(text)
  await box.press('Enter')
}

test('@computer never reaches the agent: help, a run that cannot start, then a normal message does', async ({
  shell,
}) => {
  await shell.locator('[data-testid=nav-chat]').click()
  await shell.locator('[data-testid=chat-new]').click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText('New chat')
  const log = shell.locator('[data-testid=chat-log]')

  await send(shell, '@computer')
  await expect(log).toContainText('drives this Mac for you')

  await send(shell, '@computer open Calculator and add 2 and 2')
  await expect(log).toContainText('@computer open Calculator and add 2 and 2')
  // Finished: one line (who, how it ended, the answer) that opens to the task and its steps.
  const run = log.locator('[data-testid=widget-collapse]').filter({ hasText: 'no OpenAI key' })
  await expect(run).toContainText("Nova · @computer · Failed: Couldn't run it: no OpenAI key")
  await expect(run.getByText('in the background: open Calculator and add 2 and 2')).toBeHidden()
  await run.locator('.eva-wb-collapse-head').click()
  await expect(run.getByText('in the background: open Calculator and add 2 and 2')).toBeVisible()

  await send(shell, '@computer stop')
  await expect(log).toContainText('Nothing is running.')
  expect(prompts()).toEqual([])

  // Not a command (the keyword must lead): this one goes to omp as usual, and lands BELOW the run.
  await send(shell, 'what does @computer do')
  await expect.poll(() => prompts().length).toBe(1)
  expect(prompts()[0]).toContain('what does @computer do')
  const reply = log.getByText('Foxes are primarily nocturnal hunters')
  await expect(reply).toBeVisible()
  const below = async (): Promise<boolean> =>
    run.evaluate(
      (a, b) => (a.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      await reply.elementHandle(),
    )
  expect(await below()).toBe(true)
  await expect(log.getByText('what does @computer do', { exact: true })).toBeVisible()

  // A reload keeps the run: main holds the session's rows (saved by file, runs.test.ts covers a
  // restart). The fake omp's session file has no reply or stamps, so order is checked above only.
  await shell.reload()
  await expect(run).toBeVisible()
})

// The runs below use a local stub of the Responses API for the model and a stub MCP server for
// cua-driver, so nothing touches this Mac. The stub answers a planner call (it offers plan_run)
// with PLAN_BRIEF; a step call with `step(body)`.
const PLAN_BRIEF = 'Open ~/Documents/computer-smoke-notes.txt in TextEdit and say what it holds.'
let step: (body: string) => { name: string; args: Record<string, unknown> } = () => ({
  name: 'finish',
  args: { summary: 'Done.' },
})
const bodies: string[] = []
const planCalls = (): string[] => bodies.filter((b) => b.includes('"name":"plan_run"'))
const stepCalls = (): string[] => bodies.filter((b) => !b.includes('"name":"plan_run"'))
let server: http.Server
// Made in beforeAll: a worker may run the file's hooks again after afterAll removed it.
let stubs = ''
let driver = ''
let stubUrl = ''

test.beforeAll(async () => {
  stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-e2e-'))
  driver = path.join(stubs, 'cua-driver')
  fs.writeFileSync(
    path.join(stubs, 'driver.js'),
    `require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [], structuredContent: {} } }))
})`,
  )
  fs.writeFileSync(
    driver,
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(stubs, 'driver.js')}"\n`,
    { mode: 0o755 },
  )
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      bodies.push(body)
      const call = body.includes('"name":"plan_run"')
        ? { name: 'plan_run', args: { brief: PLAN_BRIEF, file: '', app: 'TextEdit', steps: [] } }
        : step(body)
      const item = {
        type: 'function_call',
        call_id: `c${String(bodies.length)}`,
        name: call.name,
        arguments: JSON.stringify(call.args),
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: `r${String(bodies.length)}`, output: [item] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  stubUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})
test.afterAll(() => {
  server.close()
  fs.rmSync(stubs, { recursive: true, force: true })
})

const stubbedEnv = (): Record<string, string> => ({
  FAKE_OMP_DELAY_MS: '5',
  FAKE_OMP_LOG: LOG,
  FAKE_OMP_REAL_TIME: '1',
  OPENAI_API_KEY: 'stub',
  RELAY_COMPUTER_API_BASE: stubUrl,
  CUA_DRIVER_BIN: driver,
})

const line = (entry: unknown): string => JSON.stringify(entry)
const said = (id: string, parent: string, role: 'user' | 'assistant', text: string): string =>
  line({
    type: 'message',
    id,
    parentId: parent,
    message:
      role === 'user'
        ? { role, content: text, attribution: 'user' }
        : { role, content: [{ type: 'text', text }], stopReason: 'stop' },
  })

// A run waiting on Isaac takes his next plain message as the answer (runs.ts intercept): the chat's
// omp never sees it.
test.describe('answering a waiting run', () => {
  const waiting = base.extend({
    launchEnv: async ({}, use) => {
      fx = makeChatFixture()
      await use({ ...fx.launchEnv, ...stubbedEnv() })
      fx.cleanup()
    },
  })

  waiting(
    'plain text answers the question; the run continues and omp hears nothing',
    async ({ shell }) => {
      step = (body) =>
        body.includes('function_call_output')
          ? { name: 'finish', args: { summary: 'Got it, the blue one.' } }
          : { name: 'ask_isaac', args: { question: 'Which prototype do you mean?' } }
      await shell.locator('[data-testid=nav-chat]').click()
      await shell.locator('[data-testid=chat-new]').click()
      const log = shell.locator('[data-testid=chat-log]')
      await send(shell, '@computer find the prototype')
      await expect(log).toContainText('Which prototype do you mean?')
      await send(shell, 'the blue one')
      await expect(log).toContainText('Got it, the blue one.')
      expect(bodies.at(-1)).toContain('Isaac answered: the blue one')
      expect(prompts()).toEqual([])
      // With nothing waiting, the same kind of message goes to omp again.
      await send(shell, 'thanks')
      await expect.poll(() => prompts().length).toBe(1)
    },
  )
})

// SPEC.md "Context and plan": the run plans from the chat it was sent in before it acts, and the
// plan's brief is in the step model's instructions.
test.describe('the run knows its chat', () => {
  test.beforeEach(() => {
    bodies.length = 0
    step = () => ({ name: 'finish', args: { summary: 'Opened your notes.' } })
  })

  const plain = base.extend({
    launchEnv: async ({}, use) => {
      fx = makeChatFixture()
      await use({ ...fx.launchEnv, ...stubbedEnv() })
      fx.cleanup()
    },
  })

  plain(
    'a plain chat: the planner reads its turns, and its brief reaches the step model',
    async ({ shell }) => {
      await fx.append(
        'p4-ecard',
        said('n1', 'a1', 'user', 'I saved the notes as computer-smoke-notes.txt in TextEdit.'),
      )
      await fx.append(
        'p4-ecard',
        said('n2', 'n1', 'assistant', 'Great, it is at ~/Documents/computer-smoke-notes.txt.'),
      )
      await shell.locator('[data-testid=nav-chat]').click()
      await shell.locator('[data-testid=chat-row-p4-ecard]').click()
      const log = shell.locator('[data-testid=chat-log]')
      await expect(log).toContainText('computer-smoke-notes.txt in TextEdit')
      await send(shell, '@computer open the file we talked about')
      const run = log
        .locator('[data-testid=widget-collapse]')
        .filter({ hasText: 'Opened your notes' })
      await expect(run).toBeVisible()
      expect(planCalls()).toHaveLength(1)
      expect(planCalls()[0]).toContain('Task from Isaac: open the file we talked about')
      expect(planCalls()[0]).toContain('~/Documents/computer-smoke-notes.txt')
      expect(stepCalls()[0]).toContain(PLAN_BRIEF)
      // The finished row opens to the plan.
      await run.locator('.eva-wb-collapse-head').first().click()
      await expect(run).toContainText(`Plan: ${PLAN_BRIEF}`)
      expect(prompts()).toEqual([])
    },
  )

  let host: FakeRelayHost
  const thread = base.extend({
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
      await use({
        ...fx.launchEnv,
        ...stubbedEnv(),
        EVAOS_EVA_ROOT: evaRoot,
        EVAOS_RELAY_DIR: relayDir,
      })
      await host.close()
      fx.cleanup()
    },
  })
  thread.use({ startOnChat: false })

  thread(
    "the assistant's own thread: it plans in its session, and hears how it went",
    async ({ shell }) => {
      host.upsert({
        id: 'p4-ecard',
        status: 'idle',
        kind: 'assistant',
        assistant: 'nova',
        title: 'Nova',
      })
      await shell.getByTestId('nav-assistants').click()
      await shell.getByTestId('sidebar-agent-nova').click()
      const log = shell.locator('[data-testid=chat-pane] [data-testid=chat-log]')
      await expect(log).toContainText('Hello from p4-ecard')
      await send(shell, '@computer open the notes we talked about')

      // Nova gets the hidden plan request in her own thread, and answers it in her session.
      const turns = (): string[] =>
        host.commands
          .filter((c) => c.cmd.kind === 'assistant.turn' && c.cmd.agent === 'nova')
          .map((c) => String(c.cmd.text))
      await expect.poll(() => turns().length).toBe(1)
      expect(turns()[0]).toMatch(/^\[From Nova's background jobs\] @computer: /)
      const run = /"run":"([^"]+)"/.exec(turns()[0]!)![1]!
      const brief = 'Nova: open ~/Documents/computer-smoke-notes.txt, the notes from this morning.'
      await fx.append(
        'p4-ecard',
        said(
          'pl',
          'a1',
          'assistant',
          `Opening your notes now.\n\n\`\`\`computer-plan\n${JSON.stringify({ run, brief, steps: [] })}\n\`\`\``,
        ),
      )
      // Her words show; the block never does.
      await expect(log).toContainText('Opening your notes now.')
      await expect(log).not.toContainText('computer-plan')

      // Her plan, not a planner call, is the step model's context; then she hears the result.
      await expect.poll(() => turns().length).toBe(2)
      expect(planCalls()).toEqual([])
      expect(stepCalls()[0]).toContain(brief)
      expect(stepCalls()[0]).toContain("Nova's own plan")
      expect(turns()[1]).toMatch(
        /^\[From Nova's background jobs\] @computer finished \(done\): Opened your notes\./,
      )
      // The run's row is what it did, collapsed; the summary is hers to write.
      await expect(
        log.locator('[data-testid=widget-collapse]').filter({ hasText: 'What I did' }),
      ).toBeVisible()
      expect(host.replies()).toEqual([])
    },
  )
})
