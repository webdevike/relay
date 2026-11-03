import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCommand } from '../eva/spawn'
import { ModelCatalog } from './models'

const REPO = path.resolve(__dirname, '../../../../..')
const FAKE = path.join(REPO, 'fixtures/fake-omp/fake-omp.mjs')

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const fakeCmd =
  (log: string, bin = FAKE) =>
  () =>
    Promise.resolve(
      buildCommand(bin, ['--mode', 'rpc', '--no-session'], {
        pathEnv: process.env.PATH ?? '',
        homedir: os.homedir(),
        execPath: process.execPath,
        baseEnv: { ...process.env, FAKE_OMP_LOG: log },
      }),
    )
const spawnCount = (log: string): number =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"event":"spawn"')).length
    : 0

describe('ModelCatalog', () => {
  it('lists the folded catalog from one throwaway process and caches it', async () => {
    const dir = tmp()
    const log = path.join(dir, 'log')
    const cat = new ModelCatalog({ cmd: fakeCmd(log), cwd: dir })
    const first = await cat.list()
    expect(first.length).toBeGreaterThanOrEqual(3)
    // Newest first: the last catalog entry leads.
    expect(first[0]!.id).toBe('no-window')
    const opus = first.find((m) => m.id === 'claude-opus-5-5')!
    expect(opus.images).toBe(true)
    expect(opus.levels).toEqual(['off', 'low', 'medium', 'high'])
    expect(first.find((m) => m.id === 'text-only')!.images).toBe(false)
    const second = await cat.list()
    expect(second).toBe(first)
    expect(spawnCount(log)).toBe(1)
  })

  it('shares one process between concurrent callers', async () => {
    const dir = tmp()
    const log = path.join(dir, 'log')
    const cat = new ModelCatalog({ cmd: fakeCmd(log), cwd: dir })
    await Promise.all([cat.list(), cat.list(), cat.list()])
    expect(spawnCount(log)).toBe(1)
  })

  it('a failing spawn rejects and the next call retries', async () => {
    const dir = tmp()
    const log = path.join(dir, 'log')
    let broken = true
    const cat = new ModelCatalog({
      cmd: () =>
        broken
          ? Promise.resolve({ file: path.join(dir, 'missing-omp'), argv: [], env: process.env })
          : fakeCmd(log)(),
      cwd: dir,
    })
    await expect(cat.list()).rejects.toBeInstanceOf(Error)
    broken = false
    expect((await cat.list()).length).toBeGreaterThan(0)
    expect(spawnCount(log)).toBe(1)
  })

  it('a process that never answers times out with its stdin closed', async () => {
    const dir = tmp()
    const script = path.join(dir, 'hang.mjs')
    fs.writeFileSync(
      script,
      "process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000)\n",
    )
    const cat = new ModelCatalog({
      cmd: () => Promise.resolve({ file: process.execPath, argv: [script], env: process.env }),
      cwd: dir,
      timeoutMs: 150,
    })
    await expect(cat.list()).rejects.toThrow(/in time/)
  })
})
