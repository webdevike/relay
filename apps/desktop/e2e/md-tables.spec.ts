// Markdown tables in a chat reply hug their content, keep cell padding, and only right-align
// where the markdown says so. A 2-column and a 5-column table are drawn and measured.
//
// Screenshots go to $MD_TABLES_PROOF_DIR (default test-results/md-tables): two-column.png, five-column.png.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/md-tables.spec.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { APP_DIR } from './helpers/paths'

const OUT = process.env.MD_TABLES_PROOF_DIR ?? path.join(APP_DIR, 'test-results', 'md-tables')
const TITLE = 'Tables'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

const TEXT = [
  'Two columns:',
  '',
  '| Item | Value |',
  '| --- | --- |',
  '| Build | passing |',
  '| Deploy | queued |',
  '',
  'Five columns:',
  '',
  '| Run | Branch | Tests | Time | Result |',
  '| :--- | :--- | ---: | ---: | :---: |',
  '| 4821 | main | 1,204 | 3m 12s | ok |',
  '| 4822 | md-tables | 1,206 | 3m 09s | ok |',
  '| 4823 | release/2026-11 | 1,206 | 3m 31s | failed |',
].join('\n')

const session = (id: string) =>
  [
    { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: '2026-10-27T09:05:00.000Z' },
    {
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-10-27T09:00:00.000Z',
      cwd: '/fixture/eva-root',
    },
    {
      type: 'message',
      id: 't001',
      parentId: null,
      timestamp: '2026-10-27T09:01:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Show tables.' }],
        attribution: 'user',
        timestamp: 1793091660000,
      },
    },
    {
      type: 'message',
      id: 't002',
      parentId: 't001',
      timestamp: '2026-10-27T09:02:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: TEXT }],
        stopReason: 'stop',
        timestamp: 1793091720000,
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n'

let root = ''
const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-md-tables-'))
    const sessionsDir = path.join(root, 'agent', 'sessions', '-fixture')
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionsDir, '2026-10-27T09-00-00-000Z_chat-tables.jsonl'),
      session('chat-tables'),
    )
    await use({
      EVAOS_AGENT_DIR: path.join(root, 'agent'),
      EVAOS_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_LOG: path.join(root, 'fake-omp.log'),
    })
    fs.rmSync(root, { recursive: true, force: true })
  },
})

test.use({ toolPanes: false })

test('tables hug their content with padded cells and a quiet header', async ({ app, shell }) => {
  await app.evaluate(
    (_e, [w, h]) => {
      const hooks = globalThis as unknown as {
        __evaosTest: { win: { setContentSize(w: number, h: number): void } }
      }
      hooks.__evaosTest.win.setContentSize(w, h)
    },
    [1280, 900] as const,
  )
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  const tables = shell.locator(`${LOG} .eva-md-table`)
  await expect(tables).toHaveCount(2)

  const m = await shell.evaluate(() =>
    [...document.querySelectorAll('.eva-md-table')].map((w) => {
      const t = w.querySelector('table')!
      const th = w.querySelector('th')!
      const td = w.querySelector('td')!
      const cs = getComputedStyle(td)
      const col = w.closest('.eva-md')!.getBoundingClientRect().width
      return {
        wrap: w.getBoundingClientRect().width,
        table: t.getBoundingClientRect().width,
        column: col,
        padX: [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight)],
        padY: [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)],
        thWeight: getComputedStyle(th).fontWeight,
        thBg: getComputedStyle(th).backgroundColor,
        aligns: [...w.querySelectorAll('tbody tr:first-child td')].map(
          (c) => getComputedStyle(c).textAlign,
        ),
      }
    }),
  )
  for (const t of m) {
    expect(t.padX).toEqual([10, 10])
    expect(t.padY[0]).toBeCloseTo(6, 0)
    expect(t.thWeight).toBe('500')
    expect(t.thBg).toBe('rgba(0, 0, 0, 0)')
    expect(t.wrap).toBeLessThanOrEqual(t.column + 0.5)
  }
  // The 2-column table hugs its content instead of filling the column.
  expect(m[0]!.wrap).toBeLessThan(m[0]!.column / 2)
  expect(m[1]!.aligns).toEqual(['left', 'left', 'right', 'right', 'center'])

  fs.mkdirSync(OUT, { recursive: true })
  await tables.nth(0).screenshot({ path: path.join(OUT, 'two-column.png') })
  await tables.nth(1).screenshot({ path: path.join(OUT, 'five-column.png') })
  await shell.screenshot({ path: path.join(OUT, 'chat.png') })
})
