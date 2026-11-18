import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import type { Env } from './env'
import { buildCommand, childPathFor, runCapture } from './eva/spawn'
import { resolveSetupDir, setupShell } from './setup/runner'

/** start-host.sh waits up to 60 s for serve.json; this only guards a hung script. */
const START_TIMEOUT_MS = 120_000

/** Whether serve.json names a process that is still alive (signal 0 probes without signalling). */
export function hostAlive(
  relayDir: string,
  probe: (pid: number) => void = (pid) => process.kill(pid, 0),
): boolean {
  let pid: unknown
  try {
    const serve: unknown = JSON.parse(fs.readFileSync(path.join(relayDir, 'serve.json'), 'utf8'))
    pid = serve !== null && typeof serve === 'object' && 'pid' in serve ? serve.pid : undefined
  } catch {
    return false
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    probe(pid)
    return true
  } catch (e) {
    // EPERM: alive, just not ours to signal.
    return e instanceof Error && 'code' in e && e.code === 'EPERM'
  }
}

/**
 * Whether this launch should start Relay Host itself: Linux only (macOS has its LaunchAgent), the
 * live stable app outside tests, a local host (not a remote one) that setup installed (host.json)
 * and that is not running now.
 */
export function shouldStartHost(
  env: Pick<Env, 'stable' | 'live' | 'e2e' | 'hiddenWindow' | 'relayDir' | 'relayRemote'>,
  platform: NodeJS.Platform,
  alive: (relayDir: string) => boolean = hostAlive,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (platform !== 'linux') return false
  if (!env.stable || !env.live || env.e2e || env.hiddenWindow) return false
  if (env.relayRemote !== null || env.relayDir === null) return false
  return exists(path.join(env.relayDir, 'host.json')) && !alive(env.relayDir)
}

/**
 * Linux: starts Relay Host (and herdr) once at launch when setup installed it but it is not
 * running, through the setup wizard's start-host.sh (the systemd user unit when there is one, else
 * a detached `relay-host serve`). The Relay client connects on its own once serve.json appears.
 */
export async function autostartHost(env: Env, log: (m: string) => void): Promise<void> {
  if (!shouldStartHost(env, process.platform)) return
  const dir = resolveSetupDir({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    override: process.env.RELAY_SETUP_DIR,
  })
  const script = path.join(dir ?? '', 'start-host.sh')
  if (dir === null || !fs.existsSync(script)) {
    log(`Relay Host: start-host.sh not found in ${dir ?? 'resources/setup'}; not starting it`)
    return
  }
  const home = os.homedir()
  const cmd = buildCommand(setupShell(), [script], {
    pathEnv: await childPathFor(env.live, home),
    homedir: home,
    execPath: process.execPath,
    baseEnv: { ...process.env, RELAY_SETUP_DIR: dir },
  })
  const out = await runCapture(cmd, home, START_TIMEOUT_MS)
  const last = `${out.stdout}\n${out.stderr}`.trim().split('\n').at(-1) ?? ''
  log(
    out.code === 0
      ? `Relay Host: ${last}`
      : `Relay Host did not start (${out.timedOut ? 'timed out' : `exit ${out.code}`}): ${last}`,
  )
}
