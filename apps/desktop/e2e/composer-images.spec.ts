import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'

const LOG = path.join(os.tmpdir(), `evaos-fake-omp-images-${process.pid}.log`)

// A 1x1 PNG and a 1x1 GIF.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

type Ev = { event: string; detail: { count?: number; mimeTypes?: string[] } | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []

/** Dispatches a DOM event carrying files on the composer (never OS input). */
const fire = (
  shell: Page,
  type: 'paste' | 'dragenter' | 'dragleave' | 'drop',
  files: Array<{ name: string; mime: string; b64?: string; text?: string }>,
): Promise<void> =>
  shell.evaluate(
    ({ type, files }) => {
      const dt = new DataTransfer()
      for (const f of files) {
        const bytes = f.b64
          ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(f.text ?? '')
        dt.items.add(new File([bytes], f.name, { type: f.mime }))
      }
      const target =
        type === 'paste'
          ? document.querySelector('[data-testid=composer-input]')!
          : document.querySelector('[data-testid=composer]')!
      const ev =
        type === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true })
      target.dispatchEvent(ev)
    },
    { type, files },
  )

test.describe('composer images', () => {
  test.use({
    launchEnv: { FAKE_OMP_DELAY_MS: '5', FAKE_OMP_LOG: LOG },
  })
  test.beforeEach(() => {
    fs.rmSync(LOG, { force: true })
  })
  test.afterAll(() => {
    fs.rmSync(LOG, { force: true })
  })

  test('paste, drop, remove and send images', async ({ app, shell }) => {
    await shell.getByTestId('nav-chat').click()
    await shell
      .getByTestId('chat-tree')
      .getByRole('link', {
        name: /^Fixture chat(?:,|$)/,
      })
      .click()
    const log = shell.locator('[data-testid=chat-log]')
    await expect(log).toContainText('Please sketch a tiny greeter.')
    const composer = shell.locator('[data-testid=composer]')

    await fire(shell, 'paste', [{ name: 'a.png', mime: 'image/png', b64: PNG_B64 }])
    await expect(composer.locator('img[alt="Pasted image 1"]')).toBeVisible()

    await fire(shell, 'dragenter', [{ name: 'b.gif', mime: 'image/gif', b64: GIF_B64 }])
    await expect(composer).toContainText('Drop images to attach')
    await fire(shell, 'drop', [{ name: 'b.gif', mime: 'image/gif', b64: GIF_B64 }])
    await expect(composer.locator('[data-testid=composer-chip]')).toHaveCount(2)
    await expect(composer).not.toContainText('Drop images to attach')

    await fire(shell, 'drop', [{ name: 'n.txt', mime: 'text/plain', text: 'hi' }])
    await expect(composer).toContainText('Only images can be attached.')
    await expect(composer.locator('[data-testid=composer-chip]')).toHaveCount(2)

    await proofShot(app, shell, 'composer-images', { phase: 'phase-4' })

    await composer.locator('[aria-label="Remove image 2"]').click()
    await expect(composer.locator('[data-testid=composer-chip]')).toHaveCount(1)

    const box = shell.locator('[data-testid=composer-input]')
    await box.fill('look')
    await box.press('Enter')
    await expect(log).toContainText('Got 1 image(s)')
    await expect(composer.locator('[data-testid=composer-chip]')).toHaveCount(0)
    await expect
      .poll(() => readLog().find((e) => e.event === 'prompt-images')?.detail ?? null)
      .toEqual({ count: 1, mimeTypes: ['image/png'] })
  })
})
