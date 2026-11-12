import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { openPage, webPanel } from './helpers/web'
import { APP_DIR } from './helpers/paths'

const test = base.extend({ launchEnv: { EVAOS_AGENT_CONTROL: '1' } })

// The agent's cursor shows the route before it goes (dotted path + target), glides along it, and
// leaves a trail of its last few moves that fades over seconds. Frames of the page on screen are
// captured while the agent clicks; EVAOS_TRAIL_FRAMES=<dir> keeps them for a clip.

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('agent cursor: lookahead route, eased glide, lingering trail, ripple', async ({
  app,
  shell,
  configDir,
}) => {
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  const run = async (action: string, params: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params, scope: 'agent:nova' }),
    })
    return (await res.json()) as { ok: boolean; value?: Record<string, unknown>; message?: string }
  }
  const tabId = await openPage(shell, server.url('/demo-shop.html'), 'Sprout Supply')
  await expect(webPanel(shell, tabId)).toBeVisible()

  // Capture the shown page ~12 fps while the agent works.
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __evaosTest: {
        views(): Array<{
          getVisible(): boolean
          webContents: { capturePage(): Promise<{ toPNG(): Buffer }> }
        }>
      }
      __trail?: { frames: Buffer[]; stop: boolean }
    }
    const st = { frames: [] as Buffer[], stop: false }
    g.__trail = st
    void (async () => {
      const t0 = Date.now()
      while (!st.stop && Date.now() - t0 < 25_000) {
        const v = g.__evaosTest.views().filter((x) => x.getVisible())
        const big = v[v.length - 1]
        if (big) st.frames.push((await big.webContents.capturePage()).toPNG())
        await new Promise((r) => setTimeout(r, 40))
      }
    })()
  })

  const t0 = Date.now()
  const click = async (selector: string, caption: string) => {
    const r = await run('browser.click', { tabId, selector, caption })
    expect(r.ok, r.message).toBe(true)
    return Date.now() - t0
  }
  await click('.card:nth-child(1) button', 'Adding the first plant')
  await click('.card:nth-child(6) button', 'Adding the last one')
  await click('#go', 'Searching')
  await click('.card:nth-child(3) button', 'Adding another')
  const secondRun = Date.now()
  // The action is not slowed much by the cursor: four travelling clicks stay under 6 s.
  expect(secondRun - t0).toBeLessThan(6000)
  await new Promise((r) => setTimeout(r, 2500))

  const frames = await app.evaluate(async () => {
    const g = globalThis as unknown as { __trail: { frames: Buffer[]; stop: boolean } }
    g.__trail.stop = true
    return g.__trail.frames.map((b) => b.toString('base64'))
  })
  expect(frames.length).toBeGreaterThan(10)
  const dir = process.env.EVAOS_TRAIL_FRAMES ?? path.join(APP_DIR, 'test-results/agent-trail')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  frames.forEach((b, i) =>
    fs.writeFileSync(
      path.join(dir, `f${String(i).padStart(4, '0')}.png`),
      Buffer.from(b, 'base64'),
    ),
  )
})
