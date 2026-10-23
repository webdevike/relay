import './markdown.css'
import { memo, type MouseEvent } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'
import { openLink } from '../../navigation/open-link'

type Element = NonNullable<ExtraProps['node']>
type ElementContent = Element['children'][number]

/**
 * Port of rich.rs reply_markdown: Eva writes one sentence per line and markdown would run those
 * together, so a single line break between plain lines (not lists, tables, headings or quotes)
 * becomes a hard break.
 */
export function replyMarkdown(text: string): string {
  const lines = text.split('\n')
  let out = ''
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```')) fenced = !fenced
    out += line
    const next = lines[i + 1]?.trimStart()
    const nextPlain =
      next !== undefined && next !== '' && !/^[-*|#>`]/.test(next) && !/^\d/.test(next)
    const thisPlain = !fenced && trimmed !== '' && !/^[|#`]/.test(trimmed)
    if (thisPlain && nextPlain) out += '  '
    if (i < lines.length - 1) out += '\n'
  }
  return out
}

function textOf(nodes: ElementContent[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += n.value
    else if (n.type === 'element') out += textOf(n.children)
  }
  return out
}

/** A fenced block's language and source, from the `<pre><code class="language-x">` it became. */
function fenceOf(pre: Element | undefined): { lang: string; code: string } {
  const code = pre?.children.find((c): c is Element => c.type === 'element')
  const cls = code?.properties['className']
  const first = Array.isArray(cls) ? String(cls[0] ?? '') : ''
  return {
    lang: first.startsWith('language-') ? first.slice('language-'.length) : '',
    code: textOf(code?.children ?? []).replace(/\n$/, ''),
  }
}

const components: Components = {
  pre: ({ node }) => {
    const { lang, code } = fenceOf(node)
    return <CodeBlock lang={lang} code={code} />
  },
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e: MouseEvent) => {
        e.preventDefault()
        if (href) openLink(href)
      }}
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="eva-md-table">
      <table>{children}</table>
    </div>
  ),
}

const PLUGINS = [remarkGfm]

/** An assistant reply: GitHub-flavored markdown, never raw HTML. */
function MarkdownImpl({ text }: { text: string }) {
  return (
    <div className="eva-md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components} skipHtml>
        {replyMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
