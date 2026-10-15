import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const hooks: Record<string, unknown> = {}
vi.mock('../test-hooks', () => ({
  registerTestHook: (n: string, v: unknown) => {
    hooks[n] = v
  },
}))

import { buildCommand, recordSpawn, resolveBun, runCapture, spawnDetached } from './spawn'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-spawn-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const only =
  (...files: string[]) =>
  (p: string) =>
    files.includes(p)

describe('resolveBun', () => {
  it('prefers PATH, then homebrew, then ~/.bun, then bare', () => {
    expect(resolveBun('/a:/b', '/h', only('/b/bun', '/opt/homebrew/bin/bun'))).toBe('/b/bun')
    expect(resolveBun('/a', '/h', only('/opt/homebrew/bin/bun', '/h/.bun/bin/bun'))).toBe(
      '/opt/homebrew/bin/bun',
    )
    expect(resolveBun('/a', '/h', only('/h/.bun/bin/bun'))).toBe('/h/.bun/bin/bun')
    expect(resolveBun('/a', '/h', only())).toBe('bun')
  })
})

describe('buildCommand', () => {
  const o = (exists: (p: string) => boolean, baseEnv: NodeJS.ProcessEnv = {}) => ({
    pathEnv: '/usr/bin:/b',
    homedir: '/h',
    execPath: '/electron',
    baseEnv,
    exists,
  })

  it('runs .ts through bun with an augmented PATH', () => {
    const c = buildCommand('/r/.omp/tools/job-run.ts', ['nightly'], o(only('/b/bun')))
    expect(c.file).toBe('/b/bun')
    expect(c.argv).toEqual(['/r/.omp/tools/job-run.ts', 'nightly'])
    const parts = (c.env.PATH ?? '').split(path.delimiter)
    for (const d of ['/b', '/opt/homebrew/bin', '/h/.local/bin']) {
      expect(parts.filter((x) => x === d)).toHaveLength(1)
    }
  })

  it('runs .mjs through node, else Electron as node, without mutating baseEnv', () => {
    const base = { X: '1' }
    const withNode = buildCommand(
      '/f/fake-gate.mjs',
      ['status', '--json'],
      o(only('/b/node'), base),
    )
    expect(withNode.file).toBe('node')
    expect(withNode.argv).toEqual(['/f/fake-gate.mjs', 'status', '--json'])
    const noNode = buildCommand('/f/fake-gate.mjs', ['status'], o(only(), base))
    expect(noNode.file).toBe('/electron')
    expect(noNode.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(base).toEqual({ X: '1' })
  })

  it('runs other binaries directly', () => {
    const c = buildCommand('/usr/local/bin/tool', ['a'], o(only()))
    expect(c.file).toBe('/usr/local/bin/tool')
    expect(c.argv).toEqual(['a'])
  })
})

const nodeCmd = (script: string, args: string[] = []) => ({
  file: process.execPath,
  argv: [script, ...args],
  env: { ...process.env },
})

describe('runCapture', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const s = path.join(dir, 'cap.mjs')
    fs.writeFileSync(s, "process.stdout.write('out');process.stderr.write('err');process.exit(3)")
    const r = await runCapture(nodeCmd(s), dir, 5000)
    expect(r).toEqual({ code: 3, stdout: 'out', stderr: 'err', timedOut: false })
  })

  it('reports a timeout and kills only its child', async () => {
    const s = path.join(dir, 'sleep.mjs')
    fs.writeFileSync(s, 'setTimeout(()=>{},60000)')
    const r = await runCapture(nodeCmd(s), dir, 200)
    expect(r.timedOut).toBe(true)
  })
})

describe('spawnDetached', () => {
  it('runs with the given cwd and returns immediately', async () => {
    const s = path.join(dir, 'det.mjs')
    fs.writeFileSync(
      s,
      "import { writeFileSync } from 'node:fs'\nwriteFileSync('marker.txt', process.cwd())",
    )
    await spawnDetached(nodeCmd(s), dir)
    const marker = path.join(dir, 'marker.txt')
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++)
      await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.realpathSync(fs.readFileSync(marker, 'utf8'))).toBe(fs.realpathSync(dir))
  })
})

describe('spawnDetached failure', () => {
  it('rejects with spawn-failed when the binary does not exist', async () => {
    await expect(
      spawnDetached({ file: path.join(dir, 'no-such-bin'), argv: [], env: process.env }, dir),
    ).rejects.toMatchObject({ code: 'spawn-failed' })
  })
})

describe('recordSpawn', () => {
  const entry = (n: number) => ({
    kind: 'job-run' as const,
    file: 'f',
    argv: [String(n)],
    cwd: '/',
    at: n,
  })

  it('records nothing unless e2e, and caps at 200', () => {
    recordSpawn(false, entry(0))
    expect(hooks.spawnLog).toBeUndefined()
    for (let i = 0; i < 205; i++) recordSpawn(true, entry(i))
    const log = hooks.spawnLog as Array<{ at: number }>
    expect(log).toHaveLength(200)
    expect(log[199]?.at).toBe(204)
  })
})
