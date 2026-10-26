import './markdown.css'
import { createContext, memo, useContext, useMemo, type MouseEvent } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'
import { openLink } from '../../navigation/open-link'
import { OpenUIBlock, WidgetBlock } from '../widgets/Widget'
import { WidgetFrame, WidgetFramePending } from '../widgets/WidgetFrame'
import { mediaUrl } from '../widgets/media-url'

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

/**
 * Whether a fenced block has its closing fence (rich.rs segments). An unclosed fence runs to the
 * end of the reply, so a ```ui or ```openui block still streaming has none yet.
 */
export function fenceClosed(pre: Element | undefined, source: string): boolean {
  const start = pre?.position?.start.offset
  const end = pre?.position?.end.offset
  if (start === undefined || end === undefined) return false
  // Blockquote and list markers sit before the fence on each line.
  const lines = source
    .slice(start, end)
    .split('\n')
    .map((line) => line.replace(/^[\s>]*/, '').trimEnd())
  const open = /^(`{3,}|~{3,})/.exec(lines[0] ?? '')?.[1]
  const close = lines.length > 1 ? lines[lines.length - 1]! : ''
  return (
    open !== undefined && close.length >= open.length && close === open[0]!.repeat(close.length)
  )
}

/** The markdown the reply was parsed from, so a fence can tell whether it is closed. */
const SourceContext = createContext('')

function Pre({ node }: ExtraProps) {
  const source = useContext(SourceContext)
  const { lang, code } = fenceOf(node)
  if (lang === 'ui') {
    // A ui block still streaming is unfinished, not invalid: it shows as plain JSON until closed.
    return fenceClosed(node, source) ? (
      <WidgetBlock json={code} />
    ) : (
      <CodeBlock lang="json" code={code} />
    )
  }
  // OpenUI Lang parses as a stream prefix, so an unclosed openui block renders live. The fence's
  // offset stays put while the reply streams, so it names the block's runtime within the message.
  if (lang === 'openui')
    return (
      <OpenUIBlock
        code={code}
        closed={fenceClosed(node, source)}
        at={node?.position?.start.offset}
      />
    )
  // An agent-made page draws only once its fence closes: a half-written page is not the widget.
  if (lang === 'html-widget' || lang === 'mantine-widget')
    return fenceClosed(node, source) ? (
      <WidgetFrame runtime={lang === 'mantine-widget' ? 'mantine' : 'html'} code={code} />
    ) : (
      <WidgetFramePending />
    )
  return <CodeBlock lang={lang} code={code} />
}

const components: Components = {
  pre: Pre,
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
  // Drops, http(s) URLs and local files all load through main's relay-media protocol, like widgets.
  img: ({ src, alt }) =>
    typeof src === 'string' && src !== '' ? (
      <img src={mediaUrl(src)} alt={alt ?? ''} draggable={false} />
    ) : null,
}

const PLUGINS = [remarkGfm]

/** An assistant reply: GitHub-flavored markdown, never raw HTML. */
function MarkdownImpl({ text }: { text: string }) {
  const source = useMemo(() => replyMarkdown(text), [text])
  return (
    <div className="eva-md">
      <SourceContext.Provider value={source}>
        <ReactMarkdown remarkPlugins={PLUGINS} components={components} skipHtml>
          {source}
        </ReactMarkdown>
      </SourceContext.Provider>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
