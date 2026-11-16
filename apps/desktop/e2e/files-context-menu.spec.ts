import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// The Files editor's right-click menu (Monaco) paints an opaque themed surface in light and dark,
// so its items never float over the code. Shots go to $CONTEXT_MENU_SHOTS when set.

const sel = (id: string): string => `[data-testid="${id}"]`
const shots = process.env.CONTEXT_MENU_SHOTS

const test = base.extend({
  launchEnv: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-ctxmenu-'))
    const root = path.join(fs.realpathSync(tmp), 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'notes.md'),
      Array.from({ length: 12 }, (_, i) => `line_${String(i + 1)} of the notes`).join('\n') + '\n',
    )
    await use({ EVAOS_EVA_ROOT: root })
    fs.rmSync(tmp, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false })

for (const scheme of ['light', 'dark'] as const) {
  test(`editor context menu has an opaque themed background (${scheme})`, async ({ shell }) => {
    await pickScheme(shell, scheme)
    await shell.locator(sel('pane-tab-files')).click()
    await shell.locator(`${sel('files-row')}[data-path="notes.md"]`).dblclick()
    const editor = shell.locator(sel('files-editor'))
    await expect(editor.locator('.view-lines')).toContainText('line_12')
    await editor.locator('.view-line').nth(3).click({ button: 'right' })
    const menu = shell.locator('.monaco-menu').first()
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Cut')
    const paint = await menu.evaluate((el) => {
      const surface = el.parentElement!
      return {
        bg: getComputedStyle(surface).backgroundColor,
        text: getComputedStyle(surface).color,
      }
    })
    const alpha = (c: string): number => (c.startsWith('rgba') ? parseFloat(c.split(',')[3]!) : 1)
    if (shots) {
      fs.mkdirSync(shots, { recursive: true })
      await shell.screenshot({ path: path.join(shots, `menu-${scheme}.png`) })
    }
    expect(alpha(paint.bg), JSON.stringify(paint)).toBe(1)
    expect(paint.bg).not.toBe(paint.text)
  })
}
