import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseHunks } from './diff'
import { DiffView } from './DiffView'
import { highlightHunks, languageForPath, splitHighlighted } from './diff-highlight'

describe('languageForPath', () => {
  it.each([
    ['src/a/revealFirstInvalidField.ts', 'typescript'],
    ['x.tsx', 'typescript'],
    ['x.js', 'javascript'],
    ['package.json', 'json'],
    ['a.css', 'css'],
    ['README.md', 'markdown'],
    ['a.py', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['ci.yaml', 'yaml'],
    ['q.sql', 'sql'],
    ['run.sh', 'bash'],
    ['Dockerfile', 'dockerfile'],
  ])('%s -> %s', (path, lang) => expect(languageForPath(path)).toBe(lang))

  it('is null for unknown or extensionless files', () => {
    expect(languageForPath('LICENSE')).toBeNull()
    expect(languageForPath('a.png')).toBeNull()
  })
})

describe('splitHighlighted', () => {
  it('closes and reopens spans across newlines', () => {
    expect(splitHighlighted('<span class="hljs-comment">a\nb</span>\nc')).toEqual([
      '<span class="hljs-comment">a</span>',
      '<span class="hljs-comment">b</span>',
      'c',
    ])
  })
})

const PATCH = ['@@ -1,2 +1,2 @@', ' const a = 1', '-const b = "x"', '+const b = "y"'].join('\n')

describe('DiffView highlighting', () => {
  it('highlights a known language and keeps line kinds', () => {
    const hunks = parseHunks(PATCH)
    const html = renderToStaticMarkup(<DiffView hunks={hunks} mode="unified" path="a.ts" />)
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('hljs-string')
    expect(html).toContain('data-kind="add"')
    expect(html).toContain('data-kind="del"')
    expect(highlightHunks('a.ts', hunks)).toBe(highlightHunks('a.ts', hunks))
  })

  it('renders split mode highlighted', () => {
    const html = renderToStaticMarkup(
      <DiffView hunks={parseHunks(PATCH)} mode="split" path="a.ts" />,
    )
    expect(html).toContain('hljs-keyword')
  })

  it('stays plain for unknown languages', () => {
    const html = renderToStaticMarkup(
      <DiffView hunks={parseHunks(PATCH)} mode="unified" path="notes.xyz" />,
    )
    expect(html).not.toContain('hljs')
    expect(html).not.toContain('review-diff-plain')
  })

  it('turns highlighting off with a note for very large files', () => {
    const body = Array.from({ length: 4100 }, (_, i) => `+const v${i} = 1`)
    const hunks = parseHunks(['@@ -0,0 +1,4100 @@', ...body].join('\n'))
    const html = renderToStaticMarkup(<DiffView hunks={hunks} mode="unified" path="big.ts" />)
    expect(html).not.toContain('hljs-keyword')
    expect(html).toContain('Syntax highlighting off for large file')
  })
})
