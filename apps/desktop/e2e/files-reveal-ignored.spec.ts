import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// files.open on a file inside a gitignored folder that holds a nested git repo (Eva's
// work/<repo>/...): the tree hides ignored entries, but the way to the opened file must show, with
// every ancestor expanded and the file selected. Screenshots go to proof/phase-files-reveal/
// (EVAOS_PROOF=1).

const PHASE = 'phase-files-reveal'
const REL = 'work/relay-runtime/packages/atomic-agents/src/Chef.ts'

let root: string
let file: string

const test = base.extend({
  launchEnv: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-files-reveal-'))
    root = path.join(fs.realpathSync(tmp), 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, root, { recursive: true })
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' })
    }
    git(root, 'init', '-q')
    fs.writeFileSync(path.join(root, '.gitignore'), 'work/*\n!work/tracked/\n')
    fs.mkdirSync(path.join(root, 'work/tracked'), { recursive: true })
    fs.writeFileSync(path.join(root, 'work/tracked/notes.md'), '# tracked\n')
    file = path.join(root, REL)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'export class Chef {\n  cook(): string {\n    return "soup"\n  }\n}\n')
    git(path.join(root, 'work/relay-runtime'), 'init', '-q')
    git(root, 'add', '-A')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
    await use({ EVAOS_EVA_ROOT: root, EVAOS_AGENT_CONTROL: '1' })
    fs.rmSync(tmp, { recursive: true, force: true })
  },
})

test('files.open inside an ignored nested repo expands the ancestors and selects the file', async ({
  app,
  shell,
  configDir,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1500, 900))
  const control = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(control), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(control, 'utf8')) as {
    port: number
    token: string
  }
  const res = await fetch(`http://127.0.0.1:${port}/actions/files.open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params: { path: file, line: 2 } }),
  })
  const opened = (await res.json()) as { ok: boolean; code?: string; message?: string }
  expect(opened.ok, `files.open: ${opened.code} ${opened.message}`).toBe(true)

  await expect(shell.locator('[data-testid=files-editor] .view-lines')).toContainText('class Chef')
  // Beside the chat the panel is narrow: the floating sidebar steps aside once a file opens, so
  // Isaac opens the Explorer to see where the file sits.
  await shell
    .locator('[data-testid=files-panel]')
    .getByRole('button', { name: /^Explorer/ })
    .click()
  const row = shell.locator(`[data-testid=files-row][data-path="${REL}"]`)
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  for (const dir of [
    'work',
    'work/relay-runtime',
    'work/relay-runtime/packages/atomic-agents/src',
  ]) {
    await expect(shell.locator(`[data-testid=files-row][data-path="${dir}"]`)).toBeVisible()
  }
  await proofShot(app, shell, 'tree-reveals-ignored-nested-file', { phase: PHASE })
})
