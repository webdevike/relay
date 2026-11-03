import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LineFramer, type Frame } from './line-framer'

const here = dirname(fileURLToPath(import.meta.url))
const recorded: Frame[] = readFileSync(
  join(here, '../../../fixtures/fake-omp/recordings/turn.jsonl'),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l).frame)
const wire = recorded.map((f) => JSON.stringify(f) + '\n')
const wireBuf = Buffer.from(wire.join(''))

function run(feed: (f: LineFramer) => void) {
  const frames: Frame[] = []
  const bad: string[] = []
  const f = new LineFramer(
    (x) => frames.push(x),
    (l) => bad.push(l),
  )
  feed(f)
  f.end()
  return { frames, bad }
}

describe('LineFramer chunking equivalence (CHAT-03)', () => {
  it('whole lines is the baseline', () => {
    const { frames, bad } = run((f) => wire.forEach((l) => f.push(l)))
    expect(frames).toEqual(recorded)
    expect(bad).toEqual([])
    expect(recorded.length).toBeGreaterThanOrEqual(15)
  })

  it('(a) 1-byte chunks yield the same frames', () => {
    const { frames } = run((f) => {
      for (let i = 0; i < wireBuf.length; i++) f.push(wireBuf.subarray(i, i + 1))
    })
    expect(frames).toEqual(recorded)
  })

  it('(b) all lines glued into one buffer yield the same frames', () => {
    const { frames } = run((f) => f.push(wireBuf))
    expect(frames).toEqual(recorded)
  })

  it('(c) splits at every byte offset inside the emoji and 2/3-byte characters keep text intact', () => {
    const text = 'a é b € c 🚀 d'
    const line = Buffer.from(JSON.stringify({ type: 'message_end', message: { text } }) + '\n')
    for (let cut = 1; cut < line.length; cut++) {
      const { frames } = run((f) => {
        f.push(line.subarray(0, cut))
        f.push(line.subarray(cut))
      })
      expect(frames).toHaveLength(1)
      expect((frames[0].message as { text: string }).text).toBe(text)
    }
    // emoji-bearing recorded stream split at every offset inside the first multibyte char
    const first = wireBuf.findIndex((b) => b >= 0x80)
    for (let cut = first + 1; cut < first + 4; cut++) {
      const { frames } = run((f) => {
        f.push(wireBuf.subarray(0, cut))
        f.push(wireBuf.subarray(cut))
      })
      expect(frames).toEqual(recorded)
    }
    expect(JSON.stringify(recorded)).toContain('🚀')
  })

  it('(d) a 900 KB line frames correctly and is not truncated', () => {
    const big = 'x'.repeat(900 * 1024)
    const line = JSON.stringify({ type: 'message_update', message: { text: big } }) + '\n'
    const buf = Buffer.from(line)
    const { frames, bad } = run((f) => {
      for (let i = 0; i < buf.length; i += 65536) f.push(buf.subarray(i, i + 65536))
    })
    expect(bad).toEqual([])
    expect(frames).toHaveLength(1)
    expect((frames[0].message as { text: string }).text.length).toBe(big.length)
  })

  it('(e) a non-JSON line reports once and both neighbours arrive in order', () => {
    const { frames, bad } = run((f) => {
      f.push(wire[0])
      f.push('this is not json\n')
      f.push(wire[1])
    })
    expect(bad).toEqual(['this is not json'])
    expect(frames).toEqual([recorded[0], recorded[1]])
  })

  it('keeps U+2028 inside a JSON string as one frame', () => {
    const { frames } = run((f) =>
      f.push(JSON.stringify({ type: 'x', t: 'a b c' }).replace(/\\u2028/g, ' ') + '\n'),
    )
    expect(frames).toHaveLength(1)
    expect(frames[0].t).toBe('a b c')
  })

  it('tolerates CRLF, ignores empty lines, and end() flushes an unterminated tail', () => {
    const { frames, bad } = run((f) => {
      f.push('{"type":"a"}\r\n\r\n\n{"type":"b"}\r\n{"type":"c"}')
    })
    expect(frames.map((x) => x.type)).toEqual(['a', 'b', 'c'])
    expect(bad).toEqual([])
  })

  it('drops JSON that is not an object with a string type, reporting nothing fatal', () => {
    const { frames } = run((f) => f.push('[1,2]\n{"type":5}\n{"type":"ok"}\n'))
    expect(frames.map((x) => x.type)).toEqual(['ok'])
  })
})
