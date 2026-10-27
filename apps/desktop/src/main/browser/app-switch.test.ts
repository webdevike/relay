import { describe, expect, it, vi } from 'vitest'
import { listSwitchApps, selectSwitchApp, type SessionFetch } from './app-switch'

const app = {
  id: 'rbac',
  ticket: 'ENG-6476',
  title: 'Build the Access matrix page in Administration',
  branch: 'feat/ENG-6476-access-matrix-page',
  port: 3051,
  worktree: 'work/react-client-reports-app-ENG-6476',
  api: 'dev',
  running: true,
  active: true,
}

const answering = (status: number, body: string) =>
  vi.fn<SessionFetch>(async () => new Response(body, { status }))

describe('listSwitchApps', () => {
  it('asks the switch origin for its apps and parses them', async () => {
    const fetch = answering(
      200,
      JSON.stringify([app, { ...app, id: 'x', ticket: null, branch: null, active: false }]),
    )
    const apps = await listSwitchApps(fetch)
    expect(apps.map((a) => [a.id, a.active])).toEqual([
      ['rbac', true],
      ['x', false],
    ])
    expect(fetch).toHaveBeenCalledWith(
      'https://localhost:3001/__apps',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
  })

  it('rejects a body that is not an app list, as from a switch without /__apps', async () => {
    await expect(
      listSwitchApps(answering(200, '<!doctype html><html></html>')),
    ).rejects.toMatchObject({
      code: 'app-switch-outdated',
    })
    await expect(
      listSwitchApps(answering(200, JSON.stringify([{ ...app, port: 'x' }]))),
    ).rejects.toMatchObject({
      code: 'app-switch-outdated',
    })
    await expect(
      listSwitchApps(answering(200, JSON.stringify([{ ...app, id: '../x' }]))),
    ).rejects.toMatchObject({
      code: 'app-switch-outdated',
    })
  })

  it('reports a switch that is not answering', async () => {
    const fetch = vi.fn<SessionFetch>(async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED')
    })
    await expect(listSwitchApps(fetch)).rejects.toMatchObject({
      code: 'app-switch-down',
      message: expect.stringContaining('ERR_CONNECTION_REFUSED'),
    })
  })
})

describe('selectSwitchApp', () => {
  it('posts the id and resolves with the app the switch now serves', async () => {
    const fetch = answering(200, JSON.stringify({ active: 'rbac' }))
    await expect(selectSwitchApp(fetch, 'rbac')).resolves.toBe('rbac')
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://localhost:3001/__switch')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ id: 'rbac' })
  })

  it("surfaces the switch's refusal for an unknown app", async () => {
    const fetch = answering(404, JSON.stringify({ error: 'no app "gone"; registered: rbac' }))
    await expect(selectSwitchApp(fetch, 'gone')).rejects.toMatchObject({
      code: 'unknown-app',
      message: 'The app switch refused: no app "gone"; registered: rbac.',
    })
  })
})
