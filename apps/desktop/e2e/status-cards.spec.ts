import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { pageIds, webPanel } from './helpers/web'

const test = base.extend({ launchEnv: { EVAOS_AGENT_CONTROL: '1' } })

interface AgentResult {
  ok: boolean
  value?: Record<string, unknown>
  code?: string
  message?: string
}

/** The app's agent control API, as relay-ctl calls it (bearer token from the control file). */
async function controlApi(configDir: string) {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  return async (action: string, params: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params }),
    })
    return (await res.json()) as AgentResult
  }
}

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

// The one-row status cards (chat/status-card): an X on hover that dismisses, for good.
test('an agent work card shows an X on hover; it hides a running card and closes a finished run', async ({
  app,
  shell,
  configDir,
}) => {
  await expect(shell.locator('[data-pane-tab]').first()).toBeVisible()
  const run = await controlApi(configDir)
  const ok = async (action: string, params: Record<string, unknown>) => {
    const r = await run(action, params)
    expect(r, `${action}: ${r.message}`).toMatchObject({ ok: true })
    return r.value!
  }
  const drive = async (caption: string): Promise<string> => {
    const tabId = (await ok('browser.open', { url: server.url('/shop.html?q=ORICO+2TB') }))
      .tabId as string
    await expect(webPanel(shell, tabId)).toBeVisible()
    await expect
      .poll(async () => (await ok('browser.read', { tabId, mode: 'text' })).text)
      .toContain('Add to Cart')
    await ok('browser.click', { tabId, text: 'Add to Cart', caption })
    return tabId
  }
  const cardOf = (tabId: string) => shell.locator(`[data-testid=agent-work-${tabId}]`)
  const reload = async (): Promise<void> => {
    await shell.reload()
    await shell.waitForSelector('[data-testid=rail]', { state: 'attached' })
  }

  // A running card: the X is there for a mouse and a keyboard, but quiet until then.
  const running = await drive('Adding the ORICO 2TB to the cart')
  const card = cardOf(running)
  await expect(card).toHaveAttribute('data-status', 'working')
  const x = card.getByRole('button', { name: 'Dismiss' })
  await expect(x).toHaveAttribute('aria-label', 'Dismiss')
  await expect(x).toHaveCSS('opacity', '0')
  await card.hover()
  await expect(x).toHaveCSS('opacity', '1')
  await proofShot(app, shell, 'status-card-hover-x', { phase: 'status-cards' })

  // Dismissing a running card only hides it: the page and its run go on.
  await x.click()
  await expect(card).toHaveCount(0)
  await expect(webPanel(shell, running)).toBeVisible()
  await expect
    .poll(async () => {
      const tabs = (await ok('browser.tabs', {})).tabs as Array<{
        tabId: string
        agent?: { status: string }
      }>
      return tabs.find((t) => t.tabId === running)?.agent?.status
    })
    .toBe('working')
  await proofShot(app, shell, 'status-card-dismissed', { phase: 'status-cards' })

  // It stays hidden across a reload, though the run is still going (and when it ends).
  await reload()
  await expect(webPanel(shell, running)).toBeVisible()
  await expect(cardOf(running)).toHaveCount(0)
  await ok('browser.done', { tabId: running, summary: 'Added the ORICO 2TB' })
  await expect(cardOf(running)).toHaveCount(0)

  // A finished run: its X closes the page tab too, from the keyboard (focus is enough to show it).
  const finished = await drive('Adding the ORICO 2TB again')
  await ok('browser.done', { tabId: finished, summary: 'Ordered ORICO 2TB, $89.99' })
  const done = cardOf(finished)
  await expect(done).toHaveAttribute('data-status', 'done')
  await expect(done).toContainText('Ordered ORICO 2TB, $89.99')
  const doneX = done.getByRole('button', { name: 'Dismiss' })
  // The X says what it does: a finished run's also closes the page.
  await expect(doneX).toHaveAttribute('aria-label', 'Dismiss and close tab')
  await doneX.focus()
  await expect(doneX).toHaveCSS('opacity', '1')
  await shell.keyboard.press('Enter')
  await expect(done).toHaveCount(0)
  await expect.poll(async () => (await pageIds(shell)).includes(finished)).toBe(false)
  await expect.poll(async () => (await pageIds(shell)).includes(running)).toBe(true)
  await reload()
  await expect(cardOf(finished)).toHaveCount(0)
  await expect(cardOf(running)).toHaveCount(0)
})
