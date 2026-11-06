import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

import type { MainContext } from '../context'
import { registerSkillsIpc } from './skills-ipc'

const ORIGIN = 'http://127.0.0.1:7817'
const ROW = {
  name: 'canvas',
  description: 'Boards.',
  source: {
    key: 'eva',
    label: 'Eva',
    dir: '~/Eva/skills/canvas',
    file: '/Users/i/Eva/skills/canvas/SKILL.md',
  },
  also: [],
  updatedAt: 1,
  usedBy: ['nova'],
  disabled: false,
  lastUsedAt: null,
}
const ASSISTANT = { id: 'nova', title: 'Nova', profile: 'personal', color: '#7c5cff' }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('skills IPC', () => {
  const ctx = {} as MainContext
  const call = (channel: string, input: unknown): Promise<unknown> =>
    ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)
  const setup = (origin: string | null, post: unknown): void =>
    registerSkillsIpc(ctx, { canvasOrigin: () => origin, hostToken: () => 'host-token' }, post as typeof fetch)
  beforeEach(() => ipc.handlers.clear())

  it('lists what the host knows and marks it available', async () => {
    const post = vi.fn(async () => json({ skills: [ROW], assistants: [ASSISTANT] }))
    setup(ORIGIN, post)
    expect(await call('skills.list', {})).toEqual({
      ok: true,
      value: { skills: [ROW], assistants: [ASSISTANT], available: true },
    })
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/skills`)
    expect(init.method).toBe('GET')
    expect(init.headers).toBeUndefined()
  })

  it('answers unavailable, not an error, without a host', async () => {
    const post = vi.fn()
    setup(null, post)
    expect(await call('skills.list', {})).toEqual({
      ok: true,
      value: {
        skills: [],
        assistants: [],
        available: false,
        error: 'Skills needs the Relay host running on this Mac.',
      },
    })
    expect(post).not.toHaveBeenCalled()
  })

  it('answers unavailable for a remote host without calling it', async () => {
    const post = vi.fn()
    setup('http://100.85.157.127:7817', post)
    expect(await call('skills.list', {})).toMatchObject({
      ok: true,
      value: { available: false, skills: [], error: expect.stringContaining('remote') },
    })
    expect(post).not.toHaveBeenCalled()
  })

  it('answers unavailable with the reason when the host cannot be reached or refuses', async () => {
    setup(
      ORIGIN,
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    expect(await call('skills.list', {})).toEqual({
      ok: true,
      value: {
        skills: [],
        assistants: [],
        available: false,
        error: "Couldn't reach Relay: ECONNREFUSED",
      },
    })
    ipc.handlers.clear()
    setup(
      ORIGIN,
      vi.fn(async () => json({ error: 'not loopback' }, 403)),
    )
    expect(await call('skills.list', {})).toMatchObject({
      ok: true,
      value: { available: false, error: 'not loopback' },
    })
  })

  it('opens a skill as a websocket address with the token and who Isaac is', async () => {
    const post = vi.fn(async () => json({ token: 'tok', path: '/skills/plug%3Ax' }))
    setup(ORIGIN, post)
    expect(await call('skills.open', { name: 'plug:x' })).toEqual({
      ok: true,
      value: {
        serverUrl: 'ws://127.0.0.1:7817/skills/plug%3Ax',
        room: 'ws',
        token: 'tok',
        user: { name: 'Isaac', color: '#0ea5e9', kind: 'human' },
      },
    })
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/skills/plug%3Ax/open`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ user: { name: 'Isaac', color: '#0ea5e9' } })
  })

  it('saves, and tells a file changed on disk from a failure', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(json({ saved: true, savedAt: 5 }))
      .mockResolvedValueOnce(json({ error: 'changed-on-disk' }, 409))
      .mockResolvedValueOnce(json({ error: 'disk full' }, 500))
    setup(ORIGIN, post)
    expect(await call('skills.save', { name: 'canvas' })).toEqual({
      ok: true,
      value: { status: 'saved' },
    })
    expect(await call('skills.save', { name: 'canvas', force: true })).toEqual({
      ok: true,
      value: { status: 'changed-on-disk' },
    })
    expect(JSON.parse((post.mock.calls[1]![1] as RequestInit).body as string)).toEqual({
      force: true,
    })
    expect(await call('skills.save', { name: 'canvas' })).toEqual({
      ok: false,
      error: { code: 'host-refused', message: 'disk full' },
    })
  })

  it('sends access toggles as JSON and answers the updated row', async () => {
    const post = vi.fn(async () => json({ ...ROW, usedBy: [] }))
    setup(ORIGIN, post)
    expect(await call('skills.access', { name: 'canvas', enabled: { nova: false } })).toEqual({
      ok: true,
      value: { ...ROW, usedBy: [] },
    })
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/skills/canvas/access`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer host-token',
    })
    expect(JSON.parse(init.body as string)).toEqual({ enabled: { nova: false } })
  })

  it('reloads from disk', async () => {
    const post = vi.fn(async () => json({ reloaded: true }))
    setup(ORIGIN, post)
    expect(await call('skills.reload', { name: 'canvas' })).toEqual({
      ok: true,
      value: { reloaded: true },
    })
    expect((post.mock.calls[0] as unknown as [string])[0]).toBe(`${ORIGIN}/skills/canvas/reload`)
  })

  it('says not-found for a missing skill and unavailable without a host', async () => {
    setup(
      ORIGIN,
      vi.fn(async () => json({ error: 'no such skill' }, 404)),
    )
    expect(await call('skills.detail', { name: 'nope' })).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'no such skill' },
    })
    ipc.handlers.clear()
    setup(null, vi.fn())
    expect(await call('skills.detail', { name: 'canvas' })).toMatchObject({
      ok: false,
      error: { code: 'skills-unavailable' },
    })
  })
})
