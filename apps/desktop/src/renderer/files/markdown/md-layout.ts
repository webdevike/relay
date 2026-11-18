import { fromMarkdown } from 'mdast-util-from-markdown'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes, Parents, PhrasingContent, Root, RootContent } from 'mdast'

// How a Markdown buffer is drawn rendered in the Files editor (live-preview.ts): which lines are
// headings, code or quotes, which inline ranges are bold, links or code, which characters are
// Markdown syntax to hide while the caret is elsewhere, and which blocks (tables, standalone
// images, frontmatter) are drawn as their rendered form instead of their lines. Pure: text in,
// offsets out. The text itself is never rewritten, so what is saved is exactly what was typed.

export type LineKind =
  'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'code' | 'fence' | 'quote' | 'hr' | 'html' | 'task-done'

export type SpanKind = 'strong' | 'em' | 'del' | 'code' | 'link' | 'syntax-dim'

/** A range of characters, `[start, end)` offsets into the text. */
export interface Span {
  start: number
  end: number
}

export interface StyledSpan extends Span {
  kind: SpanKind
}

/**
 * Markdown syntax (`**`, `## `, `](url)`) hidden while the caret is outside `scope`, and shown dim
 * while it is in it, so the marks are there to edit exactly where Isaac is typing.
 */
export interface Syntax extends Span {
  scope: Span
}

export interface LinkSpan extends Span {
  url: string
}

/** A task list checkbox: `[ ]` or `[x]` at `start` (3 characters). */
export interface TaskBox {
  start: number
  checked: boolean
}

/** A block drawn as its rendered form while the caret is outside its lines. 1-based lines. */
export type Block =
  | { kind: 'table'; startLine: number; endLine: number; source: string }
  | { kind: 'image'; startLine: number; endLine: number; source: string; src: string; alt: string }
  | { kind: 'frontmatter'; startLine: number; endLine: number; source: string }

export interface MdLayout {
  /** Kinds per 1-based line. */
  lines: Map<number, LineKind[]>
  spans: StyledSpan[]
  syntax: Syntax[]
  links: LinkSpan[]
  tasks: TaskBox[]
  /** Unordered list markers (`-`, `*`, `+`), drawn as bullets. */
  bullets: number[]
  blocks: Block[]
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

function parse(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
  })
}

const startOf = (n: Nodes): number => n.position?.start.offset ?? 0
const endOf = (n: Nodes): number => n.position?.end.offset ?? 0
const startLine = (n: Nodes): number => n.position?.start.line ?? 1
const endLine = (n: Nodes): number => n.position?.end.line ?? 1

/** Character offsets where each 1-based line starts (index 0 is line 1). */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

export function layoutMarkdown(text: string): MdLayout {
  const out: MdLayout = {
    lines: new Map(),
    spans: [],
    syntax: [],
    links: [],
    tasks: [],
    bullets: [],
    blocks: [],
  }
  const starts = lineStarts(text)
  const lineText = (line: number): string =>
    text.slice(starts[line - 1] ?? text.length, (starts[line] ?? text.length + 1) - 1)
  const lineSpan = (line: number): Span => {
    const start = starts[line - 1] ?? text.length
    return { start, end: start + lineText(line).length }
  }
  const kind = (line: number, k: LineKind): void => {
    const list = out.lines.get(line)
    if (list) {
      if (!list.includes(k)) list.push(k)
    } else out.lines.set(line, [k])
  }
  const hide = (start: number, end: number, scope: Span): void => {
    if (end > start) out.syntax.push({ start, end, scope })
  }
  const style = (start: number, end: number, k: SpanKind): void => {
    if (end > start) out.spans.push({ start, end, kind: k })
  }

  // Inline -----------------------------------------------------------------------------------

  /** `open` and `close` are the syntax around the children of `node` (`**`, `[` and `](url)`). */
  const wrap = (node: Parents & PhrasingContent, k: SpanKind): void => {
    const first = node.children[0]
    const last = node.children.at(-1)
    const scope = { start: startOf(node), end: endOf(node) }
    if (!first || !last) {
      hide(scope.start, scope.end, scope)
      return
    }
    hide(scope.start, startOf(first), scope)
    hide(endOf(last), scope.end, scope)
    style(startOf(first), endOf(last), k)
  }

  const phrasing = (nodes: readonly PhrasingContent[]): void => {
    for (const n of nodes) {
      switch (n.type) {
        case 'strong':
          wrap(n, 'strong')
          phrasing(n.children)
          break
        case 'emphasis':
          wrap(n, 'em')
          phrasing(n.children)
          break
        case 'delete':
          wrap(n, 'del')
          phrasing(n.children)
          break
        case 'inlineCode': {
          const s = startOf(n)
          const e = endOf(n)
          const ticks = /^`+/.exec(text.slice(s, e))?.[0].length ?? 1
          const scope = { start: s, end: e }
          hide(s, s + ticks, scope)
          hide(e - ticks, e, scope)
          style(s + ticks, e - ticks, 'code')
          break
        }
        case 'link':
        case 'linkReference': {
          const s = startOf(n)
          const e = endOf(n)
          if (n.type === 'link') out.links.push({ start: s, end: e, url: n.url })
          // An autolink (`<https://x>`, `www.x.com`) has no `[`: only its angle brackets hide.
          if (text[s] === '[') wrap(n, 'link')
          else {
            const scope = { start: s, end: e }
            if (text[s] === '<') {
              hide(s, s + 1, scope)
              hide(e - 1, e, scope)
            }
            style(s, e, 'link')
          }
          phrasing(n.children)
          break
        }
        case 'image':
        case 'imageReference': {
          // An image inside a line: its alt text stands in for it, the rest hides.
          const s = startOf(n)
          const e = endOf(n)
          const scope = { start: s, end: e }
          const alt = n.alt ?? ''
          const at = alt === '' ? -1 : text.indexOf(alt, s + 2)
          if (at === -1 || at + alt.length > e) {
            style(s, e, 'syntax-dim')
            break
          }
          hide(s, at, scope)
          hide(at + alt.length, e, scope)
          style(at, at + alt.length, 'link')
          break
        }
        case 'html':
          style(startOf(n), endOf(n), 'syntax-dim')
          break
        case 'footnoteReference':
          style(startOf(n), endOf(n), 'link')
          break
        default:
          break
      }
    }
  }

  // Blocks -----------------------------------------------------------------------------------

  /** The image a paragraph holds alone (surrounding whitespace aside), if it does. */
  const soleImage = (n: RootContent): { src: string; alt: string } | null => {
    if (n.type !== 'paragraph') return null
    const kids = n.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''))
    const only = kids.length === 1 ? kids[0] : undefined
    return only?.type === 'image' ? { src: only.url, alt: only.alt ?? '' } : null
  }

  const block = (n: RootContent, top: boolean): void => {
    const s = startLine(n)
    const e = endLine(n)
    const source = text.slice(startOf(n), endOf(n))
    switch (n.type) {
      case 'yaml':
        if (top) out.blocks.push({ kind: 'frontmatter', startLine: s, endLine: e, source })
        else for (let l = s; l <= e; l++) kind(l, 'code')
        return
      case 'heading': {
        const h = HEADINGS[n.depth - 1] ?? 'h6'
        const first = n.children[0]
        const last = n.children.at(-1)
        const scope = { start: startOf(n), end: endOf(n) }
        if (text[startOf(n)] === '#' || text.slice(startOf(n)).trimStart().startsWith('#')) {
          // ATX: `## Title ##`.
          kind(s, h)
          if (first && last) {
            hide(startOf(n), startOf(first), scope)
            hide(endOf(last), endOf(n), scope)
          } else hide(startOf(n), endOf(n), scope)
        } else {
          // Setext: the text lines, then the `===` or `---` underline.
          for (let l = s; l < e; l++) kind(l, h)
          hide(lineSpan(e).start - 1, endOf(n), scope)
        }
        phrasing(n.children)
        return
      }
      case 'paragraph': {
        const image = soleImage(n)
        if (image && top) {
          out.blocks.push({ kind: 'image', startLine: s, endLine: e, source, ...image })
          return
        }
        phrasing(n.children)
        return
      }
      case 'blockquote':
        for (let l = s; l <= e; l++) {
          kind(l, 'quote')
          const { start } = lineSpan(l)
          const marks = /^[ \t]*(?:>[ \t]?)+/.exec(lineText(l))?.[0].length ?? 0
          hide(start, start + marks, lineSpan(l))
        }
        for (const c of n.children) block(c, false)
        return
      case 'list':
        for (const item of n.children) {
          const at = startOf(item)
          const head = text.slice(at, at + 12)
          const task = item.checked !== null && item.checked !== undefined
          // A task's box stands in for its bullet.
          if (!n.ordered && !task && /^[-*+]/.test(head)) out.bullets.push(at)
          if (task) {
            const box = /^(?:[-*+]|\d{1,9}[.)])[ \t]+(\[[ xX]\])/.exec(head)
            if (box?.[1]) {
              const boxAt = at + head.indexOf(box[1])
              out.tasks.push({ start: boxAt, checked: item.checked === true })
              // Its box stands in for the list marker, which shows on the caret's line.
              hide(at, boxAt, lineSpan(startLine(item)))
            }
            if (item.checked)
              for (let l = startLine(item); l <= endLine(item); l++) kind(l, 'task-done')
          }
          for (const c of item.children) block(c, false)
        }
        return
      case 'code': {
        const fenced = /^[ \t]*(`{3,}|~{3,})/.exec(lineText(s))
        if (!fenced) {
          for (let l = s; l <= e; l++) kind(l, 'code')
          return
        }
        const closes = e > s && /^[ \t]*(`{3,}|~{3,})[ \t]*$/.test(lineText(e))
        const open = lineSpan(s)
        kind(s, 'fence')
        // The opening fence keeps its language as a quiet label; the backticks hide.
        hide(open.start, open.start + fenced[0].length, open)
        for (let l = s + 1; l < (closes ? e : e + 1); l++) kind(l, 'code')
        if (closes) {
          kind(e, 'fence')
          hide(lineSpan(e).start, lineSpan(e).end, lineSpan(e))
        }
        return
      }
      case 'thematicBreak':
        kind(s, 'hr')
        hide(lineSpan(s).start, lineSpan(s).end, lineSpan(s))
        return
      case 'table':
        if (top) out.blocks.push({ kind: 'table', startLine: s, endLine: e, source })
        else for (let l = s; l <= e; l++) kind(l, 'code')
        return
      case 'html':
        for (let l = s; l <= e; l++) kind(l, 'html')
        return
      case 'definition':
        style(startOf(n), endOf(n), 'syntax-dim')
        return
      case 'footnoteDefinition':
        for (const c of n.children) block(c, false)
        return
      default:
        return
    }
  }

  for (const n of parse(text).children) block(n, true)
  return out
}

/** Whether a path opens as Markdown (rendered by default). */
export const isMarkdownPath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path)

/** Frontmatter as rows: `key: value` lines become pairs, anything else (lists, nesting) a value. */
export function frontmatterRows(source: string): Array<{ key: string | null; value: string }> {
  const lines = source.split('\n').slice(1, -1)
  return lines
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = /^([A-Za-z0-9_][\w.-]*):[ \t]*(.*)$/.exec(l)
      return m ? { key: m[1] ?? '', value: m[2] ?? '' } : { key: null, value: l }
    })
}
