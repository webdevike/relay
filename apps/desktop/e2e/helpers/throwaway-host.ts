import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { FIXTURES_DIR, REPO_ROOT } from './paths'

/**
 * A throwaway Relay host (apps/linux test/canvas-throwaway-host.ts): the real room page, board file
 * and canvas service with a scripted mind, on its own relay dir, boards folder and agent socket.
 * Point a test app at it with `env` (EVAOS_RELAY_DIR, EVAOS_CANVAS_DIR); the app adds itself to the
 * host's devices.json. Boards start as a copy of fixtures/canvases. Never touches the live host.
 */
export interface ThrowawayHost {
  /** The boards folder both the host and the app read. */
  canvasDir: string
  port: number
  env: Record<string, string>
  stop(): Promise<void>
}

export async function startThrowawayHost(): Promise<ThrowawayHost> {
  // Short names: the agent socket's path must fit a unix socket's limit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'))
  const relayDir = path.join(root, 'relay')
  const canvasDir = path.join(root, 'canvases')
  fs.cpSync(path.join(FIXTURES_DIR, 'canvases'), canvasDir, { recursive: true })
  const child: ChildProcess = spawn(
    'bun',
    [
      'test/canvas-throwaway-host.ts',
      '--relay-dir',
      relayDir,
      '--canvases',
      canvasDir,
      '--home',
      path.join(root, 'home'),
    ],
    {
      cwd: path.join(REPO_ROOT, 'apps/linux'),
      env: {
        ...process.env,
        RELAY_AGENTS_SOCKET: path.join(root, 'a.sock'),
        XDG_CONFIG_HOME: path.join(root, 'xdg'),
        XDG_RUNTIME_DIR: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  const ready = Promise.withResolvers<number>()
  const timer = setTimeout(
    () => ready.reject(new Error(`throwaway host not ready:\n${output}`)),
    20_000,
  )
  const onData = (chunk: Buffer): void => {
    output += chunk.toString()
    const m = /READY (\d+)/.exec(output)
    if (m) ready.resolve(Number(m[1]))
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.once('exit', (code) => ready.reject(new Error(`throwaway host exited ${code}:\n${output}`)))
  const port = await ready.promise.finally(() => clearTimeout(timer))
  return {
    canvasDir,
    port,
    env: { EVAOS_RELAY_DIR: relayDir, EVAOS_CANVAS_DIR: canvasDir },
    stop: async () => {
      child.removeAllListeners('exit')
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 200))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}
