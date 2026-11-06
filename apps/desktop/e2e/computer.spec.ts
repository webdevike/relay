import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'

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

// A run waiting on Isaac takes his next plain message as the answer (runs.ts intercept): the chat's
// omp never sees it, the model is a local stub of the Responses API and cua-driver a stub MCP server.
test.describe('answering a waiting run', () => {
  let server: http.Server
  const bodies: string[] = []
  const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-e2e-'))
  const driver = path.join(stubs, 'cua-driver')
  let stubUrl = ''

  test.beforeAll(async () => {
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
      {
        mode: 0o755,
      },
    )
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        bodies.push(body)
        const answered = body.includes('function_call_output')
        const item = answered
          ? {
              type: 'function_call',
              call_id: 'f',
              name: 'finish',
              arguments: JSON.stringify({ summary: 'Got it, the blue one.' }),
            }
          : {
              type: 'function_call',
              call_id: 'q',
              name: 'ask_isaac',
              arguments: JSON.stringify({ question: 'Which prototype do you mean?' }),
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

  const waiting = base.extend({
    launchEnv: async ({}, use) => {
      fx = makeChatFixture()
      await use({
        ...fx.launchEnv,
        FAKE_OMP_DELAY_MS: '5',
        FAKE_OMP_LOG: LOG,
        FAKE_OMP_REAL_TIME: '1',
        OPENAI_API_KEY: 'stub',
        RELAY_COMPUTER_API_BASE: stubUrl,
        CUA_DRIVER_BIN: driver,
      })
      fx.cleanup()
    },
  })

  waiting(
    'plain text answers the question; the run continues and omp hears nothing',
    async ({ shell }) => {
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
