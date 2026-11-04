import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// Live agent cursors in the Files editor: the (fake) Relay Host reports an agent's write to an
// open file (`files.edit`) right after the test writes it to disk, as the real host does after a
// tool call. The write lands in the buffer in place with Nova's labeled caret, merges into
// unsaved typing on other lines, and only an overlap shows the banner. Isaac's caret goes back to
// the host (`files.caret`).

let host: FakeRelayHost
let root: string
let file: string

const LINES = Array.from({ length: 12 }, (_, i) => `line_${String(i + 1)} of the notes`)
const NOVA = { name: 'Nova', color: '#12b886' }
const sel = (id: string): string => `[data-testid="${id}"]`
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')
const shots = process.env.LIVE_CURSORS_SHOTS

const test = base.extend({
  launchEnv: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-presence-'))
    root = path.join(fs.realpathSync(tmp), 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, root, { recursive: true })
    file = path.join(root, 'notes.md')
    fs.writeFileSync(file, `${LINES.join('\n')}\n`)
    const relayDir = path.join(tmp, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['files.presence']
    await use({ EVAOS_EVA_ROOT: root, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false })

/** Nova writes `text` to the file, then the host says so, with the lines she changed. */
function novaWrites(lines: string[], ranges: Array<{ startLine: number; endLine: number }>): void {
  const text = `${lines.join('\n')}\n`
  fs.writeFileSync(file, text)
  const last = ranges.at(-1)!
  host.fileEdit({
    path: file,
    hash: sha1(text),
    ranges,
    caret: { line: last.endLine, column: (lines[last.endLine - 1] ?? '').length + 1 },
    agent: NOVA,
    intent: 'Tightening the notes',
    at: Date.now(),
  })
}

async function shot(shell: Page, name: string): Promise<void> {
  if (!shots) return
  fs.mkdirSync(shots, { recursive: true })
  // Past the 0.25 s fade-in, so the shot shows the caret as Isaac sees it.
  await shell.waitForTimeout(400)
  await shell.locator(sel('files-panel')).screenshot({ path: path.join(shots, `${name}.png`) })
}

test("an agent's edit lands in place with its caret, merges into typing, and only an overlap asks", async ({
  shell,
}) => {
  await shell.locator(sel('pane-tab-files')).click()
  await shell.locator(`${sel('files-row')}[data-path="notes.md"]`).dblclick()
  const editor = shell.locator(sel('files-editor'))
  await expect(editor.locator('.view-lines')).toContainText('line_12')
  await expect.poll(() => host.filesOpen.at(-1)).toEqual([file])

  // 1. Clean buffer: the write lands in place, Nova's caret and highlight show, no banner.
  const one = [...LINES]
  one[3] = 'line_4 NOVA_REWROTE_THIS'
  one.splice(4, 0, 'NOVA_ADDED_A_LINE')
  novaWrites(one, [{ startLine: 4, endLine: 5 }])
  await expect(editor.locator('.view-lines')).toContainText('NOVA_ADDED_A_LINE')
  const caret = shell.locator(sel('agent-caret-Nova'))
  await expect(caret).toBeVisible()
  await expect(caret).toHaveText('Nova')
  await expect(editor.locator('.eva-agent-line')).toHaveCount(2)
  await expect(shell.locator(sel('files-conflict'))).toHaveCount(0)
  await shot(shell, '1-nova-edits')
  // It fades about 3 s after her last edit.
  await expect(caret).toHaveCount(0, { timeout: 5000 })

  // Isaac's caret went to the host.
  await editor.locator('.view-line').first().click()
  await expect.poll(() => host.carets.at(-1)?.path).toBe(file)

  // 2. Unsaved typing on line 1, Nova edits line 10: both stay, still unsaved, no banner.
  await shell.keyboard.press('End')
  await shell.keyboard.type(' ISAAC_TYPING')
  await expect(shell.locator(`${sel('files-tab')}[data-dirty]`)).toHaveCount(1)
  const two = [...one]
  two[9] = 'line_9 NOVA_SECOND_EDIT'
  novaWrites(two, [{ startLine: 10, endLine: 10 }])
  await expect(editor.locator('.view-lines')).toContainText('NOVA_SECOND_EDIT')
  await expect(editor.locator('.view-lines')).toContainText('ISAAC_TYPING')
  await expect(caret).toBeVisible()
  await expect(shell.locator(sel('files-conflict'))).toHaveCount(0)
  await expect(shell.locator(`${sel('files-tab')}[data-dirty]`)).toHaveCount(1)
  await shot(shell, '2-merged-into-typing')

  // 3. Nova rewrites the line Isaac is typing on: his buffer stays and the banner names her.
  const three = [...two]
  three[0] = 'line_1 NOVA_OVERLAP'
  novaWrites(three, [{ startLine: 1, endLine: 1 }])
  const banner = shell.locator(sel('files-conflict'))
  await expect(banner).toContainText('Nova changed the lines you are editing. Your edits are kept.')
  await expect(editor.locator('.view-lines')).toContainText('ISAAC_TYPING')
  await expect(editor.locator('.view-lines')).not.toContainText('NOVA_OVERLAP')
  // The app's own watcher hears the same write a moment later, without a name: Nova's stays.
  await shell.waitForTimeout(600)
  await expect(banner).toContainText('Nova changed the lines you are editing.')
  await shot(shell, '3-overlap-banner')

  // Loading the disk version drops his typing and takes Nova's lines (and lets the app quit clean).
  await banner.getByRole('button', { name: 'Load disk version' }).click()
  await expect(editor.locator('.view-lines')).toContainText('NOVA_OVERLAP')
  await expect(shell.locator(`${sel('files-tab')}[data-dirty]`)).toHaveCount(0)
})
