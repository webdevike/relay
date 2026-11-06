import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

/**
 * cua-driver's MCP server over stdio (trycua, the engine `.omp/tools/computer.ts` uses). Spawned as
 * a plain child of Relay's main process, so macOS charges its Accessibility and Screen Recording
 * use to Relay: `--direct` acts with Relay's own grants (`check_permissions` reports the host's TCC).
 * Without them it falls back to the CuaDriver.app daemon, which holds its own.
 */

const BlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
})
const ReplySchema = z.object({
  id: z.number().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  result: z
    .object({
      isError: z.boolean().optional(),
      content: z.array(BlockSchema).optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})
export type Reply = z.infer<typeof ReplySchema>

export interface Driver {
  call(name: string, args: Record<string, unknown>): Promise<Reply>
  readonly backend: 'direct' | 'daemon'
  close(): void
}

const DRIVER_ENV = {
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_DRIVER_RS_UPDATE_CHECK: '0',
  // A click waits for a possible window change; these keep it near 0.2 s (computer.ts).
  CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS: '150',
  CUA_DRIVER_WINDOW_CHANGE_POLL_MS: '25',
}

/** The cua-driver binary: `CUA_DRIVER_BIN`, else CuaDriver.app's, else `~/.local/bin`; null when none. */
export function driverBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.CUA_DRIVER_BIN,
    '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
    path.join(os.homedir(), '.local/bin/cua-driver'),
  ]
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null
}

export const textOf = (r: Reply): string =>
  r.error?.message ??
  (r.result?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join(' ')
    .trim()

export const failed = (r: Reply): boolean => Boolean(r.error || r.result?.isError)

const CALL_TIMEOUT_MS = 60_000

function spawnDriver(bin: string, args: string[], backend: Driver['backend']): Driver {
  const proc: ChildProcessWithoutNullStreams = spawn(bin, ['mcp', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...DRIVER_ENV },
  })
  const pending = new Map<number, (r: Reply) => void>()
  let nextId = 1
  let closed = false
  const decoder = new StringDecoder('utf8')
  let buf = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let parsed: Reply
      try {
        parsed = ReplySchema.parse(JSON.parse(line))
      } catch {
        continue
      }
      if (parsed.id === undefined) continue
      pending.get(parsed.id)?.(parsed)
      pending.delete(parsed.id)
    }
  })
  proc.stderr.resume()
  const fail = (message: string): void => {
    closed = true
    for (const resolve of pending.values()) resolve({ error: { message } })
    pending.clear()
  }
  proc.on('exit', () => fail('cua-driver exited'))
  proc.on('error', (e) => fail(`cua-driver: ${e.message}`))
  const rpc = (method: string, params: Record<string, unknown>): Promise<Reply> => {
    if (closed) return Promise.resolve({ error: { message: 'cua-driver is not running' } })
    const { promise, resolve } = Promise.withResolvers<Reply>()
    const id = nextId++
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ error: { message: `${method} timed out` } })
    }, CALL_TIMEOUT_MS)
    pending.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return promise
  }
  const ready = rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'relay-computer', version: '1' },
  }).then(() => {
    if (!closed) proc.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  })
  return {
    backend,
    async call(name, args) {
      await ready
      return rpc('tools/call', { name, arguments: args })
    },
    close() {
      closed = true
      proc.stdin.end()
      proc.kill()
    },
  }
}

/** Direct (Relay's grants) when they are held, else the CuaDriver.app daemon. */
export async function connectDriver(bin: string): Promise<Driver> {
  const direct = spawnDriver(bin, ['--direct'], 'direct')
  const perm = (await direct.call('check_permissions', {})).result?.structuredContent
  if (perm?.accessibility === true && perm.screen_recording === true) return direct
  direct.close()
  return spawnDriver(bin, [], 'daemon')
}
