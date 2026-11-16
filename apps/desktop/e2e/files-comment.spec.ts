import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// Comment on code in Files: Isaac selects lines in the editor, picks Comment (the editor's context
// menu, or the small button at the end of the selection), writes a note and sends it. It lands in
// the chat that owns the workspace as one quiet background row (the file and lines, his note, the
// code), never a bubble, and the real Fixture chat's (fake) omp gets it as a prompt. The row's
// file and lines open Files again with those lines selected. Screenshots go to
// proof/phase-files-comment/ (EVAOS_PROOF=1).

const PHASE = 'phase-files-comment'
const LINES = Array.from({ length: 24 }, (_, i) =>
  i === 3
    ? 'export function greet(name: string): string {'
    : i === 4
      ? '  return `Hello, ${name}!`'
      : i === 5
        ? '}'
        : `// line ${String(i + 1)}`,
)
const NOTE = 'Make the greeting configurable'

let root: string
let file: string
let log: string

type Ev = { event: string; detail: Record<string, unknown> | null }
const prompts = (): string[] =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
        .filter((e) => e.event === 'prompt')
        .map((e) => String(e.detail?.['message'] ?? ''))
    : []

const test = base.extend({
  launchEnv: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-files-comment-'))
    root = path.join(fs.realpathSync(tmp), 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'src'))
    file = path.join(root, 'src', 'greeter.ts')
    fs.writeFileSync(file, `${LINES.join('\n')}\n`)
    log = path.join(tmp, 'fake-omp.log')
    await use({
      EVAOS_EVA_ROOT: root,
      FAKE_OMP_DELAY_MS: '5',
      FAKE_OMP_LOG: log,
      EVAOS_AGENT_CONTROL: '1',
    })
    fs.rmSync(tmp, { recursive: true, force: true })
  },
})

type Shell = { __evaosShell: { tabs(): { active: number; list: Array<{ chat: string | null }> } } }

/** Opens the Fixture chat in the chat tree; answers its session file. */
async function openFixtureChat(shell: Page): Promise<string> {
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: /^Fixture chat(?:,|$)/ })
    .click()
  await expect(shell.locator('[data-testid=chat-log]')).toContainText(
    'Please sketch a tiny greeter.',
  )
  return shell.evaluate(() => {
    const t = (window as unknown as Shell).__evaosShell.tabs()
    return t.list[t.active]!.chat ?? ''
  })
}

test('a comment on selected lines in Files lands in the owning chat as one quiet row', async ({
  app,
  shell,
  configDir,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeGreaterThan(1700)
  const chat = await openFixtureChat(shell)
  expect(chat).toMatch(/\.jsonl$/)

  // The chat's agent shows the file in this chat's workspace (files.open through agent control).
  const control = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(control), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(control, 'utf8')) as {
    port: number
    token: string
  }
  const res = await fetch(`http://127.0.0.1:${port}/actions/files.open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params: { path: file, line: 1 }, scope: `chat:${chat}` }),
  })
  const opened = (await res.json()) as { ok: boolean; code?: string; message?: string }
  expect(opened.ok, `files.open: ${opened.code} ${opened.message}`).toBe(true)
  const editor = shell.locator('[data-testid=files-editor]')
  await expect(editor.locator('.view-lines')).toContainText('export function greet')

  // Lines 4-6: the line number selects line 4, two Shift+Down take it to the start of line 7.
  await editor.locator('.line-numbers', { hasText: /^4$/ }).click()
  await shell.keyboard.press('Shift+ArrowDown')
  await shell.keyboard.press('Shift+ArrowDown')
  const button = shell.locator('[data-testid=files-comment-button]')
  await expect(button).toBeVisible()
  await proofShot(app, shell, 'files-comment-button', { phase: PHASE })

  // The editor's context menu has Comment too; it opens the same card.
  await editor.locator('.view-line', { hasText: 'return `Hello' }).click({ button: 'right' })
  const item = shell.locator('.monaco-menu .action-item', { hasText: /^Comment$/ })
  await expect(item).toBeVisible()
  await proofShot(app, shell, 'files-comment-menu', { phase: PHASE })
  await item.click()
  const card = shell.locator('[data-testid=files-comment-card]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Comment on greeter.ts, lines 4-6')
  await expect(button).toHaveCount(0)
  await card.locator('[data-testid=files-comment-input]').fill(NOTE)
  await proofShot(app, shell, 'files-comment-card', { phase: PHASE })
  await shell.keyboard.press('Enter')
  await expect(card).toHaveCount(0)

  // The fake omp got it as a prompt naming the file, the lines, the note and the code.
  await expect
    .poll(() => prompts().some((p) => p.includes('[Comment on file ')), { timeout: 15_000 })
    .toBe(true)
  const prompt = prompts().find((p) => p.includes('[Comment on file '))!
  // (omp also gets the app's <surface> line first, as with every message Isaac sends.)
  expect(prompt.split('\n')).toContain(
    `[Comment on file "src/greeter.ts" at ${JSON.stringify(file)}, lines 4-6]`,
  )
  expect(prompt).toContain(NOTE)
  expect(prompt).toContain('```typescript\n' + LINES.slice(3, 6).join('\n') + '\n```')

  // One quiet row in the chat, no bubble: the file and lines, the note, the code.
  const row = shell.locator('[data-testid=background-event][data-kind=file]')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('You commented on')
  await expect(row.locator('[data-testid=background-chip]')).toHaveText('greeter.ts:4-6')
  await expect(row.locator('[data-testid=background-note]')).toHaveText(NOTE)
  await expect(row.locator('[data-testid=background-code]')).toContainText('return `Hello')
  await expect(shell.locator('.eva-bubble').filter({ hasText: NOTE })).toHaveCount(0)
  await row.scrollIntoViewIfNeeded()
  await proofShot(app, shell, 'files-comment-row', { phase: PHASE })

  // The link back: elsewhere in the file first, then the row's file and lines select 4-6 again.
  await editor.locator('.line-numbers', { hasText: /^20$/ }).click()
  await shell.keyboard.press('ArrowDown')
  await expect(button).toHaveCount(0)
  await row.locator('[data-testid=background-chip]').click()
  await expect(button).toBeVisible()
  // The selection paints on exactly three rows (Monaco may draw a row in more than one piece).
  const rows = (): Promise<number> =>
    editor
      .locator('.view-overlays .selected-text')
      .evaluateAll((els) => new Set(els.map((e) => e.parentElement?.style.top ?? '')).size)
  await expect.poll(rows).toBe(3)
  // Opening a path shows it in the explorer too, which overlays a narrow editor: close it for the shot.
  const explorer = shell.getByRole('button', { name: /^Explorer/ })
  if ((await explorer.getAttribute('aria-pressed')) === 'true') await explorer.click()
  await proofShot(app, shell, 'files-comment-link-back', { phase: PHASE })
})
