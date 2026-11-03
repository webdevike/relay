import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { request } from 'node:http'
import type { AgentResult } from '@evaos/contract'
import {
  hostAllowed,
  isLoopback,
  startControlServer,
  statusOf,
  tokenMatches,
  type ControlServer,
  type ControlServerDeps,
} from './server'
import { runAgentRequest } from './run'
import { CONTROL_FILE, removeControlFile, writeControlFile } from './control-file'

const TOKEN = 'a'.repeat(64)

let server: ControlServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

function call(
  port: number,
  opts: { method?: string; path: string; token?: string; host?: string; body?: string },
): Promise<{ status: number; body: string; type: string | undefined }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number
    body: string
    type: string | undefined
  }>()
  const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const req = request(
    { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers },
    (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          type: res.headers['content-type'],
        }),
      )
    },
  )
  req.on('error', reject)
  req.end(opts.body)
  return promise
}

async function start(overrides: Partial<ControlServerDeps> = {}): Promise<ControlServer> {
  server = await startControlServer({
    token: TOKEN,
    catalog: () => [{ id: 'files.open' }],
    run: (id, body) =>
      runAgentRequest(id, body, {
        run: async (aid, _spec, params) => ({ ok: true, value: { ran: aid, params } }),
        ask: async () => false,
      }),
    screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ...overrides,
  })
  return server
}

describe('agent control server', () => {
  it('listens on 127.0.0.1 only', async () => {
    const s = await start()
    expect(s.port).toBeGreaterThan(0)
    // A non-loopback interface address (when the Mac has one) refuses the connection.
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)
    if (external) {
      const refused = Promise.withResolvers<boolean>()
      const req = request({ host: external.address, port: s.port, path: '/actions' }, () =>
        refused.resolve(false),
      )
      req.on('error', () => refused.resolve(true))
      req.end()
      expect(await refused.promise).toBe(true)
    }
  })

  it('answers 401 without the bearer token or with a wrong one', async () => {
    const s = await start()
    expect((await call(s.port, { path: '/actions' })).status).toBe(401)
    expect((await call(s.port, { path: '/actions', token: 'b'.repeat(64) })).status).toBe(401)
    expect((await call(s.port, { path: '/state' })).status).toBe(401)
    expect((await call(s.port, { method: 'POST', path: '/actions/files.open' })).status).toBe(401)
  })

  it('refuses a foreign Host header (DNS rebinding) before checking the token', async () => {
    const s = await start()
    const r = await call(s.port, { path: '/actions', token: TOKEN, host: 'evil.example:80' })
    expect(r.status).toBe(403)
  })

  it('serves the catalog, runs actions and returns the screenshot with the token', async () => {
    const s = await start()
    const list = await call(s.port, { path: '/actions', token: TOKEN })
    expect(list.status).toBe(200)
    expect(JSON.parse(list.body)).toEqual({ ok: true, value: [{ id: 'files.open' }] })

    const run = await call(s.port, {
      method: 'POST',
      path: '/actions/files.open',
      token: TOKEN,
      body: JSON.stringify({ params: { path: '.omp/skills' } }),
    })
    expect(run.status).toBe(200)
    expect(JSON.parse(run.body).value).toEqual({
      ran: 'files.open',
      params: { path: '.omp/skills' },
    })

    const shot = await call(s.port, { path: '/screenshot', token: TOKEN })
    expect(shot.status).toBe(200)
    expect(shot.type).toBe('image/png')
  })

  it('maps bad requests to 4xx', async () => {
    const s = await start()
    const post = (p: string, body?: string) =>
      call(s.port, { method: 'POST', path: p, token: TOKEN, body })
    expect((await post('/actions/nope.nope')).status).toBe(404)
    expect((await post('/actions/files.open', '{')).status).toBe(400)
    expect((await post('/actions/files.open', JSON.stringify({ params: {} }))).status).toBe(400)
    expect((await post('/actions/files.open', JSON.stringify({ bogus: 1 }))).status).toBe(400)
    expect((await post('/actions/app.quit')).status).toBe(403)
    expect((await call(s.port, { path: '/nowhere', token: TOKEN })).status).toBe(404)
  })

  it('reports queued runs as 202', () => {
    const queued: AgentResult = { ok: true, value: null, queued: true }
    expect(statusOf(queued)).toBe(202)
    expect(statusOf({ ok: true, value: null })).toBe(200)
    expect(statusOf({ ok: false, code: 'outside-eva', message: '' })).toBe(422)
  })
})

describe('request checks', () => {
  it('accepts loopback peers only', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('192.168.1.20')).toBe(false)
    expect(isLoopback('::ffff:10.0.0.2')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })

  it('accepts loopback Host headers on our port only', () => {
    expect(hostAllowed('127.0.0.1:4000', 4000)).toBe(true)
    expect(hostAllowed('localhost:4000', 4000)).toBe(true)
    expect(hostAllowed('127.0.0.1:4001', 4000)).toBe(false)
    expect(hostAllowed('attacker.test:4000', 4000)).toBe(false)
    expect(hostAllowed(undefined, 4000)).toBe(false)
  })

  it('compares the token exactly', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(tokenMatches(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(false)
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false)
    expect(tokenMatches(undefined, TOKEN)).toBe(false)
  })
})

describe('control file', () => {
  it('is written owner-only and removed only by its own process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-control-'))
    const file = writeControlFile(dir, { port: 4321, token: TOKEN })
    expect(file).toBe(path.join(dir, CONTROL_FILE))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      port: 4321,
      token: TOKEN,
      url: 'http://127.0.0.1:4321',
      pid: process.pid,
    })

    const spy = vi.spyOn(process, 'pid', 'get').mockReturnValue(process.pid + 1)
    removeControlFile(file)
    spy.mockRestore()
    expect(fs.existsSync(file)).toBe(true)
    removeControlFile(file)
    expect(fs.existsSync(file)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
