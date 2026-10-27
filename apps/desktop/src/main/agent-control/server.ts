import * as http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type { AgentResult } from '@evaos/contract'

/**
 * The agent control API: plain HTTP on 127.0.0.1 with a bearer token, free of electron so tests
 * can run it. Every request must come from loopback, name a loopback Host (no DNS rebinding) and
 * carry the token; anything else gets 403/401 before a route runs.
 *
 *   GET  /actions        the action catalog (params as JSON Schema)
 *   POST /actions/:id    { params?, confirm? } runs one action
 *   GET  /state          same as POST /actions/state.read
 *   GET  /screenshot     image/png of the window
 */
export interface ControlServerDeps {
  token: string
  catalog(): unknown
  run(id: string, body: RunBody): Promise<AgentResult>
  screenshot(): Promise<Buffer>
}

export const RunBodySchema = z
  .object({ params: z.unknown().optional(), confirm: z.boolean().optional() })
  .strict()
export type RunBody = z.output<typeof RunBodySchema>

const MAX_BODY = 1_000_000

const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  'confirm-required': 403,
  denied: 403,
  'not-found': 404,
  'unknown-action': 404,
  'invalid-params': 400,
  'invalid-body': 400,
  'too-large': 413,
  'renderer-timeout': 504,
}

/** HTTP status for a failed result; unknown codes are action failures (422). */
export function statusOf(r: AgentResult): number {
  if (r.ok) return r.queued ? 202 : 200
  return STATUS[r.code] ?? 422
}

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** The Host header must name loopback on our port, so a rebinding page can't reach the API. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

export function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(header ?? '')
  if (!m) return false
  const a = Buffer.from(m[1]!)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(text)
}

const fail = (code: string, message: string): AgentResult => ({ ok: false, code, message })

function readBody(req: http.IncomingMessage): Promise<string | null> {
  const { promise, resolve, reject } = Promise.withResolvers<string | null>()
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_BODY) {
      resolve(null)
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
  return promise
}

async function route(
  deps: ControlServerDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const reply = (r: AgentResult): void => send(res, statusOf(r), r)

  if (req.method === 'GET' && url.pathname === '/actions') {
    send(res, 200, { ok: true, value: deps.catalog() })
    return
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    reply(await deps.run('state.read', {}))
    return
  }
  if (req.method === 'GET' && url.pathname === '/screenshot') {
    const png = await deps.screenshot()
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(png)
    return
  }
  const m = /^\/actions\/([\w.-]{1,64})$/.exec(url.pathname)
  if (req.method === 'POST' && m) {
    const raw = await readBody(req)
    if (raw === null) {
      reply(fail('too-large', 'Body over 1 MB'))
      return
    }
    let json: unknown = {}
    try {
      if (raw.trim() !== '') json = JSON.parse(raw)
    } catch {
      reply(fail('invalid-body', 'Body is not JSON'))
      return
    }
    const body = RunBodySchema.safeParse(json)
    if (!body.success) {
      reply(fail('invalid-body', body.error.message))
      return
    }
    reply(await deps.run(m[1]!, body.data))
    return
  }
  reply(fail('not-found', `No route ${req.method} ${url.pathname}`))
}

export interface ControlServer {
  port: number
  close(): Promise<void>
}

/** Listens on 127.0.0.1 (port 0 picks a free one). */
export function startControlServer(deps: ControlServerDeps, port = 0): Promise<ControlServer> {
  const server = http.createServer((req, res) => {
    const own = (server.address() as AddressInfo).port
    if (!isLoopback(req.socket.remoteAddress) || !hostAllowed(req.headers.host, own)) {
      send(res, 403, fail('forbidden', 'Loopback only'))
      return
    }
    if (!tokenMatches(req.headers.authorization, deps.token)) {
      send(res, 401, fail('unauthorized', 'Missing or wrong bearer token'))
      return
    }
    route(deps, req, res).catch((e: unknown) => {
      if (!res.headersSent)
        send(res, 500, fail('internal', e instanceof Error ? e.message : String(e)))
    })
  })
  const { promise, resolve, reject } = Promise.withResolvers<ControlServer>()
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => {
    server.off('error', reject)
    resolve({
      port: (server.address() as AddressInfo).port,
      close: () => {
        const closed = Promise.withResolvers<void>()
        server.closeAllConnections()
        server.close(() => closed.resolve())
        return closed.promise
      },
    })
  })
  return promise
}
