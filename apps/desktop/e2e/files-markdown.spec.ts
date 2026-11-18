import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { test as base, expect, launchApp } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { proofOutDir } from './helpers/metrics'
import { EVA_FIXTURE_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// Markdown in Files opens rendered and editable, on the same Monaco buffer as the source view
// (Open as source in the tab menu): Isaac types in a heading, ticks a task and edits a table
// cell, the source view shows the same unsaved buffer and undoes his rendered edits, and a save
// writes the file byte for byte (frontmatter, fences, links, images untouched). A live agent's
// writes (the fake Relay Host's `files.edit`, as after a tool call) stream in with its caret,
// avatar and caption; while Isaac types, an edit off screen shows as a pill instead of moving
// his view. A comment on rendered lines lands in the owning chat. Shots go to
// proof/phase-files-markdown/ (EVAOS_PROOF=1); MD_VIDEO=1 also records the agent streaming in.

const PHASE = 'phase-files-markdown'
const VIDEO = process.env['MD_VIDEO'] === '1'
const sel = (id: string): string => `[data-testid="${id}"]`
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

const FILLER = Array.from(
  { length: 18 },
  (_, i) =>
    `Note ${String(i + 1)}: the rendered view keeps the text as typed, so a save writes the same bytes the source view would.`,
)
const DOC = [
  '---',
  'title: Relay Files plan',
  'owner: Isaac',
  'status: draft',
  '---',
  '',
  '# Markdown in Files',
  '',
  'Files opens Markdown **rendered** and editable, on the same buffer as the source view. See [the spec](./SPEC.md) or run `pnpm e2e`.',
  '',
  '## Checklist',
  '',
  '- [ ] Rendered by default',
  '- [x] Lossless round trip',
  '- [ ] Live agents stream in',
  '',
  '| Step | Owner | State |',
  '|---|---|---|',
  '| Parse | Eva | done |',
  '| Render | Eva | shipped |',
  '',
  '![Flow](img/flow.png)',
  '',
  '> Every byte saved is a byte typed.',
  '',
  '```ts',
  'export const answer = 42',
  '```',
  '',
  '## Notes',
  '',
  ...FILLER.flatMap((l) => [l, '']),
].join('\n')

/** Nova as the host names her edits; her portrait is served at `avatar` (the host's path). */
const NOVA = { name: 'Nova', color: '#7c3aed', avatar: '/canvas/avatar/nova' }
const NOVA_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='16' fill='#7c3aed'/><text x='16' y='21' font-family='Helvetica' font-size='14' font-weight='700' fill='white' text-anchor='middle'>N</text></svg>"

let host: FakeRelayHost
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

/** A small solid PNG, so the rendered image block has something to show. */
function flowPng(): Buffer {
  const png = new PNG({ width: 360, height: 120 })
  for (let y = 0; y < 120; y++)
    for (let x = 0; x < 360; x++) {
      const i = (y * 360 + x) * 4
      const t = x / 360
      png.data[i] = Math.round(124 + t * 40)
      png.data[i + 1] = Math.round(58 + t * 100)
      png.data[i + 2] = 237
      png.data[i + 3] = 255
    }
  return PNG.sync.write(png)
}

const test = base.extend({
  launchEnv: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-files-md-'))
    root = path.join(fs.realpathSync(tmp), 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, root, { recursive: true })
    file = path.join(root, 'plan.md')
    fs.writeFileSync(file, DOC)
    fs.mkdirSync(path.join(root, 'img'))
    fs.writeFileSync(path.join(root, 'img', 'flow.png'), flowPng())
    log = path.join(tmp, 'fake-omp.log')
    const relayDir = path.join(tmp, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['files.presence']
    host.serveFile(NOVA.avatar, Buffer.from(NOVA_SVG), 'image/svg+xml')
    await use({
      EVAOS_EVA_ROOT: root,
      EVAOS_RELAY_DIR: relayDir,
      FAKE_OMP_DELAY_MS: '5',
      FAKE_OMP_LOG: log,
      EVAOS_AGENT_CONTROL: '1',
    })
    await host.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  },
})

/** Nova writes `lines` as the file, and the host says so with the lines she changed. */
function novaWrites(text: string, line: number, intent: string): void {
  fs.writeFileSync(file, text)
  const lines = text.split('\n')
  host.fileEdit({
    path: file,
    hash: sha1(text),
    ranges: [{ startLine: line, endLine: line }],
    caret: { line, column: (lines[line - 1] ?? '').length + 1 },
    agent: NOVA,
    intent,
    at: Date.now(),
  })
}

async function openPlan(shell: Page): Promise<void> {
  await shell.locator(sel('pane-tab-files')).click()
  await shell.locator(`${sel('files-row')}[data-path="plan.md"]`).dblclick()
  await expect(shell.locator('.eva-md-prose')).toBeVisible()
  await expect(shell.locator(sel('md-block-table'))).toBeVisible()
}

/** The Files panel alone, for the close-up shots. */
async function panelShot(shell: Page, name: string): Promise<void> {
  const dir = proofOutDir(PHASE)
  fs.mkdirSync(dir, { recursive: true })
  await shell.waitForTimeout(350)
  await shell.locator(sel('files-panel')).screenshot({ path: path.join(dir, `${name}.png`) })
}

test.use({ startOnChat: false })

test('Markdown opens rendered and editable; Open as source shares the buffer; a save is byte for byte', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1600, 1000))
  await openPlan(shell)
  const editor = shell.locator(sel('files-editor'))
  const lines = editor.locator('.view-lines')

  // Rendered: headings, frontmatter as properties, the table and the image drawn, no syntax.
  // The heading's line: its words in the heading font, the `# ` before them hidden.
  const h1 = editor.locator('.view-line').filter({ has: shell.locator('.eva-md-h1') })
  await expect(h1).toHaveText('Markdown in Files', { useInnerText: true })
  await expect(shell.locator(sel('md-block-frontmatter'))).toContainText('Relay Files plan')
  await expect(shell.locator(sel('md-block-table')).locator('table')).toContainText('shipped')
  await expect
    .poll(() =>
      shell
        .locator(`${sel('md-block-image')} img`)
        .evaluate((i) => (i as HTMLImageElement).naturalWidth),
    )
    .toBe(360)
  const visible = (): Promise<string> => lines.evaluate((el) => (el as HTMLElement).innerText)
  // Monaco's source lines drop the spaces from innerText; compare the text without whitespace.
  const flat = async (): Promise<string> => (await visible()).replace(/\s/g, '')
  expect(await visible()).not.toContain('**')
  expect(await visible()).not.toContain('](./SPEC.md)')
  expect(await visible()).not.toContain('# Markdown')
  await expect(editor.locator('.eva-md-task')).toHaveCount(3)
  await proofShot(app, shell, 'md-1-rendered', { phase: PHASE })
  await panelShot(shell, 'md-1-rendered-panel')

  // Typing in the heading: its `# ` shows dim while the caret is in it; the tab turns dirty.
  await editor.locator('.view-line', { hasText: 'Markdown in Files' }).click()
  await shell.keyboard.press('End')
  await shell.keyboard.type(' (draft)')
  await expect(h1).toContainText('Markdown in Files (draft)', { useInnerText: true })
  await expect(editor.locator('.eva-md-syntax', { hasText: '#' })).toHaveCount(1)
  await expect(shell.locator(`${sel('files-tab')}[data-dirty]`)).toHaveCount(1)

  // A task box ticks with a click.
  await editor.locator('.eva-md-task').first().click()
  await expect(editor.locator('.eva-md-task.is-checked')).toHaveCount(2)

  // The table opens as its lines on a click; a cell edit shows rendered once the caret leaves.
  await shell.locator(sel('md-block-table')).click()
  await expect(lines).toContainText('| Render | Eva | shipped |')
  await shell.keyboard.press('ArrowDown')
  await shell.keyboard.press('ArrowDown')
  await shell.keyboard.press('ArrowDown')
  await shell.keyboard.press('End')
  await shell.keyboard.press('ArrowLeft')
  await shell.keyboard.press('ArrowLeft')
  await shell.keyboard.type(' today')
  await expect(lines).toContainText('| Render | Eva | shipped today |')
  await panelShot(shell, 'md-2-table-open')
  await editor.locator('.view-line', { hasText: 'Every byte saved' }).click()
  await expect(shell.locator(sel('md-block-table'))).toContainText('shipped today')
  await proofShot(app, shell, 'md-2-edited', { phase: PHASE })

  // Open as source (tab menu): the same unsaved buffer as Markdown, still dirty.
  await shell.getByRole('button', { name: 'File actions' }).click()
  await shell.locator(sel('files-open-as')).click()
  await expect(shell.locator('.eva-md-prose')).toHaveCount(0)
  await expect(editor.locator('.line-numbers').first()).toBeVisible()
  await expect(lines).toContainText('# Markdown in Files (draft)')
  await expect(lines).toContainText('- [x] Rendered by default')
  await expect(shell.locator(`${sel('files-tab')}[data-dirty]`)).toHaveCount(1)
  await proofShot(app, shell, 'md-3-source', { phase: PHASE })

  // Its undo walks back the rendered view's edits: the cell edit first, the heading stays.
  await editor.locator('.view-line', { hasText: 'Every byte saved' }).click()
  await shell.keyboard.press('ControlOrMeta+z')
  await expect.poll(flat).not.toContain('shippedtoday')
  expect(await flat()).toContain('|Render|Eva|shipped|')
  expect(await flat()).toContain('(draft)')
  await shell.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(flat).toContain('shippedtoday')

  // Back to rendered (tab menu), then save: the file is the original plus exactly these edits.
  await shell.getByRole('button', { name: 'File actions' }).click()
  await expect(shell.locator(sel('files-open-as'))).toHaveText('Open rendered')
  await shell.locator(sel('files-open-as')).click()
  await expect(shell.locator('.eva-md-prose')).toBeVisible()
  await editor.locator('.view-line', { hasText: 'Every byte saved' }).click()
  await shell.keyboard.press('ControlOrMeta+s')
  await expect(shell.locator(`${sel('files-tab')}[data-dirty]`)).toHaveCount(0)
  expect(fs.readFileSync(file, 'utf8')).toBe(
    DOC.replace('# Markdown in Files', '# Markdown in Files (draft)')
      .replace('- [ ] Rendered by default', '- [x] Rendered by default')
      .replace('| Render | Eva | shipped |', '| Render | Eva | shipped today |'),
  )
})

test("a live agent's writes stream into the rendered file with its caret, avatar and caption", async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1600, 1000))
  await openPlan(shell)
  const editor = shell.locator(sel('files-editor'))
  const caret = shell.locator(sel('agent-caret-Nova'))

  // Isaac is idle: Nova adds a line at the end, off screen; the view goes to it, caret and caption on.
  const end = DOC.split('\n').length
  const one = `${DOC}Nova: rollout goes out with the desktop deploy tonight.\n`
  novaWrites(one, end, 'Drafting the rollout notes')
  await expect(caret).toBeVisible()
  await expect(caret).toContainText('Drafting the rollout notes')
  await expect(caret.locator('img.eva-agent-avatar')).toHaveCount(1)
  await expect(editor.locator('.view-lines')).toContainText('rollout goes out')
  await panelShot(shell, 'md-4-agent-streams-in')
  await proofShot(app, shell, 'md-4-agent-streams-in-window', { phase: PHASE })

  // Nova edits the table: the rendered table takes the change, outlined with her tag.
  const two = one.replace('| Parse | Eva | done |', '| Parse | Nova | done, reviewed |')
  novaWrites(two, DOC.split('\n').indexOf('| Parse | Eva | done |') + 1, 'Reviewing the table')
  const table = shell.locator(sel('md-block-table'))
  await expect(table).toContainText('done, reviewed')
  await table.scrollIntoViewIfNeeded()
  await expect(table.locator(sel('agent-block-Nova'))).toContainText('Reviewing the table')
  await panelShot(shell, 'md-5-agent-in-table')

  // Isaac types at the top: Nova's next line off screen shows as a pill; his view stays.
  await expect(caret).toHaveCount(0, { timeout: 5000 })
  await editor.locator('.view-line', { hasText: 'Markdown in Files' }).click()
  await shell.keyboard.press('End')
  await shell.keyboard.type(' now')
  const three = `${two}Nova: a pill shows where I am while you type.\n`
  novaWrites(three, end + 1, 'Adding a note')
  const pill = shell.locator(sel('md-follow'))
  await expect(pill).toHaveText('Nova is editing below')
  await expect(editor.locator('.view-lines')).toContainText('Markdown in Files now')
  await panelShot(shell, 'md-6-follow-pill')
  await pill.click()
  await expect(pill).toHaveCount(0)
  await expect(caret).toBeVisible()
  await expect(shell.locator(sel('files-conflict'))).toHaveCount(0)
  // His typing and her lines are both in the buffer, still unsaved.
  await expect(shell.locator(`${sel('files-tab')}[data-dirty]`)).toHaveCount(1)
  await shell.getByRole('button', { name: 'File actions' }).click()
  await shell.getByRole('menuitem', { name: 'Reload from disk' }).click()
})

test.describe('in a chat', () => {
  test.use({ startOnChat: true })

  test('a comment on rendered lines lands in the owning chat as one quiet row', async ({
    app,
    shell,
    configDir,
  }) => {
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
    await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeGreaterThan(1700)
    await shell.getByTestId('nav-chat').click()
    await shell
      .getByTestId('chat-tree')
      .getByRole('link', { name: /^Fixture chat(?:,|$)/ })
      .click()
    await expect(shell.locator(sel('chat-log'))).toContainText('Please sketch a tiny greeter.')
    const chat = await shell.evaluate(() => {
      const t = (
        window as unknown as {
          __evaosShell: { tabs(): { active: number; list: Array<{ chat: string | null }> } }
        }
      ).__evaosShell.tabs()
      return t.list[t.active]!.chat ?? ''
    })

    // The chat's agent opens the file in this chat's Files (files.open, agent control).
    const control = path.join(configDir, 'agent-control.json')
    await expect.poll(() => fs.existsSync(control), { timeout: 15_000 }).toBe(true)
    const { port, token } = JSON.parse(fs.readFileSync(control, 'utf8')) as {
      port: number
      token: string
    }
    const res = await fetch(`http://127.0.0.1:${String(port)}/actions/files.open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params: { path: file, line: 9 }, scope: `chat:${chat}` }),
    })
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    const editor = shell.locator(sel('files-editor'))
    await expect(shell.locator('.eva-md-prose')).toBeVisible()

    // Select the paragraph (rendered), then the button by the selection, a note, Enter.
    // A triple click selects the whole line, as wrapped prose has no visual line end to stop at.
    // (The first click brings the Files pane forward.)
    const paragraph = editor.locator('.view-line', { hasText: 'Files opens Markdown' })
    // Monaco's caret layer sits over the line; force the positioned click through it.
    const start = { position: { x: 12, y: 8 }, force: true }
    await paragraph.click(start)
    await paragraph.click({ ...start, clickCount: 3 })
    const button = shell.locator(sel('files-comment-button'))
    await expect(button).toBeVisible()
    await button.click()
    const card = shell.locator(sel('files-comment-card'))
    await expect(card).toContainText('Comment on plan.md, line 9')
    await card.locator(sel('files-comment-input')).fill('Say which shortcut opens the source')
    await proofShot(app, shell, 'md-7-comment-card', { phase: PHASE })
    await shell.keyboard.press('Enter')
    await expect(card).toHaveCount(0)

    await expect
      .poll(() => prompts().some((p) => p.includes('[Comment on file ')), { timeout: 15_000 })
      .toBe(true)
    const prompt = prompts().find((p) => p.includes('[Comment on file '))!
    expect(prompt).toContain(`[Comment on file "plan.md" at ${JSON.stringify(file)}, line 9]`)
    expect(prompt).toContain('```markdown\n' + DOC.split('\n')[8] + '\n```')
    const row = shell.locator('[data-testid=background-event][data-kind=file]')
    await expect(row).toHaveCount(1)
    await expect(row.locator(sel('background-chip'))).toHaveText('plan.md:9')
    await expect(row.locator(sel('background-note'))).toHaveText(
      'Say which shortcut opens the source',
    )
    await row.scrollIntoViewIfNeeded()
    await proofShot(app, shell, 'md-8-comment-row', { phase: PHASE })
  })
})

test('video: an agent writes a section into the rendered file live', async ({
  configDir,
  launchEnv,
}) => {
  test.skip(!VIDEO, 'video only with MD_VIDEO=1')
  const dir = path.join(proofOutDir(PHASE), 'video')
  const app = await launchApp(configDir, launchEnv, { dir, size: { width: 1440, height: 900 } })
  try {
    const shell = await app.firstWindow()
    await shell.waitForSelector('[data-testid=rail]')
    await shell.waitForSelector('[data-pane-kind=app]', { state: 'attached' })
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setContentSize(1440, 900))
    await shell.evaluate(() =>
      (window as unknown as { __evaosShell: { setPanel(o: boolean): void } }).__evaosShell.setPanel(
        true,
      ),
    )
    await openPlan(shell)
    await shell.locator(sel('files-editor')).locator('.view-line').first().click()
    await shell.keyboard.press('Alt+Meta+Enter')
    await shell.waitForTimeout(1200)
    // Nova writes a section under the checklist, a few words per write, like a streaming draft.
    const at = DOC.split('\n').indexOf('| Step | Owner | State |')
    const words =
      'Rollout: the rendered view ships with tonight’s desktop deploy. Agents write straight into the open file, and Isaac sees each change land with my caret and caption.'.split(
        ' ',
      )
    const head = DOC.split('\n').slice(0, at)
    const tail = DOC.split('\n').slice(at)
    let text = DOC
    for (let n = 1; n <= words.length; n += 2) {
      const line = words.slice(0, n).join(' ')
      text = [...head, '### Rollout', '', line, '', ...tail].join('\n')
      novaWrites(text, at + 3, 'Drafting the rollout section')
      await shell.waitForTimeout(450)
    }
    novaWrites(
      text.replace('- [ ] Live agents stream in', '- [x] Live agents stream in'),
      15,
      'Ticking it off',
    )
    await shell.waitForTimeout(3500)
  } finally {
    await app.close()
  }
})
