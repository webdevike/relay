import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// The Terminal tool: a real login shell in a pty, one xterm per tab, kept alive across tab switches
// and ended with its tab.

const screen = (shell: Page) =>
  shell.locator('[data-testid=terminal-screen] .xterm-rows:visible').first()

async function openTerminal(shell: Page): Promise<void> {
  await shell.locator('[data-testid=pane-add-p2]').click()
  await shell
    .locator('[data-testid=pane-add-menu-p2]')
    .getByRole('menuitem', { name: 'Terminal' })
    .click()
  await expect(shell.locator('[data-testid=terminal-panel]')).toBeVisible()
  await expect(shell.locator('[data-testid=terminal-screen] .xterm').first()).toBeVisible()
}

async function run(shell: Page, command: string): Promise<void> {
  await shell
    .locator('[data-testid=terminal-screen] .xterm-helper-textarea:visible')
    .first()
    .focus()
  await shell.keyboard.type(command)
  await shell.keyboard.press('Enter')
}

test('runs commands in a shell that starts in the chat folder', async ({ shell }) => {
  await openTerminal(shell)
  await run(shell, 'echo relay-$((20+22)) && pwd')
  await expect(screen(shell)).toContainText('relay-42')
})

test('keeps the shell alive across tab switches and ends it with its tab', async ({ shell }) => {
  await openTerminal(shell)
  await run(shell, 'echo pid=$$')
  await expect(screen(shell)).toContainText(/pid=\d+/)
  const pid = Number((await screen(shell).innerText()).match(/pid=(\d+)/)?.[1])
  expect(pid).toBeGreaterThan(1)

  await shell.locator('[data-testid=pane-tab-files]').click()
  await expect(shell.locator('[data-testid=terminal-panel]')).toBeHidden()
  await shell.locator('[data-testid=pane-tab-terminal]').click()
  await expect(screen(shell)).toContainText(`pid=${pid}`)
  expect(() => process.kill(pid, 0)).not.toThrow()

  await shell.locator(`[data-testid=pane-tab-close-terminal]`).click()
  await expect.poll(() => alive(pid)).toBe(false)
})

test('opens more terminals as tabs', async ({ shell }) => {
  await openTerminal(shell)
  await shell.locator('[data-testid=terminal-new]').click()
  await expect(shell.locator('[data-testid=terminal-tab]')).toHaveCount(2)
  await run(shell, 'echo second-shell')
  await expect(screen(shell)).toContainText('second-shell')
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
