import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'

// Settings > About: the build, the update channel, the connected host's name and version (from its
// welcome frame) and a Check now button; the sidebar logo's tooltip names the build.
let host: FakeRelayHost
let root: string

const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-about-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.macVersion = '0.2.52'
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

test('About names the build and the host version; the logo tooltip names the build', async ({
  shell,
}) => {
  await shell.locator('[data-testid=nav-setting]').click()
  await shell.locator('[data-testid=settings-item-about]').click()
  await expect(shell.locator('[data-testid=about-host]')).toHaveText('Fake Mac 0.2.52')
  await expect(shell.locator('[data-testid=about-channel]')).toHaveText(/stable|dev/)
  await expect(shell.locator('[data-testid=about-build]')).toContainText('built ')
  await shell.locator('[data-testid=about-check]').click()
  await expect(shell.locator('[data-testid=about-check-result]')).toHaveText(
    'This copy has no update source.',
  )
  const shot = process.env.ABOUT_SHOT
  if (shot) await shell.locator('[data-testid=settings-build]').screenshot({ path: shot })
})

test('the sidebar logo says the build and its date', async ({ shell }) => {
  await shell.locator('.eva-sb-brand').hover()
  await expect(shell.getByRole('tooltip')).toHaveText(/^Relay \S+ · \w{3} \d+, \d+:\d{2} [AP]M$/)
})
