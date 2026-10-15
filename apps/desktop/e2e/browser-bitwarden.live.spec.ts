import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { recordMetrics } from './helpers/metrics'
import type { Page } from '@playwright/test'

// Opt-in live spec: downloads Bitwarden from the Chrome Web Store (needs network).
// The default gate never runs it.
test.skip(process.env.EVAOS_LIVE !== '1', 'live Web Store install is opt-in (EVAOS_LIVE=1)')
test.use({ launchEnv: { EVAOS_E2E_NETWORK: '1', EVAOS_BITWARDEN_INSTALL: '1' } })

const BITWARDEN_ID = 'nngceckbapebfimnlniiiahkandclblb'

interface Ctx {
  origin?: string
  name?: string
  auxData?: { type?: string }
}
type G = {
  __evaosTest: {
    hooks: { browser: { host: { activeView(): { webContents: WC } } } }
  }
  __bwContexts?: Ctx[]
}
interface WC {
  debugger: {
    attach(v: string): void
    sendCommand(m: string): Promise<unknown>
    on(e: 'message', cb: (ev: unknown, method: string, params: { context?: Ctx }) => void): void
  }
}

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test.setTimeout(150_000)

test('Bitwarden installs from the Web Store into persist:browser and injects', async ({
  app,
  shell,
}) => {
  const list = (page: Page) =>
    page.evaluate(() =>
      (
        window as unknown as { eva: { invoke(c: string, i: unknown): Promise<unknown> } }
      ).eva.invoke('browser.extensions', {}),
    ) as Promise<{ ok: boolean; value: { extensions: Array<{ id: string; version: string }> } }>

  let version = ''
  let installed = false
  try {
    await expect
      .poll(
        async () => {
          const r = await list(shell)
          const e = r.value.extensions.find((x) => x.id === BITWARDEN_ID)
          if (e) version = e.version
          return Boolean(e)
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(true)
    installed = true
  } finally {
    recordMetrics('browser', { bitwardenInstalled: installed, bitwardenVersion: version })
  }

  await app.evaluate(() => {
    const g = globalThis as unknown as G
    const wc = g.__evaosTest.hooks.browser.host.activeView().webContents
    g.__bwContexts = []
    wc.debugger.attach('1.3')
    wc.debugger.on('message', (_e, method, params) => {
      if (method === 'Runtime.executionContextCreated' && params.context) {
        g.__bwContexts!.push(params.context)
      }
    })
    // Not awaited: the reply can stall behind extension startup; contexts stream as events.
    void wc.debugger.sendCommand('Runtime.enable').catch(() => undefined)
  })
  await shell.locator('[data-testid=address-input]').fill(server.url('/form.html'))
  await shell.locator('[data-testid=address-input]').press('Enter')
  await new Promise((r) => setTimeout(r, 5000))
  const contexts = await app.evaluate(() => (globalThis as unknown as G).__bwContexts ?? [])
  const hit = contexts.some(
    (c) =>
      (c.origin ?? '').includes(`chrome-extension://${BITWARDEN_ID}`) ||
      (c.auxData?.type === 'isolated' && /bitwarden/i.test(c.name ?? '')),
  )
  recordMetrics('browser', { bitwardenContentScript: hit })
  console.log(
    'bitwarden contexts',
    JSON.stringify(contexts.map((c) => [c.name, c.origin, c.auxData?.type])),
  )
  expect(hit).toBe(true)
})
