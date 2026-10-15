import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Frame } from '@evaos/chat-core/line-framer'
import { ClaudeBridgeTransport } from './claude-transport'

const FAKE = path.resolve(__dirname, '../../../../../fixtures/fake-claude-bridge/fake-bridge.mjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-claude-transport-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function bridgeArgv(log: string): string[] {
  return fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; detail?: { argv: string[] } })
    .filter((e) => e.event === 'claude-bridge')
    .map((e) => e.detail!.argv)[0]!
}

async function run(start: Parameters<ClaudeBridgeTransport['start']>[0], name: string) {
  const log = path.join(dir, `${name}.log`)
  const t = new ClaudeBridgeTransport({
    bridgeBin: FAKE,
    live: false,
    takeExtraEnv: () => ({ FAKE_OMP_LOG: log }),
  })
  const frames: Frame[] = []
  t.onFrame((f) => frames.push(f))
  await t.start(start)
  await expect.poll(() => frames.some((f) => f.type === 'ready')).toBe(true)
  const exit = await t.close({ timeoutMs: 5000 })
  return { t, frames, log, exit }
}

describe('ClaudeBridgeTransport', () => {
  it('resume spawns the bridge with --rpc, --resume and the launch flags', async () => {
    const { t, log, frames, exit } = await run(
      { sessionFile: '/s/a.jsonl', cwd: process.cwd(), args: ['--model', 'x'] },
      'resume',
    )
    expect(t.kind).toBe('claude')
    expect(t.spawnArgs).toEqual(['--rpc', '--resume', '/s/a.jsonl', '--model', 'x'])
    expect(bridgeArgv(log)).toEqual(['--rpc', '--resume', '/s/a.jsonl', '--model', 'x'])
    expect(exit.timedOut).toBe(false)
    expect(frames.filter((f) => f.type === '_eof')).toHaveLength(1)
  })

  it('a new chat omits --resume', async () => {
    const { t, log } = await run({ sessionFile: null, cwd: process.cwd() }, 'new')
    expect(t.spawnArgs).toEqual(['--rpc'])
    expect(bridgeArgv(log)).toEqual(['--rpc'])
  })

  it('a missing bridge rejects start() and emits one _eof', async () => {
    const t = new ClaudeBridgeTransport({ bridgeBin: '/nonexistent/bridge', live: false })
    const types: string[] = []
    t.onFrame((f) => types.push(f.type))
    await expect(t.start({ sessionFile: null, cwd: process.cwd() })).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 150))
    expect(types.filter((x) => x === '_eof')).toHaveLength(1)
  })

  it('never signals its child', () => {
    const src = fs.readFileSync(path.join(__dirname, 'claude-transport.ts'), 'utf8')
    const base = fs.readFileSync(path.join(__dirname, 'omp-transport.ts'), 'utf8')
    expect(src).not.toMatch(/\.kill\(/)
    expect(base).not.toMatch(/\.kill\(/)
  })
})
