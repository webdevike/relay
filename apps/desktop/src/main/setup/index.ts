import { app, shell } from 'electron'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { SetupDetectSchema, SetupStateSchema, type SetupState } from '@evaos/contract'
import type { MainContext } from '../context'
import { writeHome } from '../env'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { emit, handle } from '../ipc/handle'
import {
  checkRoot,
  missingScripts,
  planRun,
  resolveHostApp,
  resolveSetupDir,
  runScript,
} from './runner'

const PROGRESS_FILE = 'setup-progress.json'

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** First-run wizard: runs resources/setup scripts and streams their lines to the renderer. */
export function registerSetup(ctx: MainContext): void {
  const home = os.homedir()
  const dir = resolveSetupDir({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    override: process.env.RELAY_SETUP_DIR,
  })
  const hostApp = resolveHostApp({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    override: process.env.RELAY_HOST_APP,
  })
  const running = new Map<
    string,
    { task: string; cancel: () => void; send: (text: string) => boolean; done: Promise<unknown> }
  >()

  const commandFor = async (script: string, args: string[]) => {
    if (dir === null || !fs.existsSync(path.join(dir, script))) {
      fail(
        'setup-scripts-missing',
        `Setup script ${script} was not found (looked in ${dir ?? 'resources/setup'}).`,
      )
    }
    return buildCommand('/bin/bash', [path.join(dir, script), ...args], {
      pathEnv: await childPathFor(ctx.env.live, home),
      homedir: home,
      execPath: process.execPath,
      baseEnv: {
        ...process.env,
        RELAY_SETUP_DIR: dir,
        RELAY_RESOURCES: process.resourcesPath,
        ...(hostApp !== null ? { RELAY_HOST_APP: hostApp } : {}),
      },
    })
  }

  handle(ctx, 'setup.info', async () => {
    const name = await runCapture(
      buildCommand('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        pathEnv: process.env.PATH ?? '',
        homedir: home,
        execPath: process.execPath,
        baseEnv: process.env,
      }),
      home,
      3000,
    )
    const parsed = SetupStateSchema.safeParse(ctx.config.readJson<unknown>(PROGRESS_FILE, {}))
    return {
      computerName: name.stdout.trim() || os.hostname().replace(/\.local$/, ''),
      defaultRoot: ctx.env.profile === 'starter' ? ctx.env.homeRoot : path.join(home, 'Relay'),
      setupDir: dir,
      missing: missingScripts(dir),
      state: parsed.success ? parsed.data : ({ done: [] } satisfies SetupState),
    }
  })

  handle(ctx, 'setup.detect', async () => {
    const r = await runCapture(await commandFor('detect.sh', []), home, 60_000)
    const start = r.stdout.indexOf('{')
    const end = r.stdout.lastIndexOf('}')
    if (start < 0 || end < start) {
      fail('detect-failed', r.stderr.trim().split('\n').pop() || 'detect.sh printed no result')
    }
    const detect = SetupDetectSchema.safeParse(JSON.parse(r.stdout.slice(start, end + 1)))
    if (!detect.success) fail('detect-failed', 'detect.sh printed an unexpected result')
    return { detect: detect.data }
  })

  handle(ctx, 'setup.run', async ({ runId, run }) => {
    if (running.has(runId)) fail('setup-busy', 'That step is already running.')
    if (run.task === 'ai-login') {
      // One browser sign-in at a time: a second `omp login` could not bind the callback port the
      // first still holds, so a retry ends the earlier one first.
      const earlier = [...running.values()].filter((r) => r.task === 'ai-login')
      for (const r of earlier) r.cancel()
      await Promise.all(earlier.map((r) => r.done))
    }
    const plan = planRun(run, home)
    try {
      const cmd = await commandFor(plan.script, plan.args)
      const job = runScript(cmd, home, plan, (line) => {
        if (line.kind === 'progress') {
          emit(ctx, 'setup.progress', { runId, percent: line.percent, line: line.message })
        } else if (line.kind === 'text') {
          emit(ctx, 'setup.progress', { runId, percent: null, line: line.text })
        }
      })
      running.set(runId, { task: run.task, cancel: job.cancel, send: job.send, done: job.done })
      return await job.done
    } finally {
      running.delete(runId)
      plan.cleanup?.()
    }
  })

  handle(ctx, 'setup.cancel', ({ runId }) => {
    running.get(runId)?.cancel()
    return {}
  })

  handle(ctx, 'setup.input', ({ runId, text }) => {
    if (running.get(runId)?.send(text) !== true) {
      fail('setup-not-running', 'That sign-in is no longer running. Start it again.')
    }
    return {}
  })

  handle(ctx, 'setup.state.save', ({ state }) => {
    ctx.config.writeJson(PROGRESS_FILE, state)
    return {}
  })

  handle(ctx, 'setup.openTailscale', async () => {
    const err = await shell.openPath('/Applications/Tailscale.app')
    if (err !== '') fail('tailscale-missing', 'Tailscale is not installed yet.')
    return {}
  })

  handle(ctx, 'setup.health', async ({ root }) => {
    const base = checkRoot(root, home)
    let assistants = 0
    try {
      const reg = JSON.parse(
        fs.readFileSync(path.join(base, '.omp/assistant/agents.json'), 'utf8'),
      ) as { agents?: unknown[] }
      assistants = Array.isArray(reg.agents) ? reg.agents.length : 0
    } catch {
      // not scaffolded yet
    }
    let hostPort: number | null = null
    try {
      const serve = JSON.parse(
        fs.readFileSync(path.join(home, '.config/relay/serve.json'), 'utf8'),
      ) as { port?: unknown }
      if (typeof serve.port === 'number') {
        const port = serve.port
        const probe = Promise.withResolvers<boolean>()
        const s = net.connect({ host: '127.0.0.1', port })
        s.setTimeout(2000)
        s.once('connect', () => probe.resolve(true))
        s.once('timeout', () => probe.resolve(false))
        s.once('error', () => probe.resolve(false))
        const up = await probe.promise
        s.destroy()
        if (up) hostPort = port
      }
    } catch {
      // host not started
    }
    return { assistants, hostPort }
  })

  handle(ctx, 'setup.complete', ({ root, profile, hostName }) => {
    const base = checkRoot(root, home)
    writeHome(ctx.env.configDir, {
      root: base,
      profile,
      setupComplete: true,
      ...(hostName !== '' ? { hostName } : {}),
    })
    ctx.config.writeJson(PROGRESS_FILE, { done: [] })
    // The reply must reach the page before the process goes away.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150)
    return {}
  })

  ctx.onBeforeQuit(async () => {
    for (const r of running.values()) r.cancel()
  })
}
