import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'

type Eva = {
  invoke(c: string, i: unknown): Promise<{ ok: boolean; value?: Record<string, unknown> }>
}

test('skeleton: shell renders and app.info round-trips', async ({ app, shell, configDir }) => {
  await expect(shell.locator('[data-testid=rail]')).toContainText('Relay')
  expect(await shell.evaluate(() => typeof (window as unknown as { eva?: Eva }).eva?.invoke)).toBe(
    'function',
  )
  const info = await shell.evaluate(() =>
    (window as unknown as { eva: Eva }).eva.invoke('app.info', {}),
  )
  expect(info.ok).toBe(true)
  const v = info.value!
  expect(String(v.evaRoot).endsWith('fixtures/eva-root')).toBe(true)
  expect(v.configDir).toBe(configDir)
  expect(v.live).toBe(false)
  expect(v.e2e).toBe(true)
  expect(v.launchCount).toBe(1)
  expect(fs.existsSync(path.join(configDir, 'app-state.json'))).toBe(true)
  await expect(shell.locator('[data-testid=env-badge]')).toHaveText('Fixture data')
  const windows = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)
  expect(windows).toBe(1)
  // A window opened while macOS reports it occluded (locked screen, other Space) must still paint.
  const paintsOccluded = await app.evaluate(({ app }) =>
    app.commandLine.hasSwitch('disable-backgrounding-occluded-windows'),
  )
  expect(paintsOccluded).toBe(true)
})
