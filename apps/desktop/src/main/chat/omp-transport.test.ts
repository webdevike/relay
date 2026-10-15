import { describe, expect, it } from 'vitest'
import { OmpStdioTransport } from './omp-transport'

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
})
