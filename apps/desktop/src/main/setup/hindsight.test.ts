import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HindsightError,
  dockerRunArgs,
  disableInConfig,
  enableInConfig,
  firstFreePort,
  hindsightStatus,
  installHindsight,
  parseInspect,
  pickLlm,
  readConfig,
  removeHindsight,
  type DockerResult,
  type HindsightDeps,
} from './hindsight'

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
  it('prefers a typed key, then the saved file, then Codex, then omp .env', () => {
    const typed = { provider: 'anthropic' as const, key: 'k' }
    expect(pickLlm({ ...none, typed, hasSavedEnv: true, hasCodexAuth: true })).toMatchObject({
      kind: 'key',
    })
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

// ---- orchestration against a fake docker ----------------------------------------------------

interface Fake {
  deps: HindsightDeps
  calls: string[][]
  puts: string[]
  home: string
  root: string
  container: { running: boolean; label: boolean; api: number; ui: number; loopback: boolean } | null
  healthy: boolean
  imagePresent: boolean
}

function fake(
  o: { agents?: boolean; codex?: boolean; ompEnv?: string; busy?: number[] } = {},
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
  const f: Fake = {
    calls: [],
    puts: [],
    home,
    root,
    container: null,
    healthy: true,
    imagePresent: false,
    deps: undefined as unknown as HindsightDeps,
  }
  const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' })
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
    http: async (method, url) => {
      if (method === 'PUT') {
        f.puts.push(url)
        return { status: 200 }
      }
      return { status: f.healthy ? 200 : 503 }
    },
    portFree: async (p) => !(o.busy ?? []).includes(p),
    sleep: async () => {},
    homedir: home,
    agentDir: path.join(home, '.omp/agent'),
    configDir: path.join(home, 'cfg'),
    names: { container: 'relay-hindsight-test', volume: 'relay-hindsight-test-data' },
    apiBasePort: 18888,
    uiBasePort: 19999,
    healthTimeoutMs: 10,
  }
  return f
}

const input = (f: Fake): { root: string; userName: string } => ({ root: f.root, userName: 'Sam' })
const silent = (): void => {}
const ompCfg = (f: Fake): string =>
  fs.readFileSync(path.join(f.home, '.omp/agent/config.yml'), 'utf8')

describe('installHindsight', () => {
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
    await installHindsight(f.deps, { ...input(f), key: 'sk-typed' }, silent)
    expect(fs.readFileSync(path.join(f.home, 'cfg/hindsight.env'), 'utf8')).toContain('sk-typed')
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
})

function ompCfg0(f: Fake): string {
  try {
    return ompCfg(f)
  } catch {
    return ''
  }
}

describe('hindsightStatus and removeHindsight', () => {
  it('reports none, then running+configured, then stopped', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    expect(await hindsightStatus(f.deps)).toMatchObject({
      docker: 'ok',
      container: 'none',
      configured: false,
      llmReady: true,
    })
    await installHindsight(f.deps, input(f), silent)
    expect(await hindsightStatus(f.deps)).toMatchObject({
      container: 'running',
      healthy: true,
      configured: true,
      bankId: 'ada',
      apiUrl: 'http://127.0.0.1:18888',
    })
    f.container!.running = false
    expect(await hindsightStatus(f.deps)).toMatchObject({ container: 'stopped', healthy: false })
  })

  it('does not report another container as ours', async () => {
    const f = fake()
    f.container = { running: true, label: false, api: 8888, ui: 9999, loopback: true }
    expect(await hindsightStatus(f.deps)).toMatchObject({ container: 'none', apiUrl: null })
  })

  it('disable stops it and takes omp off it, keeping the data', async () => {
    const f = fake({ ompEnv: 'OPENAI_API_KEY=k' })
    await installHindsight(f.deps, input(f), silent)
    await removeHindsight(f.deps, 'disable', silent)
    expect(f.container).toMatchObject({ running: false })
    expect(readConfig(ompCfg(f)).backend).toBeNull()
    expect(f.calls.some((c) => c[0] === 'volume' && c[1] === 'rm')).toBe(false)
    // Turning it back on restarts the same container.
    await installHindsight(f.deps, input(f), silent)
    expect(f.container).toMatchObject({ running: true })
    expect(readConfig(ompCfg(f)).backend).toBe('hindsight')
  })

  it('remove deletes the container, volume and key file', async () => {
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
})
