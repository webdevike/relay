import { describe, expect, it } from 'vitest'
import {
  contextAt,
  findAll,
  locate,
  placeQuote,
  placeThreads,
  plainQuote,
  type AnchorContext,
  type Placement,
} from './inline-anchor'

// The description as rendered: its text nodes joined (no separators between blocks).
const TEXT = ['Save the draft first.', 'Then ', 'save', ' the draft again.'].join('')

const slice = (text: string, p: Placement): string =>
  p.kind === 'anchored' ? text.slice(p.start, p.end) : ''

describe('inline anchors', () => {
  it('a quote found once anchors on its match', () => {
    const p = placeQuote(TEXT, 'draft first', null)
    expect(p).toMatchObject({ kind: 'anchored', ambiguous: false })
    expect(slice(TEXT, p)).toBe('draft first')
  })

  it('a quote across inline formatting and line breaks still matches the rendered text', () => {
    // `Then **save** the draft` renders as three text nodes; Linear's quote may keep the markers.
    const pieces = ['Then ', 'save', ' the ', 'draft', '\nagain.']
    const text = pieces.join('')
    for (const q of ['Then save the draft', 'Then **save** the draft', 'save the draft again']) {
      expect(placeQuote(text, q, null)).toMatchObject({ kind: 'anchored', ambiguous: false })
    }
    expect(plainQuote('see [the docs](https://x.test/a) and `code`')).toBe('seethedocsandcode')
    // Its start and end map back to the text nodes it spans.
    const hit = findAll(text, 'save the draft')[0]!
    const lengths = pieces.map((p) => p.length)
    expect(locate(lengths, hit.start)).toEqual({ index: 0, offset: 5 })
    expect(locate(lengths, hit.end)).toEqual({ index: 3, offset: 5 })
  })

  it('a duplicate quote without context shows on its first match, marked ambiguous', () => {
    const p = placeQuote(TEXT, 'the draft', null)
    expect(p).toMatchObject({ kind: 'anchored', ambiguous: true })
    expect(p.kind === 'anchored' && p.start).toBe(TEXT.indexOf('the draft'))
  })

  it('the saved context picks the occurrence, and survives a reload (JSON round trip)', () => {
    const second = findAll(TEXT, 'the draft')[1]!
    const saved = JSON.parse(JSON.stringify(contextAt(TEXT, second))) as AnchorContext
    expect(saved).toEqual({ prefix: 'Savethedraftfirst.Thensave', suffix: 'again.' })
    const p = placeQuote(TEXT, 'the draft', saved)
    expect(p).toMatchObject({ kind: 'anchored', ambiguous: false, start: second.start })
    // Reflowed or reformatted around it, the same context still picks the second one.
    const reflowed = 'Save the draft  first.\n\nThen save\nthe draft again.'
    const q = placeQuote(reflowed, 'the draft', saved)
    expect(q).toMatchObject({ ambiguous: false, start: reflowed.lastIndexOf('the draft') })
  })

  it('edited text: a quote no longer there is on removed text', () => {
    const { anchored, removed } = placeThreads(TEXT, [
      { id: 'b', quotedText: 'again' },
      { id: 'gone', quotedText: 'publish the draft' },
      { id: 'a', quotedText: 'Save the', anchor: null },
      { id: 'empty', quotedText: null },
    ])
    expect(anchored.map((a) => a.id)).toEqual(['a', 'b'])
    expect(removed).toEqual(['gone', 'empty'])
  })
})
