import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyOperations,
  dockerRunArgs,
  disableInConfig,
  enableInConfig,
  hindsightStatus,
  installHindsight,
  parseInspect,
  pickLlm,
  readConfig,
  reloginHindsight,
  removeHindsight,
  restartHindsight,
  updateHindsight,
  type DockerResult,
  type HindsightDeps,
} from './hindsight'
import { llmRunScript, localLlmEnv, localModelFor, nativePaths } from './hindsight-native'
import { HindsightError, firstFreePort } from './hindsight-util'

const tmps: string[] = []
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const URL = 'http://127.0.0.1:18888'
const cfg = (): { apiUrl: string; bankId: string; retainContext: string } => ({
  apiUrl: URL,
  bankId: 'ada',
  retainContext: 'ctx',
})

describe('omp config.yml edits', () => {
  it('adds the blocks to an empty file', () => {
    const out = enableInConfig('', cfg())
    expect(readConfig(out)).toEqual({ backend: 'hindsight', apiUrl: URL, bankId: 'ada' })
    expect(out).toContain('recallTypes:\n    - world')
  })

  it('keeps unrelated keys and merges into an existing memory block', () => {
    const before = 'theme:\n  dark: onyx\nmemory:\n  other: 1\nmodelRoles:\n  default: x\n'
    const out = enableInConfig(before, cfg())
    expect(out).toContain('theme:\n  dark: onyx')
    expect(out).toContain('memory:\n  other: 1\n  backend: hindsight')
    expect(out).toContain('modelRoles:\n  default: x')
  })

  it('is idempotent and updates a moved url without dropping the user tweaks', () => {
    const once = enableInConfig('hindsight:\n  recallTypes:\n    - world\n', cfg())
    expect(enableInConfig(once, cfg())).toBe(once)
    const moved = enableInConfig(once, { ...cfg(), apiUrl: 'http://127.0.0.1:18889' })
    expect(readConfig(moved).apiUrl).toBe('http://127.0.0.1:18889')
    expect(moved.match(/recallTypes:/g)).toHaveLength(1)
    expect(moved).not.toContain('- experience')
  })

  it('disables only a config that points at our url', () => {
    const on = enableInConfig('theme:\n  dark: onyx\n', cfg())
    const off = disableInConfig(on, URL)
    expect(readConfig(off)).toEqual({ backend: null, apiUrl: null, bankId: null })
    expect(off).toContain('theme:\n  dark: onyx')
    expect(off).not.toContain('memory:')
    const elsewhere = enableInConfig('', { ...cfg(), apiUrl: 'https://mini.ts.net:8445' })
    expect(disableInConfig(elsewhere, URL)).toBe(elsewhere)
  })
})

describe('llm choice', () => {
  const none = { hasSavedEnv: false, hasCodexAuth: false, ompEnv: null }
  it('prefers the saved file, then Codex, then omp .env', () => {
    expect(pickLlm({ ...none, hasSavedEnv: true, hasCodexAuth: true })).toEqual({
      kind: 'existing',
    })
    expect(pickLlm({ ...none, hasCodexAuth: true, ompEnv: 'OPENAI_API_KEY=sk' })).toEqual({
      kind: 'codex',
    })
    expect(pickLlm({ ...none, ompEnv: 'OPENAI_API_KEY=sk-1\nANTHROPIC_API_KEY=a' })).toEqual({
      kind: 'key',
      provider: 'openai',
      key: 'sk-1',
    })
    expect(pickLlm({ ...none, ompEnv: 'ANTHROPIC_API_KEY="a"' })).toMatchObject({
      provider: 'anthropic',
      key: 'a',
    })
    expect(pickLlm(none)).toEqual({ kind: 'none' })
  })

  it('uses the model on this Mac only when asked, ahead of everything else', () => {
    expect(pickLlm({ ...none, wantLocal: true, hasCodexAuth: true })).toEqual({ kind: 'local' })
    expect(pickLlm({ ...none, hasCodexAuth: true })).toEqual({ kind: 'codex' })
  })
})

describe('docker plan', () => {
  it('publishes on 127.0.0.1 only and never reuses Eva container, volume or ports', () => {
    const args = dockerRunArgs({
      names: { container: 'relay-hindsight', volume: 'relay-hindsight-data' },
      apiPort: 18888,
      uiPort: 19999,
      envFile: '/c/hindsight.env',
      codexDir: null,
    })
    const ports = args.filter((_, i) => args[i - 1] === '-p')
    expect(ports).toEqual(['127.0.0.1:18888:8888', '127.0.0.1:19999:9999'])
    expect(args).toContain('relay-hindsight-data:/home/hindsight/.pg0')
    expect(args).toContain('unless-stopped')
    expect(args.join(' ')).not.toContain('.codex')
    expect(args.at(-1)).toBe('ghcr.io/vectorize-io/hindsight:latest')
  })

  it('mounts the Codex login only when asked', () => {
    const args = dockerRunArgs({
      names: { container: 'c', volume: 'v' },
      apiPort: 1,
      uiPort: 2,
      envFile: '/e',
      codexDir: '/home/u/.codex',
    })
    expect(args).toContain('/home/u/.codex:/home/hindsight/.codex')
  })

  it('picks the first free port past busy ones', async () => {
    const busy = new Set([18888, 18889])
    expect(await firstFreePort(18888, async (p) => !busy.has(p))).toBe(18890)
    await expect(firstFreePort(1, async () => false, new Set(), 3)).rejects.toThrow('No free port')
  })

  it('reads ports, label and loopback binding from docker inspect', () => {
    const json = JSON.stringify([
      {
        State: { Running: true },
        Config: { Labels: { 'io.relay.hindsight': '1' } },
        HostConfig: {
          PortBindings: {
            '8888/tcp': [{ HostIp: '127.0.0.1', HostPort: '18890' }],
            '9999/tcp': [{ HostIp: '', HostPort: '19999' }],
          },
        },
      },
    ])
    expect(parseInspect(json)).toEqual({
      running: true,
      ours: true,
      apiPort: 18890,
      uiPort: 19999,
      loopbackOnly: false,
    })
    expect(parseInspect('nope')).toBeNull()
  })
})

// ---- orchestration against fake docker, uv and launchctl --------------------------------------

interface Fake {
  deps: HindsightDeps
  calls: string[][]
  execs: string[][]
  downloads: string[]
  puts: string[]
  home: string
  root: string
  container: { running: boolean; label: boolean; api: number; ui: number; loopback: boolean } | null
  healthy: boolean
  imagePresent: boolean
  /** The native LaunchAgent as launchd would hold it. */
  agent: { loaded: boolean; running: boolean }
  /** Version `uv pip install` lays down; `latest` is what `--upgrade` finds. */
  version: string
  latest: string
  pipFails: boolean
  bootstrapFails: boolean
  size: number
  sleeps: number
  /** The local model server's LaunchAgent. */
  llm: { loaded: boolean; running: boolean }
  /** What Hindsight's operations list says, newest first. */
  ops: Array<{ status: string; error_message?: string }>
  codexLogin: DockerResult
  /** How many polls the model server ignores before it answers (it is downloading). */
  modelWarmup: number
}

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' })

function fake(
  o: {
    agents?: boolean
    codex?: boolean
    ompEnv?: string
    busy?: number[]
    arch?: string
    systemUv?: boolean
    ram?: number
  } = {},
): Fake {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hs-'))
  tmps.push(home)
  const root = path.join(home, 'Relay')
  fs.mkdirSync(path.join(root, '.omp/assistant'), { recursive: true })
  if (o.agents !== false) {
    fs.writeFileSync(
      path.join(root, '.omp/assistant/agents.json'),
      JSON.stringify({ agents: [{ id: 'ada', title: 'Ada' }] }),
    )
  }
  fs.mkdirSync(path.join(home, '.omp/agent'), { recursive: true })
  if (o.ompEnv) fs.writeFileSync(path.join(home, '.omp/agent/.env'), o.ompEnv)
  if (o.codex) {
    fs.mkdirSync(path.join(home, '.codex'))
    fs.writeFileSync(path.join(home, '.codex/auth.json'), '{}')
  }
  const systemUv = path.join(home, 'bin/uv')
  if (o.systemUv !== false) {
    fs.mkdirSync(path.dirname(systemUv), { recursive: true })
    fs.writeFileSync(systemUv, '#!/bin/sh\n')
  }
  const nativeDir = path.join(home, 'Library/Application Support/Relay/hindsight')
  const f: Fake = {
    calls: [],
    execs: [],
    downloads: [],
    puts: [],
    home,
    root,
    container: null,
    healthy: true,
    imagePresent: false,
    agent: { loaded: false, running: false },
    version: '1.2.0',
    latest: '1.2.0',
    pipFails: false,
    bootstrapFails: false,
    size: 0,
    sleeps: 0,
    llm: { loaded: false, running: false },
    ops: [],
    codexLogin: { code: 0, stdout: '', stderr: '' },
    modelWarmup: 0,
    deps: undefined as unknown as HindsightDeps,
  }
  const site = path.join(nativeDir, 'venv/lib/python3.12/site-packages')
  f.deps = {
    docker: async (args) => {
      f.calls.push(args)
      const [cmd] = args
      if (cmd === 'inspect') {
        if (!f.container) return { code: 1, stdout: '[]', stderr: 'Error: No such object: x' }
        const c = f.container
        return ok(
          JSON.stringify([
            {
              State: { Running: c.running },
              Config: { Labels: c.label ? { 'io.relay.hindsight': '1' } : {} },
              HostConfig: {
                PortBindings: {
                  '8888/tcp': [{ HostIp: c.loopback ? '127.0.0.1' : '', HostPort: String(c.api) }],
                  '9999/tcp': [{ HostIp: c.loopback ? '127.0.0.1' : '', HostPort: String(c.ui) }],
                },
              },
            },
          ]),
        )
      }
      if (cmd === 'image')
        return f.imagePresent ? ok() : { code: 1, stdout: '', stderr: 'no such image' }
      if (cmd === 'pull') {
        f.imagePresent = true
        return ok()
      }
      if (cmd === 'run') {
        const api = Number(args[args.indexOf('-p') + 1]!.split(':')[1])
        const ui = Number(args[args.lastIndexOf('-p') + 1]!.split(':')[1])
        f.container = { running: true, label: true, api, ui, loopback: true }
        return ok('id')
      }
      if (cmd === 'start' && f.container) f.container.running = true
      if (cmd === 'stop' && f.container) f.container.running = false
      if (cmd === 'rm') f.container = null
      return ok()
    },
    exec: async (cmd, args, x) => {
      f.execs.push([cmd, ...args, ...(x?.env ? [JSON.stringify(x.env)] : [])])
      if (cmd === 'codex') return f.codexLogin
      if (cmd.endsWith('launchctl')) {
        // The model server's agent is `<label>.llm`; everything else is Hindsight's own.
        const llm = (args[1] ?? '').endsWith('.llm') || (args[2] ?? '').endsWith('.llm.plist')
        const agent = llm ? f.llm : f.agent
        if (args[0] === 'bootstrap') {
          if (f.bootstrapFails) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5' }
          Object.assign(agent, { loaded: true, running: true })
        } else if (args[0] === 'bootout') {
          Object.assign(agent, { loaded: false, running: false })
        } else if (args[0] === 'print') {
          return agent.loaded
            ? ok(`gui/501/x = {\n\tstate = ${agent.running ? 'running' : 'waiting'}\n}`)
            : { code: 113, stdout: '', stderr: 'Could not find service' }
        }
        return ok()
      }
      if (cmd === '/usr/bin/tar') {
        fs.mkdirSync(path.join(nativeDir, 'uv'), { recursive: true })
        fs.writeFileSync(path.join(nativeDir, 'uv/uv'), '#!/bin/sh\n')
        return ok()
      }
      if (args[0] === '--version') return ok('uv 0.12.0')
      if (args[0] === 'venv') {
        fs.mkdirSync(path.join(nativeDir, 'venv/bin'), { recursive: true })
        fs.writeFileSync(path.join(nativeDir, 'venv/bin/python'), '')
        return ok()
      }
      if (args[0] === 'pip') {
        // Let the size ticker run a few rounds while "downloading".
        for (const until = f.sleeps + 3; f.sleeps < until;) await Promise.resolve()
        if (f.pipFails) return { code: 1, stdout: '', stderr: 'x\nerror: no matching distribution' }
        const v = args.includes('--upgrade') ? f.latest : f.version
        f.version = v
        fs.mkdirSync(site, { recursive: true })
        for (const e of fs.readdirSync(site)) fs.rmSync(path.join(site, e), { recursive: true })
        fs.mkdirSync(path.join(site, `hindsight_api-${v}.dist-info`))
        return ok()
      }
      return ok()
    },
    download: async (url) => {
      f.downloads.push(url)
    },
    dirSize: async () => (f.size += 300_000_000),
    http: async (method, url) => {
      if (method === 'PUT') {
        f.puts.push(url)
        return { status: 200 }
      }
      if (url.endsWith('/v1/models')) {
        if (f.modelWarmup > 0) {
          f.modelWarmup--
          return { status: 503 }
        }
        return { status: f.llm.running ? 200 : 503 }
      }
      if (url.includes('/operations')) {
        return f.healthy ? { status: 200, body: { operations: f.ops } } : { status: 503 }
      }
      return { status: f.healthy ? 200 : 503 }
    },
    portFree: async (p) => !(o.busy ?? []).includes(p),
    sleep: async () => {
      f.sleeps++
      await Promise.resolve()
    },
    homedir: home,
    agentDir: path.join(home, '.omp/agent'),
    configDir: path.join(home, 'cfg'),
    names: { container: 'relay-hindsight-test', volume: 'relay-hindsight-test-data' },
    apiBasePort: 18888,
    uiBasePort: 19999,
    healthTimeoutMs: 50,
    arch: o.arch ?? 'arm64',
    uid: 501,
    nativeDir,
    launchAgentsDir: path.join(home, 'Library/LaunchAgents'),
    label: 'ai.relay.hindsight.test',
    uvCandidates: o.systemUv === false ? [] : [systemUv],
    ramBytes: o.ram ?? 16 * 1024 ** 3,
    toolPath: '/usr/bin:/bin',
  }
  return f
}

/** Native is the default engine. */
const nativeInput = (
  f: Fake,
): { root: string; userName: string; key?: string; engine?: 'native' } => ({
  root: f.root,
  userName: 'Sam',
})
/** The Docker fallback, asked for by name. */
const input = (f: Fake): { root: string; userName: string; engine: 'docker' } => ({
  root: f.root,
  userName: 'Sam',
  engine: 'docker',
})
const silent = (): void => {}
const ompCfg = (f: Fake): string =>
  fs.readFileSync(path.join(f.home, '.omp/agent/config.yml'), 'utf8')
const nativeDirOf = (f: Fake): string => f.deps.nativeDir

describe('installHindsight (Docker fallback)', () => {
  it('pulls, creates the volume, runs on free ports, makes the bank and wires omp', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=sk-test', busy: [18888] })
    const r = await installHindsight(f.deps, input(f), silent)
    expect(r).toEqual({
      apiUrl: 'http://127.0.0.1:18889',
      uiUrl: 'http://127.0.0.1:19999',
      bankId: 'ada',
    })
    expect(f.calls.map((c) => c[0])).toEqual(['inspect', 'image', 'pull', 'volume', 'run'])
    expect(f.puts).toEqual(['http://127.0.0.1:18889/v1/default/banks/ada'])
    expect(readConfig(ompCfg(f))).toEqual({ backend: 'hindsight', apiUrl: r.apiUrl, bankId: 'ada' })
    expect(ompCfg(f)).toContain('Sam')
    const env = fs.readFileSync(path.join(f.home, 'cfg/hindsight.env'), 'utf8')
    expect(env).toContain('HINDSIGHT_API_LLM_API_KEY=sk-test')
    expect(fs.statSync(path.join(f.home, 'cfg/hindsight.env')).mode & 0o777).toBe(0o600)
    // The key is in the env file, never on the command line.
    expect(f.calls.flat().join(' ')).not.toContain('sk-test')
  })

  it('a second run reuses the container and changes nothing', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=sk-test' })
    await installHindsight(f.deps, input(f), silent)
    const cfgBefore = ompCfg(f)
    f.calls.length = 0
    await installHindsight(f.deps, input(f), silent)
    expect(f.calls.map((c) => c[0])).toEqual(['inspect'])
    expect(ompCfg(f)).toBe(cfgBefore)
  })

  it('restarts a stopped container instead of recreating it', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=sk-test' })
    await installHindsight(f.deps, input(f), silent)
    f.container!.running = false
    f.calls.length = 0
    await installHindsight(f.deps, input(f), silent)
    expect(f.calls.map((c) => c[0])).toEqual(['inspect', 'start'])
  })

  it('mounts the Codex login when that is the AI account on hand', async () => {
    const f = fake({ codex: true })
    await installHindsight(f.deps, input(f), silent)
    const run = f.calls.find((c) => c[0] === 'run')!
    expect(run).toContain(`${f.home}/.codex:/home/hindsight/.codex`)
    expect(fs.readFileSync(path.join(f.home, 'cfg/hindsight.env'), 'utf8')).toContain(
      'openai-codex',
    )
  })

  it('asks for a key before downloading anything when no AI account is on hand', async () => {
    const f = fake()
    await expect(installHindsight(f.deps, input(f), silent)).rejects.toThrow(/AI key/)
    expect(f.calls.map((c) => c[0])).toEqual(['inspect'])
    f.calls.length = 0
    fs.writeFileSync(path.join(f.home, '.omp/agent/.env'), 'OPENAI_API_KEY=sk-added\n')
    await installHindsight(f.deps, input(f), silent)
    expect(fs.readFileSync(path.join(f.home, 'cfg/hindsight.env'), 'utf8')).toContain('sk-added')
  })

  it('refuses to touch a same-named container Relay did not create', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.container = { running: true, label: false, api: 8888, ui: 9999, loopback: true }
    await expect(installHindsight(f.deps, input(f), silent)).rejects.toThrow(/did not create/)
    expect(f.calls.map((c) => c[0])).toEqual(['inspect'])
    expect(ompCfg0(f)).toBe('')
  })

  it('refuses a container published beyond loopback', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.container = { running: true, label: true, api: 18888, ui: 19999, loopback: false }
    await expect(installHindsight(f.deps, input(f), silent)).rejects.toThrow(/beyond this Mac/)
  })

  it('says what to do when Docker is missing or not running', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.deps.docker = async () => ({
      code: 127,
      stdout: '',
      stderr: 'docker not found',
      missing: true,
    })
    await expect(installHindsight(f.deps, input(f), silent)).rejects.toThrow(
      /Docker Desktop or OrbStack/,
    )
    f.deps.docker = async () => ({
      code: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
    })
    await expect(installHindsight(f.deps, input(f), silent)).rejects.toThrow(/not running/)
  })

  it('fails clearly when Hindsight never answers, leaving the container for a retry', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.healthy = false
    await expect(installHindsight(f.deps, input(f), silent)).rejects.toBeInstanceOf(HindsightError)
    expect(f.container).not.toBeNull()
    expect(ompCfg0(f)).toBe('')
    f.healthy = true
    await installHindsight(f.deps, input(f), silent)
    expect(readConfig(ompCfg(f)).backend).toBe('hindsight')
  })

  it('needs an assistant to name the bank', async () => {
    const f = fake({ agents: false, ompEnv: 'OPENAI_API_KEY=k' })
    await expect(installHindsight(f.deps, input(f), silent)).rejects.toThrow(/assistants file/)
  })

  it('replaces a native install that did not work', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.healthy = false
    await expect(installHindsight(f.deps, nativeInput(f), silent)).rejects.toThrow(/did not answer/)
    expect((await hindsightStatus(f.deps)).engine).toBe('native')
    f.healthy = true
    await installHindsight(f.deps, input(f), silent)
    expect(fs.existsSync(nativeDirOf(f))).toBe(false)
    expect(f.agent.loaded).toBe(false)
    expect(await hindsightStatus(f.deps)).toMatchObject({ engine: 'docker', service: 'running' })
  })
})

function ompCfg0(f: Fake): string {
  try {
    return ompCfg(f)
  } catch {
    return ''
  }
}

describe('installHindsight (native, the default)', () => {
  it('installs uv-managed Python and hindsight-api, starts the LaunchAgent, makes the bank, wires omp', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=sk-test', busy: [18888] })
    const lines: string[] = []
    const r = await installHindsight(f.deps, nativeInput(f), (_p, l) => lines.push(l))
    expect(r).toEqual({ apiUrl: 'http://127.0.0.1:18889', uiUrl: null, bankId: 'ada' })

    // No Docker anywhere on the default path.
    expect(f.calls).toEqual([])
    expect(
      f.execs.some((e) => e[1] === 'venv' && e.slice(2, 4).join(' ') === '--python 3.12'),
    ).toBe(true)
    const pip = f.execs.find((e) => e[1] === 'pip')!
    expect(pip.slice(1, 6)).toEqual([
      'pip',
      'install',
      '--python',
      path.join(nativeDirOf(f), 'venv/bin/python'),
      'hindsight-api',
    ])
    // Everything uv fetches stays under our folder, nothing in $HOME or the system Python.
    const env = JSON.parse(pip.at(-1)!) as Record<string, string>
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(path.join(nativeDirOf(f), 'python'))
    expect(env.UV_PYTHON_PREFERENCE).toBe('only-managed')
    expect(env.UV_NO_CACHE).toBe('1')
    expect(f.execs.some((e) => e.slice(0, 3).join(' ').endsWith('bootstrap gui/501'))).toBe(true)

    expect(f.puts).toEqual(['http://127.0.0.1:18889/v1/default/banks/ada'])
    expect(readConfig(ompCfg(f))).toEqual({
      backend: 'hindsight',
      apiUrl: 'http://127.0.0.1:18889',
      bankId: 'ada',
    })
    expect(ompCfg(f)).toContain('Sam')
    expect(lines.at(-1)).toBe('Done')
  })

  it('writes a loopback-only run script, a keep-alive LaunchAgent and a private key file', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=sk-test' })
    await installHindsight(f.deps, nativeInput(f), silent)
    const dir = nativeDirOf(f)
    const run = fs.readFileSync(path.join(dir, 'run.sh'), 'utf8')
    expect(run).toContain('HINDSIGHT_API_HOST=127.0.0.1')
    expect(run).toContain('HINDSIGHT_API_PORT=18888')
    expect(run).toContain('HINDSIGHT_API_DATABASE_URL=pg0://relay-hindsight')
    expect(run).toContain(`PG0_HOME='${path.join(dir, 'data/pg0')}'`)
    expect(run).toContain(`exec '${path.join(dir, 'venv/bin/hindsight-api')}'`)
    expect(run).not.toContain('sk-test')
    expect(fs.statSync(path.join(dir, 'run.sh')).mode & 0o111).not.toBe(0)

    const plist = fs.readFileSync(
      path.join(f.home, 'Library/LaunchAgents/ai.relay.hindsight.test.plist'),
      'utf8',
    )
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain(path.join(dir, 'run.sh'))
    expect(plist).not.toContain('sk-test')

    const env = fs.readFileSync(path.join(dir, 'hindsight.env'), 'utf8')
    expect(env).toContain('HINDSIGHT_API_LLM_API_KEY=sk-test')
    expect(fs.statSync(path.join(dir, 'hindsight.env')).mode & 0o777).toBe(0o600)
    // The key is in the env file, never on a command line.
    expect(f.execs.flat().join(' ')).not.toContain('sk-test')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8'))).toEqual({
      port: 18888,
    })
  })

  it('uses the Codex login for the LLM without storing it', async () => {
    const f = fake({ codex: true })
    await installHindsight(f.deps, nativeInput(f), silent)
    const env = fs.readFileSync(path.join(nativeDirOf(f), 'hindsight.env'), 'utf8')
    expect(env).toContain('HINDSIGHT_API_LLM_PROVIDER=openai-codex')
    expect(env).not.toContain('auth')
  })

  it('asks for a key before downloading anything when no AI account is on hand', async () => {
    const f = fake()
    await expect(installHindsight(f.deps, nativeInput(f), silent)).rejects.toThrow(/AI key/)
    expect(f.execs).toEqual([])
    expect(fs.existsSync(nativeDirOf(f))).toBe(false)
    fs.writeFileSync(path.join(f.home, '.omp/agent/.env'), 'OPENAI_API_KEY=sk-added\n')
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(fs.readFileSync(path.join(nativeDirOf(f), 'hindsight.env'), 'utf8')).toContain(
      'sk-added',
    )
  })

  it('reuses the LLM settings of an earlier Docker install', async () => {
    const f = fake()
    fs.mkdirSync(path.join(f.home, 'cfg'))
    fs.writeFileSync(path.join(f.home, 'cfg/hindsight.env'), 'HINDSIGHT_API_LLM_API_KEY=old\n')
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(fs.readFileSync(path.join(nativeDirOf(f), 'hindsight.env'), 'utf8')).toContain('=old')
  })

  it('downloads a private uv when none is on the Mac', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k', systemUv: false })
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(f.downloads).toEqual([
      'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
    ])
    const uv = path.join(nativeDirOf(f), 'uv/uv')
    expect(f.execs.some((e) => e[0] === uv && e[1] === 'pip')).toBe(true)
    // A second run finds the private one and downloads nothing.
    f.downloads.length = 0
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(f.downloads).toEqual([])
  })

  it('prefers a uv that is already there', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(f.downloads).toEqual([])
    expect(f.execs.some((e) => e[0] === path.join(f.home, 'bin/uv') && e[1] === 'pip')).toBe(true)
  })

  it('reports real sizes while downloading', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    const lines: string[] = []
    await installHindsight(f.deps, nativeInput(f), (_p, l) => lines.push(l))
    expect(lines.some((l) => /^Installing Hindsight: \d+ MB of about 2\.1 GB$/.test(l))).toBe(true)
    expect(lines.some((l) => /about 2\.5 GB in total/.test(l))).toBe(true)
  })

  it('a second run reuses everything: no downloads, same port, same omp config', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k', busy: [18888] })
    await installHindsight(f.deps, nativeInput(f), silent)
    const cfgBefore = ompCfg(f)
    f.execs.length = 0
    f.deps.portFree = async () => false // the old port is held by our own running service
    const r = await installHindsight(f.deps, nativeInput(f), silent)
    expect(r.apiUrl).toBe('http://127.0.0.1:18889')
    expect(f.execs.some((e) => e[1] === 'pip' || e[1] === 'venv')).toBe(false)
    expect(ompCfg(f)).toBe(cfgBefore)
  })

  it('refuses an Intel Mac before touching anything, and says so', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k', arch: 'x64' })
    await expect(installHindsight(f.deps, nativeInput(f), silent)).rejects.toThrow(/Apple Silicon/)
    expect(f.execs).toEqual([])
    expect(fs.existsSync(nativeDirOf(f))).toBe(false)
    expect(await hindsightStatus(f.deps)).toMatchObject({ nativeSupported: false })
  })

  it('a failed pip install is explained and a retry resumes', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.pipFails = true
    await expect(installHindsight(f.deps, nativeInput(f), silent)).rejects.toThrow(
      /Installing Hindsight failed: error: no matching distribution/,
    )
    expect(f.execs.some((e) => e[1] === 'bootstrap')).toBe(false)
    expect(ompCfg0(f)).toBe('')
    expect((await hindsightStatus(f.deps)).engine).toBe('none')
    f.pipFails = false
    f.execs.length = 0
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(f.execs.some((e) => e[1] === 'venv')).toBe(false)
    expect(readConfig(ompCfg(f)).backend).toBe('hindsight')
  })

  it('explains a LaunchAgent macOS refuses to load', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.bootstrapFails = true
    await expect(installHindsight(f.deps, nativeInput(f), silent)).rejects.toThrow(
      /would not start the Hindsight service/,
    )
  })

  it('names the log when the service never answers, and wires nothing', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    f.healthy = false
    await expect(installHindsight(f.deps, nativeInput(f), silent)).rejects.toThrow(
      new RegExp(`logs/hindsight\\.log`),
    )
    expect(ompCfg0(f)).toBe('')
    f.healthy = true
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(readConfig(ompCfg(f)).backend).toBe('hindsight')
  })
})

describe('hindsightStatus', () => {
  it('reports none, then native running+configured with version and size, then stopped', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    expect(await hindsightStatus(f.deps)).toMatchObject({
      engine: 'none',
      nativeSupported: true,
      docker: 'ok',
      service: 'none',
      configured: false,
      llm: 'key',
      version: null,
    })
    await installHindsight(f.deps, nativeInput(f), silent)
    f.calls.length = 0
    const on = await hindsightStatus(f.deps)
    expect(on).toMatchObject({
      engine: 'native',
      docker: 'unchecked',
      service: 'running',
      healthy: true,
      configured: true,
      bankId: 'ada',
      apiUrl: 'http://127.0.0.1:18888',
      uiUrl: null,
      version: '1.2.0',
    })
    expect(on.diskBytes).toBeGreaterThan(0)
    expect(f.calls).toEqual([]) // Docker is not even looked at
    f.agent = { loaded: true, running: false }
    expect(await hindsightStatus(f.deps)).toMatchObject({ service: 'stopped', healthy: false })
  })

  it('reports a Docker fallback install as docker', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, input(f), silent)
    expect(await hindsightStatus(f.deps)).toMatchObject({
      engine: 'docker',
      docker: 'ok',
      service: 'running',
      healthy: true,
      configured: true,
      bankId: 'ada',
      apiUrl: 'http://127.0.0.1:18888',
      uiUrl: 'http://127.0.0.1:19999',
    })
    f.container!.running = false
    expect(await hindsightStatus(f.deps)).toMatchObject({ service: 'stopped', healthy: false })
  })

  it('does not report another container as ours', async () => {
    const f = fake()
    f.container = { running: true, label: false, api: 8888, ui: 9999, loopback: true }
    expect(await hindsightStatus(f.deps)).toMatchObject({
      engine: 'none',
      service: 'none',
      apiUrl: null,
    })
  })
})

describe('updateHindsight', () => {
  it('upgrades hindsight-api, restarts the service and reports the versions', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    f.latest = '1.3.0'
    f.execs.length = 0
    const r = await updateHindsight(f.deps, silent)
    expect(r).toEqual({ from: '1.2.0', to: '1.3.0' })
    const pip = f.execs.find((e) => e[1] === 'pip')!
    expect(pip).toContain('--upgrade')
    expect(f.execs.map((e) => e[1])).toContain('bootstrap')
    expect((await hindsightStatus(f.deps)).version).toBe('1.3.0')
  })

  it('says when it is already the newest', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(await updateHindsight(f.deps, silent)).toEqual({ from: '1.2.0', to: '1.2.0' })
  })

  it('needs an install to update', async () => {
    const f = fake()
    await expect(updateHindsight(f.deps, silent)).rejects.toThrow(/not installed/)
  })
})

describe('removeHindsight', () => {
  it('native disable stops it and takes omp off it, keeping the install and memories', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    await removeHindsight(f.deps, 'disable', silent)
    expect(f.agent.loaded).toBe(false)
    expect(
      fs.existsSync(path.join(f.home, 'Library/LaunchAgents/ai.relay.hindsight.test.plist')),
    ).toBe(false)
    expect(fs.existsSync(path.join(nativeDirOf(f), 'venv'))).toBe(true)
    expect(readConfig(ompCfg(f)).backend).toBeNull()
    // Turning it back on needs no download.
    f.execs.length = 0
    await installHindsight(f.deps, nativeInput(f), silent)
    expect(f.execs.some((e) => e[1] === 'pip' || e[1] === 'venv')).toBe(false)
    expect(f.agent.running).toBe(true)
    expect(readConfig(ompCfg(f)).backend).toBe('hindsight')
  })

  it('native remove deletes the folder, the LaunchAgent and the key', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    await removeHindsight(f.deps, 'remove', silent)
    expect(fs.existsSync(nativeDirOf(f))).toBe(false)
    expect(
      fs.existsSync(path.join(f.home, 'Library/LaunchAgents/ai.relay.hindsight.test.plist')),
    ).toBe(false)
    expect(f.agent.loaded).toBe(false)
    expect(readConfig(ompCfg(f)).backend).toBeNull()
    expect(f.calls.some((c) => c[0] === 'volume')).toBe(false)
    expect((await hindsightStatus(f.deps)).engine).toBe('none')
  })

  it('docker disable stops it and takes omp off it, keeping the data', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, input(f), silent)
    await removeHindsight(f.deps, 'disable', silent)
    expect(f.container).toMatchObject({ running: false })
    expect(readConfig(ompCfg(f)).backend).toBeNull()
    expect(f.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false)
    await installHindsight(f.deps, input(f), silent)
    expect(f.container).toMatchObject({ running: true })
    expect(readConfig(ompCfg(f)).backend).toBe('hindsight')
  })

  it('docker remove deletes the container, volume and key file', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, input(f), silent)
    await removeHindsight(f.deps, 'remove', silent)
    expect(f.container).toBeNull()
    expect(f.calls.some((c) => c.join(' ') === 'volume rm -f relay-hindsight-test-data')).toBe(true)
    expect(fs.existsSync(path.join(f.home, 'cfg/hindsight.env'))).toBe(false)
    expect(readConfig(ompCfg(f)).backend).toBeNull()
  })

  it('never removes a container it does not own', async () => {
    const f = fake()
    f.container = { running: true, label: false, api: 8888, ui: 9999, loopback: true }
    await expect(removeHindsight(f.deps, 'remove', silent)).rejects.toThrow(/left alone/)
    expect(f.container).not.toBeNull()
  })

  it('removes a native install even when Docker is not installed', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    f.deps.docker = async () => ({ code: 127, stdout: '', stderr: '', missing: true })
    await removeHindsight(f.deps, 'remove', silent)
    expect(fs.existsSync(nativeDirOf(f))).toBe(false)
  })
})

const GIB = 1024 ** 3
const localInput = (f: Fake): { root: string; userName: string; llm: 'local' } => ({
  root: f.root,
  userName: 'Sam',
  llm: 'local',
})

describe('classifyOperations', () => {
  const login = {
    status: 'failed',
    error_message:
      "Fact extraction failed: chunk 0: RuntimeError: Codex authentication failed and the refresh_token is no longer valid.\nRun 'codex auth login' to re-authenticate.",
  }
  it('is fine with nothing yet, or with only work in flight', () => {
    expect(classifyOperations([], true)).toBeNull()
    expect(classifyOperations([{ status: 'pending' }, { status: 'processing' }], true)).toBeNull()
  })
  it('is fine when the newest finished operation succeeded, whatever failed before', () => {
    expect(classifyOperations([{ status: 'completed' }, login], true)).toBeNull()
    expect(
      classifyOperations([{ status: 'pending' }, { status: 'completed' }, login], true),
    ).toBeNull()
  })
  it('reads an expired ChatGPT sign-in off a failed retain and offers sign-in', () => {
    expect(classifyOperations([login, { status: 'completed' }], true)).toEqual({
      kind: 'login',
      message: "Memory isn't saving: your ChatGPT sign-in for memory expired.",
      fix: 'sign-in',
    })
    // A still-pending operation newer than the failure does not hide it.
    expect(classifyOperations([{ status: 'pending' }, login], true)?.kind).toBe('login')
  })
  it('counts a retain that is still pending but already carries the login error', () => {
    const retrying = { status: 'pending', error_message: login.error_message }
    expect(classifyOperations([{ status: 'pending' }, retrying], true)).toMatchObject({
      kind: 'login',
      fix: 'sign-in',
    })
  })
  it('says the key was refused when it is not a ChatGPT sign-in', () => {
    const p = classifyOperations(
      [{ status: 'failed', error_message: 'Error code: 401 invalid api key' }],
      false,
    )
    expect(p).toMatchObject({ kind: 'login', fix: 'restart' })
    expect(p?.message).toContain('key')
  })
  it('calls any other failure a model error, with a restart as the fix', () => {
    expect(
      classifyOperations([{ status: 'failed', error_message: 'Connection error.' }], false),
    ).toMatchObject({ kind: 'llm', fix: 'restart' })
    expect(classifyOperations([{ status: 'failed' }], true)).toMatchObject({ kind: 'llm' })
  })
})

describe('the model on this Mac', () => {
  it('is offered from 32 GB of memory and not below', () => {
    expect(localModelFor(31 * GIB)).toBeNull()
    expect(localModelFor(16 * GIB)).toBeNull()
    expect(localModelFor(32 * GIB)).toMatchObject({
      repo: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
    })
  })

  it('points Hindsight at an OpenAI-compatible server on loopback, one request at a time', () => {
    const env = localLlmEnv({ model: 'm/x', port: 18988 })
    expect(env).toContain('HINDSIGHT_API_LLM_PROVIDER=openai\n')
    expect(env).toContain('HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:18988/v1\n')
    expect(env).toContain('HINDSIGHT_API_LLM_MODEL=m/x\n')
    expect(env).toContain('HINDSIGHT_API_LLM_MAX_CONCURRENT=1\n')
  })

  it('runs mlx_lm.server on 127.0.0.1 with weights under our folder', () => {
    const p = nativePaths({
      nativeDir: "/a b/it's/hindsight",
      launchAgentsDir: '/la',
      label: 'ai.relay.hindsight',
    })
    const s = llmRunScript(p, { model: 'm/x', port: 1 })
    expect(s).toContain(`HF_HOME='/a b/it'\\''s/hindsight/data/hf'`)
    expect(s).toContain(
      `exec '/a b/it'\\''s/hindsight/venv/bin/mlx_lm.server' --model 'm/x' --host 127.0.0.1 --port 1`,
    )
  })

  it('installs the model server first, then Hindsight, with no account needed', async () => {
    const f = fake({ ram: 48 * GIB })
    f.modelWarmup = 2
    const lines: string[] = []
    await installHindsight(f.deps, localInput(f), (_p, l) => lines.push(l))
    const boots = f.execs.filter((e) => e[1] === 'bootstrap').map((e) => path.basename(e[3]!))
    expect(boots).toEqual(['ai.relay.hindsight.test.llm.plist', 'ai.relay.hindsight.test.plist'])
    const dir = nativeDirOf(f)
    expect(fs.readFileSync(path.join(dir, 'hindsight.env'), 'utf8')).toContain(
      'HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:18988/v1',
    )
    expect(fs.readFileSync(path.join(dir, 'llm-run.sh'), 'utf8')).toContain('mlx_lm.server')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8'))).toEqual({
      port: 18888,
      llm: { model: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit', port: 18988 },
    })
    expect(
      lines.some((l) => /^Downloading the model: [\d.]+ (MB|GB) of about 17\.2 GB$/.test(l)),
    ).toBe(true)
    expect(readConfig(ompCfg(f)).backend).toBe('hindsight')
  })

  it('refuses on a Mac with less than 32 GB, and for Docker, before downloading anything', async () => {
    const small = fake({ ram: 16 * GIB })
    await expect(installHindsight(small.deps, localInput(small), silent)).rejects.toThrow(
      /32 GB of memory or more. This one has 16 GB/,
    )
    expect(small.execs).toEqual([])
    const big = fake({ ram: 48 * GIB })
    await expect(
      installHindsight(big.deps, { ...localInput(big), engine: 'docker' }, silent),
    ).rejects.toThrow(/only runs with the Relay install/)
    expect(big.calls).toEqual([])
  })

  it('a repair re-run keeps the model it already runs', async () => {
    const f = fake({ ram: 48 * GIB })
    await installHindsight(f.deps, localInput(f), silent)
    f.execs.length = 0
    await installHindsight(f.deps, nativeInput(f), silent)
    const boots = f.execs.filter((e) => e[1] === 'bootstrap').map((e) => path.basename(e[3]!))
    expect(boots).toEqual(['ai.relay.hindsight.test.llm.plist', 'ai.relay.hindsight.test.plist'])
    expect(fs.readFileSync(path.join(nativeDirOf(f), 'hindsight.env'), 'utf8')).toContain('18988')
  })

  it('adds it to a running install without reinstalling anything else', async () => {
    const f = fake({ ram: 48 * GIB, ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    expect((await hindsightStatus(f.deps)).local).toMatchObject({ installed: false })
    f.execs.length = 0
    await installHindsight(f.deps, localInput(f), silent)
    expect(f.execs.some((e) => e[1] === 'pip' || e[1] === 'venv')).toBe(false)
    expect(await hindsightStatus(f.deps)).toMatchObject({
      local: { installed: true, running: true },
    })
  })

  it('is offered in the status when there is no ChatGPT login, with its cost', async () => {
    const big = fake({ ram: 48 * GIB })
    expect(await hindsightStatus(big.deps)).toMatchObject({
      llm: 'none',
      local: {
        installed: false,
        downloadBytes: 17_200_000_000,
        ramBytes: 18_000_000_000,
        model: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
      },
    })
    const withCodex = fake({ ram: 48 * GIB, codex: true })
    expect(await hindsightStatus(withCodex.deps)).toMatchObject({ llm: 'codex', local: null })
    const small = fake({ ram: 16 * GIB })
    expect((await hindsightStatus(small.deps)).local).toBeNull()
  })

  it('disable and remove stop both agents and delete both plists', async () => {
    const f = fake({ ram: 48 * GIB })
    await installHindsight(f.deps, localInput(f), silent)
    await removeHindsight(f.deps, 'disable', silent)
    expect(f.agent.loaded).toBe(false)
    expect(f.llm.loaded).toBe(false)
    const agents = path.join(f.home, 'Library/LaunchAgents')
    expect(fs.readdirSync(agents)).toEqual([])
    expect(fs.existsSync(path.join(nativeDirOf(f), 'venv'))).toBe(true)
    await removeHindsight(f.deps, 'remove', silent)
    expect(fs.existsSync(nativeDirOf(f))).toBe(false)
  })
})

describe('why memory is not saving', () => {
  const codexEnvOn = async (): Promise<Fake> => {
    const f = fake({ codex: true })
    await installHindsight(f.deps, nativeInput(f), silent)
    return f
  }
  const failed = {
    status: 'failed',
    error_message: 'Codex authentication failed and the refresh_token is no longer valid.',
  }

  it('has no problem while it works, and none before it is set up', async () => {
    const f = await codexEnvOn()
    f.ops = [{ status: 'completed' }]
    expect((await hindsightStatus(f.deps)).problem).toBeNull()
    expect((await hindsightStatus(fake().deps)).problem).toBeNull()
  })

  it('reports an expired ChatGPT login with the sign-in fix, and clears when it recovers', async () => {
    const f = await codexEnvOn()
    f.ops = [failed, { status: 'completed' }]
    expect((await hindsightStatus(f.deps)).problem).toEqual({
      kind: 'login',
      message: "Memory isn't saving: your ChatGPT sign-in for memory expired.",
      fix: 'sign-in',
    })
    f.ops = [{ status: 'completed' }, failed]
    expect((await hindsightStatus(f.deps)).problem).toBeNull()
  })

  it('reports a stopped service as down, with a restart', async () => {
    const f = await codexEnvOn()
    f.agent = { loaded: true, running: false }
    expect((await hindsightStatus(f.deps)).problem).toMatchObject({ kind: 'down', fix: 'restart' })
  })

  it('reports a stopped model server, and says nothing once Turn off took omp off it', async () => {
    const f = fake({ ram: 48 * GIB })
    await installHindsight(f.deps, localInput(f), silent)
    f.llm = { loaded: true, running: false }
    expect((await hindsightStatus(f.deps)).problem).toMatchObject({
      kind: 'llm',
      message: expect.stringContaining('model on this Mac'),
    })
    await removeHindsight(f.deps, 'disable', silent)
    expect((await hindsightStatus(f.deps)).problem).toBeNull()
  })
})

describe('restartHindsight and reloginHindsight', () => {
  it('starts a turned-off native install again from the files it kept', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, nativeInput(f), silent)
    await removeHindsight(f.deps, 'disable', silent)
    f.execs.length = 0
    await restartHindsight(f.deps, silent)
    expect(f.agent.running).toBe(true)
    expect(f.execs.some((e) => e[1] === 'pip' || e[1] === 'venv')).toBe(false)
    expect(
      fs.existsSync(path.join(f.home, 'Library/LaunchAgents/ai.relay.hindsight.test.plist')),
    ).toBe(true)
  })

  it('restarts the Docker container for a Docker install', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, input(f), silent)
    f.calls.length = 0
    await restartHindsight(f.deps, silent)
    expect(f.calls.some((c) => c.join(' ') === 'restart relay-hindsight-test')).toBe(true)
  })

  it('signs in to ChatGPT again by running codex login', async () => {
    const f = fake()
    await reloginHindsight(f.deps, silent)
    const call = f.execs.find((e) => e[0] === 'codex')!
    expect(call.slice(0, 2)).toEqual(['codex', 'login'])
    expect(call.at(-1)).toContain('"PATH":"/usr/bin:/bin"')
  })

  it('says so when codex is not installed or the sign-in fails', async () => {
    const f = fake()
    f.codexLogin = { code: 127, stdout: '', stderr: 'codex not found', missing: true }
    await expect(reloginHindsight(f.deps, silent)).rejects.toThrow(/codex login" in Terminal/)
    f.codexLogin = { code: 1, stdout: '', stderr: 'cancelled by user' }
    await expect(reloginHindsight(f.deps, silent)).rejects.toThrow(
      /did not finish: cancelled by user/,
    )
  })
})
