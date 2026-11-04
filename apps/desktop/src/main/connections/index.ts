import { shell } from 'electron'
import { spawn } from 'node:child_process'
import * as os from 'node:os'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { emit, handle } from '../ipc/handle'
import { createConnections, parseGhDeviceCode, type Connections } from './connections'

const RUN_TIMEOUT_MS = 15_000
/** GitHub's device code lives 15 minutes; gh gives up then too. */
const GH_LOGIN_TIMEOUT_MS = 15 * 60_000
const GH_CODE_WAIT_MS = 20_000

/**
 * Settings > Connections: the list, Isaac's Connect and Disconnect, and the change event; the
 * same object backs the connections.* agent actions (agent-control).
 */
export function registerConnections(
  ctx: MainContext,
  host: () => { name: string; version: string } | null,
): Connections {
  const home = os.homedir()
  let pathEnv: Promise<string> | null = null
  const command = async (bin: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
    pathEnv ??= childPathFor(ctx.env.live, home)
    return buildCommand(bin, args, {
      pathEnv: await pathEnv,
      homedir: home,
      execPath: process.execPath,
      baseEnv: { ...process.env, ...extra },
    })
  }

  const connections = createConnections({
    evaRoot: ctx.env.evaRoot,
    configDir: ctx.env.configDir,
    probe: ctx.env.live && !ctx.env.e2e,
    onMini: ctx.env.relayRemote !== null,
    host,
    ompBin: ctx.env.ompBin,
    run: async (bin, args) =>
      runCapture(await command(bin, args, { GH_PROMPT_DISABLED: '1' }), home, RUN_TIMEOUT_MS),
    linearViewer: async (key) => {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query: '{ viewer { name } }' }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { data?: { viewer?: { name?: string } } }
      return body.data?.viewer?.name ?? null
    },
    ghLogin: async () => {
      // Not a terminal: gh prints the code and the device page and waits for the browser. No
      // --git-protocol, so gh leaves git's settings and credential helper as they are.
      const cmd = await command('gh', ['auth', 'login', '--web', '--hostname', 'github.com'])
      const child = spawn(cmd.file, cmd.argv, { cwd: home, env: cmd.env, stdio: 'pipe' })
      child.stdin.end('\n')
      const ended = Promise.withResolvers<boolean>()
      child.on('close', (code) => ended.resolve(code === 0))
      child.on('error', () => ended.resolve(false))
      const done = ended.promise
      const kill = setTimeout(() => child.kill('SIGTERM'), GH_LOGIN_TIMEOUT_MS)
      void done.then(() => clearTimeout(kill))
      let out = ''
      const printed = Promise.withResolvers<{ code: string; url: string } | null>()
      const timer = setTimeout(() => printed.resolve(null), GH_CODE_WAIT_MS)
      const hear = (chunk: Buffer): void => {
        out += chunk.toString('utf8')
        const parsed = parseGhDeviceCode(out)
        if (parsed) printed.resolve(parsed)
      }
      child.stdout.on('data', hear)
      child.stderr.on('data', hear)
      void done.then(() => printed.resolve(parseGhDeviceCode(out)))
      const found = await printed.promise
      clearTimeout(timer)
      if (found === null) {
        child.kill('SIGTERM')
        throw Object.assign(new Error('gh did not start a sign-in (is gh installed?)'), {
          code: 'gh-failed',
        })
      }
      void shell.openExternal(found.url)
      return { ...found, done }
    },
  })

  handle(ctx, 'connections.list', async () => ({ connections: await connections.list() }))
  handle(ctx, 'connections.connect', ({ id, secret }) => connections.connect(id, secret))
  handle(ctx, 'connections.disconnect', async ({ id }) => {
    await connections.remove(id)
    return {}
  })
  connections.onChange((rows) => emit(ctx, 'connections.changed', { connections: rows }))
  return connections
}
