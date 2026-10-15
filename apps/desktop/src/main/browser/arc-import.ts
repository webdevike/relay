import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Session } from 'electron'
import { parseArcExport } from '@evaos/browser-core/arc-cookies'
import type { Env } from '../env'
import type { BrowserHost } from './browser-host'

const TIMEOUT_MS = 30_000

function fail(reason: string): Error {
  return Object.assign(new Error(reason), { code: 'arc-export-failed' })
}

/** Same lookup idea as the omp binary: PATH first, then the usual install locations. */
function resolveCommand(cmd: string, home: string): string {
  if (cmd.includes('/')) return cmd
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  dirs.push(path.join(home, '.bun/bin'), path.join(home, '.local/bin'), '/opt/homebrew/bin')
  for (const d of dirs) {
    const candidate = path.join(d, cmd)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return cmd
}

function runExporter(argv: string[], cwd: string): Promise<string> {
  const [cmd, ...args] = argv
  return new Promise((resolve, reject) => {
    // argv array, no shell (T-01-45); stdin ignored so the tool can never wait on input.
    const child = spawn(resolveCommand(cmd!, os.homedir()), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      reject(fail('The Arc export timed out'))
    }, TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(fail(`Could not run the Arc export (${(e as NodeJS.ErrnoException).code ?? 'spawn'})`))
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code !== 0) {
        // Only stderr's last line; stdout may hold cookie data and is never surfaced.
        const last = err.trim().split('\n').pop()?.trim() ?? ''
        reject(fail(last ? last.slice(0, 200) : 'The Arc export failed'))
        return
      }
      resolve(out)
    })
  })
}

/**
 * Runs Eva's Arc exporter and stores the cookies in persist:browser only, then reloads the
 * active tab. Runs only from the explicit IPC call, never on launch. Values are never logged.
 */
export async function importArcLogins(
  env: Env,
  guestSession: Session,
  host: BrowserHost,
): Promise<{ count: number }> {
  if (!env.arcExportCmd) throw fail('No Arc exporter is configured')
  const stdout = await runExporter(env.arcExportCmd, env.evaRoot)
  let cookies
  try {
    cookies = parseArcExport(stdout)
  } catch (e) {
    throw fail((e as Error).message)
  }
  let count = 0
  for (const c of cookies) {
    try {
      await guestSession.cookies.set(c)
      count++
    } catch {
      /* skipped; the cookie is not logged */
    }
  }
  const active = host.activeTabId()
  if (active) host.reload(active)
  return { count }
}
