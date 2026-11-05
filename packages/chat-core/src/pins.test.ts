import { describe, expect, it } from 'vitest'
import { Artifact, ArtifactAction, MAX_PIN_VALUE, ruleMatches } from './artifacts'
import {
  MAX_MARKUP_PINS,
  inferPinKind,
  parsePinBody,
  pinId,
  pinLabelOf,
  pinOfText,
  pinsOf,
  splitPins,
} from './pins'
const base: Pick<Artifact, 'mentions' | 'firstSeen' | 'lastSeen' | 'sources' | 'addedBy'> = {
  mentions: 0,
  firstSeen: 1,
  lastSeen: 1,
  sources: [],
  addedBy: 'isaac',
}

const snippet = (kind: Artifact['pin'] & object, by: string, at: number): Artifact => ({
  ...base,
  id: pinId(kind.kind, kind.value),
  kind: 'pin',
  title: kind.label,
  pin: kind,
  pinned: { by, at },
})

describe('pin model', () => {
  it('is a pinned artifact: a snippet carries its note, the pinned stamp says who and when', () => {
    const a = snippet(
      { kind: 'code', label: 'Deploy', value: 'bun deploy', source: 'assistant@5' },
      'astra',
      20,
    )
    expect(Artifact.safeParse(a).success).toBe(true)
    expect(pinsOf([a])).toEqual([
      {
        id: a.id,
        kind: 'code',
        label: 'Deploy',
        value: 'bun deploy',
        source: 'assistant@5',
        pinnedBy: 'astra',
        at: 20,
      },
    ])
  })

  it('keeps snippets out of the artifact tabs unless a rule asks for kind pin', () => {
    const a = snippet(
      { kind: 'text', label: 'Note', value: 'remember', source: undefined },
      'isaac',
      2,
    )
    expect(ruleMatches({}, a)).toBe(false)
    expect(ruleMatches({ pinned: true }, a)).toBe(false)
    expect(ruleMatches({ kind: ['pin'] }, a)).toBe(true)
    expect(ruleMatches({}, { ...a, kind: 'url', pin: undefined })).toBe(true)
  })

  it('shows a pinned PR, ticket, file and link as pins of their own kind, newest first, and skips unpinned items', () => {
    const pinned = (id: string, extra: Partial<Artifact>, at: number): Artifact => ({
      ...base,
      id,
      kind: id.split(':')[0] as Artifact['kind'],
      title: id,
      pinned: { by: 'isaac', at },
      ...extra,
    })
    const pins = pinsOf([
      pinned('gh-pr:o/r#1', { url: 'https://github.com/o/r/pull/1', sources: ['user@9'] }, 1),
      pinned('linear:ENG-1', { url: 'https://linear.app/x/issue/ENG-1' }, 2),
      pinned('file:/tmp/a.txt', { path: '/tmp/a.txt' }, 3),
      pinned('url:https://x.dev', { url: 'https://x.dev' }, 4),
      { ...base, id: 'url:https://y.dev', kind: 'url', title: 'y', url: 'https://y.dev' },
    ])
    expect(pins.map((p) => [p.kind, p.value])).toEqual([
      ['link', 'https://x.dev'],
      ['file', '/tmp/a.txt'],
      ['item', 'https://linear.app/x/issue/ENG-1'],
      ['pr', 'https://github.com/o/r/pull/1'],
    ])
    expect(pins[3]!.source).toBe('user@9')
  })

  it('ids the same snippet once and different snippets apart', () => {
    expect(pinId('link', 'https://a')).toBe(pinId('link', 'https://a'))
    expect(pinId('link', 'https://a')).not.toBe(pinId('text', 'https://a'))
    expect(pinId('link', 'https://a')).toMatch(/^pin:[0-9a-f]{16}$/)
  })

  it('infers kinds from values', () => {
    expect(inferPinKind('https://example.com/a?b=1')).toBe('link')
    expect(inferPinKind('https://github.com/o/r/pull/12')).toBe('pr')
    expect(inferPinKind('https://linear.app/ecard/issue/ENG-6545/x')).toBe('item')
    expect(inferPinKind('/Users/ike/Eva/notes.md')).toBe('file')
    expect(inferPinKind('~/x.txt')).toBe('file')
    expect(inferPinKind('4242')).toBe('number')
    expect(inferPinKind('$1,299.50')).toBe('number')
    expect(inferPinKind('+1 (555) 010-2030')).toBe('number')
    expect(inferPinKind('$ bun test')).toBe('code')
    expect(inferPinKind('a\nb')).toBe('code')
    expect(inferPinKind('the staging login')).toBe('text')
  })

  it('labels a pin from its first line', () => {
    expect(pinLabelOf('\n  hello   world \nmore')).toBe('hello world')
    expect(pinLabelOf('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
    expect(pinLabelOf('  ')).toBe('Pin')
    expect(pinOfText('  ')).toBeNull()
    const long = pinOfText('y'.repeat(MAX_PIN_VALUE + 5))!
    expect(long.value).toHaveLength(MAX_PIN_VALUE)
    expect(pinOfText('1234', { label: 'Code' })).toEqual({
      kind: 'number',
      label: 'Code',
      value: '1234',
    })
  })

  it('takes pin.add and pin.remove actions', () => {
    expect(
      ArtifactAction.safeParse({ op: 'pin.add', kind: 'link', label: 'Spec', value: 'https://x' })
        .success,
    ).toBe(true)
    expect(
      ArtifactAction.safeParse({ op: 'pin.add', kind: 'nope', label: 'a', value: 'b' }).success,
    ).toBe(false)
    expect(
      ArtifactAction.safeParse({ op: 'pin.add', kind: 'text', label: ' ', value: 'b' }).success,
    ).toBe(false)
    expect(ArtifactAction.safeParse({ op: 'pin.remove', id: 'pin:1', force: true }).success).toBe(
      true,
    )
  })
})

describe('pin markup', () => {
  it('parses label | value, a backticked value as code, and the value may hold bars', () => {
    expect(parsePinBody(' Staging  login | https://stg.example.com ')).toEqual({
      kind: 'link',
      label: 'Staging login',
      value: 'https://stg.example.com',
    })
    expect(parsePinBody('Run | `bun test | tail`')).toEqual({
      kind: 'code',
      label: 'Run',
      value: 'bun test | tail',
    })
    expect(parsePinBody('Order | 8841')).toMatchObject({ kind: 'number' })
    expect(parsePinBody('no bar')).toBeNull()
    expect(parsePinBody(' | x')).toBeNull()
    expect(parsePinBody('a |  ')).toBeNull()
    expect(parsePinBody(`a | ${'x'.repeat(MAX_PIN_VALUE + 1)}`)).toBeNull()
  })

  it('cuts pin lines from the reply and returns the pins', () => {
    const r = splitPins(
      'Done. The login:\n[[pin: Staging | https://stg.example.com]]\nAnd the code.\n[[pin: Code | 4242]]\n',
    )
    expect(r.text).toBe('Done. The login:\nAnd the code.')
    expect(r.pins).toEqual([
      { kind: 'link', label: 'Staging', value: 'https://stg.example.com' },
      { kind: 'number', label: 'Code', value: '4242' },
    ])
  })

  it('leaves text without pins, mid-line tokens, malformed lines and fenced examples alone', () => {
    for (const t of [
      'plain',
      'see [[pin: a | b]] inline',
      '[[pin: no value]]',
      '```\n[[pin: a | b]]\n```',
      'link [x](y)',
    ]) {
      const r = splitPins(t)
      expect(r.text).toBe(t)
      expect(r.pins).toEqual([])
    }
  })

  it('collapses the blank run a mid-text line leaves', () => {
    expect(splitPins('a\n\n[[pin: x | 1234]]\n\nb').text).toBe('a\n\nb')
  })

  it('dedupes and caps pins per reply', () => {
    const dup = splitPins('[[pin: a | 1234]]\n[[pin: b | 1234]]')
    expect(dup.pins).toHaveLength(1)
    const many = splitPins(
      Array.from({ length: 9 }, (_, i) => `[[pin: n${i} | ${1000 + i}]]`).join('\n'),
    )
    expect(many.pins).toHaveLength(MAX_MARKUP_PINS)
    expect(many.text).toBe('')
  })

  it('hides a token that is still arriving while the reply streams, and only then', () => {
    expect(splitPins('hi\n[[pi', true).text).toBe('hi')
    expect(splitPins('hi\n[[pin: a | ht', true).text).toBe('hi')
    expect(splitPins('hi\n[', true).text).toBe('hi')
    expect(splitPins('hi\n[[pi', false).text).toBe('hi\n[[pi')
    expect(splitPins('hi [[pi', true).text).toBe('hi [[pi')
    expect(splitPins('```\n[[pin: a', true).text).toBe('```\n[[pin: a')
  })
})
