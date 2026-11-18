import { describe, expect, it } from 'vitest'
import { frontmatterRows, layoutMarkdown, type MdLayout } from './md-layout'

/** What a line reads as rendered with the caret elsewhere: its text minus the hidden syntax. */
function shown(text: string, layout: MdLayout, line: number): string {
  const starts = [0, ...[...text.matchAll(/\n/g)].map((m) => (m.index ?? 0) + 1)]
  const from = starts[line - 1] ?? 0
  const to = (starts[line] ?? text.length + 1) - 1
  let out = ''
  for (let i = from; i < to; i++)
    if (!layout.syntax.some((s) => i >= s.start && i < s.end)) out += text[i]
  return out
}

const DOC = [
  '---',
  'title: Notes',
  'tags: [a, b]',
  '---',
  '',
  '## Plan **now**',
  '',
  'Read [the spec](./spec.md) and `run it`, ~~not this~~.',
  '',
  '- [ ] open',
  '- [x] done',
  '- plain',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '![diagram](img/flow.png)',
  '',
  '> quoted',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '***',
  '',
  'Title',
  '=====',
].join('\n')

describe('layoutMarkdown', () => {
  const layout = layoutMarkdown(DOC)

  it('draws frontmatter, a top-level table and a standalone image as rendered blocks', () => {
    expect(layout.blocks.map((b) => [b.kind, b.startLine, b.endLine])).toEqual([
      ['frontmatter', 1, 4],
      ['table', 14, 16],
      ['image', 18, 18],
    ])
    const image = layout.blocks.find((b) => b.kind === 'image')
    expect(image).toMatchObject({ src: 'img/flow.png', alt: 'diagram' })
  })

  it('hides the Markdown syntax off the caret, leaving the words', () => {
    expect(shown(DOC, layout, 6)).toBe('Plan now')
    expect(shown(DOC, layout, 8)).toBe('Read the spec and run it, not this.')
    expect(shown(DOC, layout, 20)).toBe('quoted')
    expect(shown(DOC, layout, 22)).toBe('ts')
    expect(shown(DOC, layout, 24)).toBe('')
    expect(shown(DOC, layout, 26)).toBe('')
    // Setext: the text stays, its underline hides.
    expect(shown(DOC, layout, 28)).toBe('Title')
    expect(shown(DOC, layout, 29)).toBe('')
  })

  it('shows each hidden mark again only while the caret is in what it marks', () => {
    const bold = layout.syntax.filter((s) => DOC.slice(s.start, s.end) === '**')
    expect(bold).toHaveLength(2)
    const word = DOC.indexOf('now')
    for (const s of bold) expect(s.scope.start <= word && word <= s.scope.end).toBe(true)
    // The heading's `## ` belongs to the whole heading line.
    const hashes = layout.syntax.find((s) => DOC.slice(s.start, s.end) === '## ')
    expect(hashes?.scope).toEqual({ start: DOC.indexOf('## Plan'), end: DOC.indexOf('\n\nRead') })
  })

  it('styles the inline spans and keeps link targets', () => {
    const text = (k: string): string[] =>
      layout.spans.filter((s) => s.kind === k).map((s) => DOC.slice(s.start, s.end))
    expect(text('strong')).toEqual(['now'])
    expect(text('link')).toEqual(['the spec'])
    expect(text('code')).toEqual(['run it'])
    expect(text('del')).toEqual(['not this'])
    expect(layout.links.map((l) => l.url)).toEqual(['./spec.md'])
  })

  it('gives tasks boxes (no bullet) and plain items bullets', () => {
    expect(layout.tasks.map((t) => [DOC.slice(t.start, t.start + 3), t.checked])).toEqual([
      ['[ ]', false],
      ['[x]', true],
    ])
    expect(layout.bullets.map((at) => DOC.slice(at, at + 7))).toEqual(['- plain'])
    expect(layout.lines.get(11)).toContain('task-done')
    expect(shown(DOC, layout, 10)).toBe('[ ] open')
  })

  it('marks headings, code, quotes and rules by line', () => {
    expect(layout.lines.get(6)).toEqual(['h2'])
    expect(layout.lines.get(22)).toEqual(['fence'])
    expect(layout.lines.get(23)).toEqual(['code'])
    expect(layout.lines.get(24)).toEqual(['fence'])
    expect(layout.lines.get(20)).toEqual(['quote'])
    expect(layout.lines.get(26)).toEqual(['hr'])
    expect(layout.lines.get(28)).toEqual(['h1'])
  })

  it('leaves a table inside a list as lines, and an unclosed fence runs to the end', () => {
    const nested = layoutMarkdown('- item\n\n  | a |\n  |---|\n  | 1 |\n')
    expect(nested.blocks).toEqual([])
    const open = layoutMarkdown('```\na\nb')
    expect([open.lines.get(2), open.lines.get(3)]).toEqual([['code'], ['code']])
  })

  it('reads frontmatter as properties, other lines as they are', () => {
    expect(frontmatterRows('---\ntitle: Notes\nlist:\n  - one\n---')).toEqual([
      { key: 'title', value: 'Notes' },
      { key: 'list', value: '' },
      { key: null, value: '  - one' },
    ])
  })
})
