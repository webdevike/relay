import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSchema } from '@evaos/contract'
import { createConnections, parseGhDeviceCode, type ConnectionsDeps } from './connections'

const KEY = `lin_api_${'k'.repeat(40)}`
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'connections-'))
  fs.mkdirSync(path.join(root, 'eva'))
  fs.mkdirSync(path.join(root, 'config'))
  vi.stubEnv('LINEAR_API_KEY', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

function deps(over: Partial<ConnectionsDeps> = {}): ConnectionsDeps {
  return {
    evaRoot: path.join(root, 'eva'),
    configDir: path.join(root, 'config'),
    probe: true,
    onMini: false,
    host: () => ({ name: 'Mac mini', version: '0.2.45' }),
    ompBin: 'omp',
    run: async (bin, args) =>
      bin === 'gh'
        ? { code: 0, stdout: args[0] === 'api' ? 'webdevike\n' : '' }
        : {
            code: 0,
            stdout: JSON.stringify({
              accounts: [{ provider: 'anthropic' }, { provider: 'mcp_oauth:x' }],
            }),
          },
    ghLogin: async () => ({
      code: 'ABCD-1234',
      url: 'https://github.com/login/device',
      done: new Promise(() => {}),
    }),
    linearViewer: async (key) => (key === KEY ? 'Isaac Weber' : null),
    ...over,
  }
}

describe('connections on a thin client', () => {
  it('shows every service as the Mini’s, checks nothing here and changes nothing here', async () => {
    const run = vi.fn(deps().run)
    const c = createConnections(deps({ onMini: true, run }))
    const rows = await c.list()
    for (const r of rows) ConnectionSchema.parse(r)
    expect(rows.find((r) => r.id === 'relay-host')).toMatchObject({
      status: 'connected',
      account: 'Mac mini',
    })
    for (const r of rows.filter((r) => r.id !== 'relay-host')) {
      expect(r).toMatchObject({
        status: 'unknown',
        canAdd: false,
        canRemove: false,
        detail: expect.stringContaining('on the Mini'),
      })
    }
    expect(run).not.toHaveBeenCalled()
    await expect(c.connect('github', undefined)).rejects.toMatchObject({ code: 'on-the-mini' })
    await expect(c.add('linear', KEY)).rejects.toMatchObject({ code: 'on-the-mini' })
    await expect(c.remove('github')).rejects.toMatchObject({ code: 'on-the-mini' })
    expect(fs.existsSync(path.join(root, 'config/connections/linear.env'))).toBe(false)
  })
})

describe('connections', () => {
  it('lists every service with where it comes from, and no secret anywhere', async () => {
    fs.mkdirSync(path.join(root, 'eva/secrets'))
    fs.writeFileSync(path.join(root, 'eva/secrets/linear.env'), `export LINEAR_API_KEY=${KEY}\n`)
    const rows = await createConnections(deps()).list()
    for (const r of rows) ConnectionSchema.parse(r)
    expect(JSON.stringify(rows)).not.toContain(KEY)
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by['relay-host']).toMatchObject({ status: 'connected', account: 'Mac mini' })
    expect(by.github).toMatchObject({ status: 'connected', account: 'webdevike', canRemove: true })
    expect(by.linear).toMatchObject({
      status: 'connected',
      account: 'Isaac Weber',
      detail: "Key from Eva's secrets/linear.env",
      canRemove: false,
      link: 'relay://open/settings/connections?connect=linear',
    })
    expect(by.anthropic).toMatchObject({ status: 'connected' })
    expect(by.openai).toMatchObject({ status: 'not-connected' })
  })

  it("saves a Linear key 0600 in Relay's config, never answers it, and removes only that", async () => {
    const c = createConnections(deps())
    const heard = vi.fn()
    c.onChange(heard)
    const r = await c.add('linear', KEY)
    expect(r).toEqual({ status: 'connected', id: 'linear', account: 'Isaac Weber' })
    const file = path.join(root, 'config/connections/linear.env')
    expect(fs.readFileSync(file, 'utf8')).toBe(`LINEAR_API_KEY=${KEY}\n`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    await vi.waitFor(() => expect(heard).toHaveBeenCalled())
    expect(JSON.stringify(heard.mock.calls)).not.toContain(KEY)
    await c.remove('linear')
    expect(fs.existsSync(file)).toBe(false)
    await expect(c.remove('linear')).rejects.toMatchObject({ code: 'not-connected' })
  })

  it('refuses a key Linear refuses, and keys it did not save', async () => {
    const c = createConnections(deps())
    await expect(c.add('linear', `lin_api_${'x'.repeat(40)}`)).rejects.toMatchObject({
      code: 'key-refused',
    })
    expect(fs.existsSync(path.join(root, 'config/connections/linear.env'))).toBe(false)
    vi.stubEnv('LINEAR_API_KEY', KEY)
    await expect(c.remove('linear')).rejects.toMatchObject({
      code: 'not-removable',
      message: expect.stringContaining('LINEAR_API_KEY'),
    })
    await expect(c.remove('anthropic')).rejects.toMatchObject({ code: 'not-removable' })
  })

  it('answers the step and deep link for a sign-in only Isaac can do', async () => {
    const c = createConnections(
      deps({ run: async () => ({ code: 1, stdout: '' }), host: () => null }),
    )
    expect(await c.add('github', undefined)).toMatchObject({
      status: 'needs-user',
      link: 'relay://open/settings/connections?connect=github',
      step: expect.stringContaining('Connect on GitHub'),
    })
    expect(await c.add('linear', undefined)).toMatchObject({
      status: 'needs-user',
      url: 'https://linear.app/settings/account/security',
    })
    expect(await c.add('relay-host', undefined)).toMatchObject({ link: 'relay://open/setup' })
    expect(await c.connect('github', undefined)).toMatchObject({ code: 'ABCD-1234' })
    expect((await c.list()).find((r) => r.id === 'github')?.detail).toBe(
      'Signing in: enter ABCD-1234 at https://github.com/login/device',
    )
  })

  it('checks nothing outside the live app', async () => {
    const run = vi.fn()
    const rows = await createConnections(deps({ probe: false, run })).list()
    expect(run).not.toHaveBeenCalled()
    expect(rows.find((r) => r.id === 'github')).toMatchObject({ status: 'unknown' })
    await expect(
      createConnections(deps({ probe: false })).connect('github', undefined),
    ).rejects.toMatchObject({
      code: 'not-live',
    })
  })

  it("reads gh's device code", () => {
    expect(
      parseGhDeviceCode(
        '! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://github.com/login/device\n',
      ),
    ).toEqual({ code: '1A2B-3C4D', url: 'https://github.com/login/device' })
    expect(parseGhDeviceCode('starting')).toBeNull()
  })
})
