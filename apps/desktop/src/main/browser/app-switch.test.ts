import { describe, expect, it, vi } from 'vitest'
import { listSwitchApps, type SessionFetch } from './app-switch'

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
const two = [app, { ...app, id: 'assets', ticket: 'ENG-6406', active: false }]

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

  it("marks the tab's own app active instead of the partition cookie's", async () => {
    const apps = await listSwitchApps(answering(200, JSON.stringify(two)), 'assets')
    expect(apps.map((a) => [a.id, a.active])).toEqual([
      ['rbac', false],
      ['assets', true],
    ])
  })

  it("keeps the switch's answer when the tab has no app or one the switch dropped", async () => {
    for (const tabApp of [undefined, 'gone']) {
      const apps = await listSwitchApps(answering(200, JSON.stringify(two)), tabApp)
      expect(apps.map((a) => a.active)).toEqual([true, false])
    }
  })

  it('rejects a body that is not an app list, as from a switch without /__apps', async () => {
    for (const body of [
      '<!doctype html><html></html>',
      JSON.stringify([{ ...app, port: 'x' }]),
      JSON.stringify([{ ...app, id: '../x' }]),
    ]) {
      await expect(listSwitchApps(answering(200, body))).rejects.toMatchObject({
        code: 'app-switch-outdated',
      })
    }
  })

  it("surfaces the switch's own error", async () => {
    await expect(
      listSwitchApps(answering(500, JSON.stringify({ error: 'registry unreadable' }))),
    ).rejects.toMatchObject({
      code: 'app-switch-error',
      message: 'The app switch refused: registry unreadable.',
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
