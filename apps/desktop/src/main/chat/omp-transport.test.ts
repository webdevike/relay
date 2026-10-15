import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Frame } from '@evaos/chat-core/line-framer'
import { OmpStdioTransport } from './omp-transport'

// A stand-in that behaves like omp on stdin EOF: it reads until EOF and exits 0.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-omp-transport-'))
const waitForEof = path.join(dir, 'wait-for-eof.sh')
fs.writeFileSync(waitForEof, '#!/bin/sh\nwhile IFS= read -r line; do :; done\nexit 0\n', {
  mode: 0o755,
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('OmpStdioTransport', () => {
  it('a failed spawn rejects start() and emits exactly one _eof', async () => {
    const t = new OmpStdioTransport({ ompBin: '/nonexistent/evaos-omp-missing', live: false })
    const types: string[] = []
    t.onFrame((f) => types.push(f.type))
    await expect(t.start({ sessionFile: '/s/a.jsonl', cwd: process.cwd() })).rejects.toThrow()
    // start() rejects on `error`; `close` follows on a later tick and carries the only `_eof`.
    expect(types).toEqual([])
    await new Promise((r) => setTimeout(r, 150))
    expect(types.filter((x) => x === '_eof')).toHaveLength(1)
    await expect(t.write({ type: 'get_state' })).rejects.toThrow('The session is not running.')
  })

  it('close() requested while start() is still spawning waits for the child and ends it', async () => {
    const t = new OmpStdioTransport({ ompBin: waitForEof, live: false })
    const frames: Frame[] = []
    t.onFrame((f) => frames.push(f))
    const starting = t.start({ sessionFile: '/s/a.jsonl', cwd: process.cwd() })
    // No child exists yet: a close that returned here would leave the process owner-less.
    const closing = t.close({ timeoutMs: 5000 })
    await starting
    expect(t.pid).not.toBeNull()
    const exit = await closing
    expect(exit).toEqual({ code: 0, signal: null, timedOut: false })
    const eofs = frames.filter((f) => f.type === '_eof')
    expect(eofs).toHaveLength(1)
    expect(eofs[0]).toMatchObject({ code: 0, signal: null, expected: true })
  })

  it('close() after a failed start does not hang and reports the spawn failure exit', async () => {
    const t = new OmpStdioTransport({ ompBin: '/nonexistent/evaos-omp-missing', live: false })
    await expect(t.start({ sessionFile: '/s/a.jsonl', cwd: process.cwd() })).rejects.toThrow()
    // Node still raises `close` for a child that never spawned (code -2 for ENOENT).
    const exit = await t.close({ timeoutMs: 1000 })
    expect(exit.timedOut).toBe(false)
    expect(exit.signal).toBeNull()
  })

  describe('argv and prompt images', () => {
    const rec = path.join(dir, 'record.sh')
    const out = path.join(dir, 'rec.out')
    fs.writeFileSync(
      rec,
      `#!/bin/sh\nprintf '%s\\n' "$*" > "${out}.argv"\n: > "${out}.in"\nwhile IFS= read -r line; do printf '%s\\n' "$line" >> "${out}.in"; done\nexit 0\n`,
      { mode: 0o755 },
    )
    const run = async (
      start: Parameters<OmpStdioTransport['start']>[0],
      body: (t: OmpStdioTransport) => Promise<void>,
    ) => {
      const t = new OmpStdioTransport({ ompBin: rec, live: false })
      await t.start(start)
      await body(t)
      await t.close({ timeoutMs: 5000 })
      return t
    }

    it('resume argv is unchanged', async () => {
      const t = await run({ sessionFile: '/s/a.jsonl', cwd: process.cwd() }, async () => {})
      expect(t.spawnArgs).toEqual(['--mode', 'rpc-ui', '--resume', '/s/a.jsonl'])
    })

    it('a new chat has no --resume and appends launch args', async () => {
      const t = await run(
        { sessionFile: null, cwd: process.cwd(), args: ['--approval-mode', 'write'] },
        async () => {},
      )
      expect(t.spawnArgs).toEqual(['--mode', 'rpc-ui', '--approval-mode', 'write'])
      expect(fs.readFileSync(`${out}.argv`, 'utf8').trim()).toBe('--mode rpc-ui --approval-mode write')
    })

    it('send carries images only when given', async () => {
      await run({ sessionFile: null, cwd: process.cwd() }, async (t) => {
        await t.send('hi', [{ type: 'image', data: 'AAA', mimeType: 'image/png' }])
        await t.send('plain')
      })
      const lines = fs
        .readFileSync(`${out}.in`, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject({
        type: 'prompt',
        message: 'hi',
        images: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }],
      })
      expect('images' in lines[1]!).toBe(false)
    })
  })
})
