import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OmpAgentRunner } from './runner'

// Integration test against real processes and signals: the escalation steps are real waits
// (STOP_STEP_MS each), so fake timers cannot drive it.
// Stand-ins for omp that misbehave on shutdown. Each spawns a grandchild (`sleep`) the way omp
// runs tools, so the test can see whether the whole group goes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-rooms-runner-'))
const pidFile = path.join(dir, 'pids')
const script = (name: string, body: string): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\nsleep 300 &\necho "$$ $!" >> "${pidFile}"\n${body}\n`, {
    mode: 0o755,
  })
  return file
}
/** Ignores stdin EOF, exits on SIGTERM. */
const stubborn = script('stubborn.sh', 'trap "kill $!; exit 0" TERM\nwhile :; do sleep 0.1; done')
/** Ignores stdin EOF and SIGTERM; only SIGKILL ends it. */
const immortal = script('immortal.sh', 'trap "" TERM\nwhile :; do sleep 0.1; done')
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** [child pid, grandchild pid] the `n`th stand-in recorded, once it has. */
const pidsOf = async (n: number): Promise<[number, number]> => {
  for (let i = 0; i < 200; i++) {
    const lines = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n') : []
    const line = lines[n]
    if (line) {
      const [a, b] = line.split(' ').map(Number)
      return [a!, b!]
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('stand-in never started')
}

const waitGone = async (pid: number): Promise<void> => {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20))
}

const start = (bin: string) =>
  new OmpAgentRunner({ ompBin: bin, live: false, cwd: dir, toolsCwd: dir }).start({
    systemPrompt: 'x',
    model: 'm',
    tools: 'none',
    thinking: 'high',
  })

describe('OmpAgentRunner.stop', { timeout: 20_000 }, () => {
  it('a child that ignores stdin EOF is SIGTERMed with its tools, and stop() returns after exit', async () => {
    const h = await start(stubborn)
    const [child, tool] = await pidsOf(0)
    expect(alive(child)).toBe(true)
    const t0 = Date.now()
    await h.stop()
    // Past the EOF wait (3 s), the TERM landed and the child exited by itself (exit 0 path).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900)
    expect(alive(child)).toBe(false)
    await waitGone(tool)
    expect(alive(tool)).toBe(false)
  })

  it('a child that also ignores SIGTERM is SIGKILLed as a group', async () => {
    const h = await start(immortal)
    const [child, tool] = await pidsOf(1)
    const t0 = Date.now()
    await h.stop()
    // EOF wait, then TERM wait, then KILL: two full steps.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5900)
    expect(alive(child)).toBe(false)
    await waitGone(tool)
    expect(alive(tool)).toBe(false)
  })
})
