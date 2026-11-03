// Syntax highlighting for diff lines with highlight.js, the highlighter chat code blocks use.
import { highlight } from '../chat/markdown/CodeBlock'
import type { Hunk } from './diff'

/** Beyond this many lines in one file's hunks (or this wide a line) highlighting is skipped. */
export const MAX_HIGHLIGHT_LINES = 4000
export const MAX_HIGHLIGHT_LINE_LENGTH = 2000

const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  toml: 'ini',
  ini: 'ini',
  graphql: 'graphql',
  gql: 'graphql',
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

/** The highlight.js language for a path, or null when the extension is unknown. */
export function languageForPath(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]!
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return BY_EXT[name.slice(dot + 1)] ?? null
}

/** One line's highlighted HTML per input line: spans open across a newline are closed and reopened. */
export function splitHighlighted(html: string): string[] {
  const out: string[] = []
  const open: string[] = []
  let cur = ''
  let last = 0
  const re = /<span [^>]*>|<\/span>|\n/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    cur += html.slice(last, m.index)
    last = m.index + m[0].length
    if (m[0] === '\n') {
      out.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
    } else if (m[0] === '</span>') {
      open.pop()
      cur += m[0]
    } else {
      open.push(m[0])
      cur += m[0]
    }
  }
  out.push(cur + html.slice(last) + '</span>'.repeat(open.length))
  return out
}

function highlightSide(lang: string, texts: string[]): string[] | null {
  const html = highlight(lang, texts.join('\n'))
  if (html === null) return null
  const lines = splitHighlighted(html)
  return lines.length === texts.length ? lines : null
}

export type HunkHtml = Map<Hunk['lines'][number], string>

const cache = new WeakMap<readonly Hunk[], Map<string, HunkHtml | null>>()

/**
 * Highlighted HTML per diff line, keyed by the line object. Each hunk is highlighted as its old
 * side (context + deletions) and new side (context + additions) so multi-line tokens carry
 * across lines. Null when the language is unknown or the file is too large. Cached per hunks.
 */
export function highlightHunks(path: string, hunks: readonly Hunk[]): HunkHtml | null {
  const lang = languageForPath(path)
  if (!lang) return null
  let byPath = cache.get(hunks)
  if (!byPath) cache.set(hunks, (byPath = new Map()))
  if (byPath.has(path)) return byPath.get(path)!
  const result = compute(lang, hunks)
  byPath.set(path, result)
  return result
}

export function isTooLarge(hunks: readonly Hunk[]): boolean {
  let n = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (++n > MAX_HIGHLIGHT_LINES || l.text.length > MAX_HIGHLIGHT_LINE_LENGTH) return true
    }
  return false
}

function compute(lang: string, hunks: readonly Hunk[]): HunkHtml | null {
  if (isTooLarge(hunks)) return null
  const out: HunkHtml = new Map()
  for (const h of hunks) {
    for (const side of ['del', 'add'] as const) {
      const lines = h.lines.filter((l) => l.kind === 'ctx' || l.kind === side)
      const html = highlightSide(
        lang,
        lines.map((l) => l.text),
      )
      if (!html) continue
      lines.forEach((l, i) => {
        // Context lines read the same either side; the new side wins.
        if (l.kind === side || !out.has(l)) out.set(l, html[i]!)
      })
    }
  }
  return out
}
