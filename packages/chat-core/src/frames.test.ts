import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cmd, parseFrame } from './frames'

const here = dirname(fileURLToPath(import.meta.url))
const recorded = readFileSync(
  join(here, '../../../fixtures/fake-omp/recordings/turn.jsonl'),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l).frame as { type: string })

describe('parseFrame', () => {
  it('parses every recorded frame without throwing and keeps the type', () => {
    for (const f of recorded) {
      const p = parseFrame(f)
      expect(p.type === f.type || p.type === 'unknown').toBe(true)
    }
    const kinds = new Set(recorded.map((f) => parseFrame(f).type))
    expect(kinds.has('message_update')).toBe(true)
    expect(kinds.has('session_settled')).toBe(true)
  })

  it('returns unknown for forward-compatible types and never throws', () => {
    expect(parseFrame({ type: 'subagent_lifecycle', payload: { id: 'a' } })).toEqual({
      type: 'unknown',
      raw: { type: 'subagent_lifecycle', payload: { id: 'a' } },
    })
    expect(parseFrame({ type: 'message_update', message: 'bad' }).type).toBe('unknown')
    expect(parseFrame({} as never).type).toBe('unknown')
  })

  it('parses ready and passes extra fields through', () => {
    const p = parseFrame({
      type: 'ready',
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      extra: 1,
    })
    expect(p.type).toBe('ready')
    expect((p as unknown as { extra: number }).extra).toBe(1)
  })
})

describe('cmd builders', () => {
  it('builds v1 commands only', () => {
    expect(cmd.prompt('evaos-1', 'hi')).toEqual({
      type: 'prompt',
      id: 'evaos-1',
      message: 'hi',
      streamingBehavior: 'steer',
    })
    expect(cmd.abort('a')).toEqual({ type: 'abort', id: 'a' })
    expect(cmd.getState('g')).toEqual({ type: 'get_state', id: 'g' })
    expect(cmd.setAskDialog('s')).toEqual({ type: 'set_ask_dialog', enabled: true, id: 's' })
    expect(cmd.cancelUi('r1')).toEqual({ type: 'extension_ui_response', id: 'r1', cancelled: true })
  })
})
