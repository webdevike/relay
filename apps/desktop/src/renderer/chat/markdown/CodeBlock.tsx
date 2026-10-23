import { useEffect, useMemo, useState } from 'react'
import { Tooltip } from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import hljs from 'highlight.js/lib/common'

/** How long the copy button says "Copied" (rich.rs COPIED_FOR). */
const COPIED_MS = 1500

/** Highlighted HTML for a language highlight.js knows; null leaves the code as plain text. */
export function highlight(lang: string, code: string): string | null {
  const name = lang.toLowerCase()
  if (!name || !hljs.getLanguage(name)) return null
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

/**
 * A fenced code block (rich.rs code_frame): a hairline frame with a header row holding the
 * language (or `title`) and a copy button, over the highlighted code on the message's own
 * surface. `invalid` marks a closed ```ui block that failed validation: the header says so in the
 * warning color instead of passing as ordinary code.
 */
export function CodeBlock({
  lang,
  code,
  title,
  invalid = false,
}: {
  lang: string
  code: string
  title?: string | undefined
  invalid?: boolean
}) {
  const html = useMemo(() => highlight(lang, code), [lang, code])
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="eva-codeblock" data-testid="code-block">
      <div className="eva-codeblock-head">
        <span className="eva-codeblock-lang" data-invalid={invalid || undefined}>
          {invalid ? "Widget couldn't render" : title || lang || 'text'}
        </span>
        <Tooltip label="Copy code" position="top">
          <button
            type="button"
            className="eva-codeblock-copy"
            aria-label="Copy code"
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => setCopied(true))
            }}
          >
            {copied ? <IconCheck size={14} stroke={1.75} /> : <IconCopy size={14} stroke={1.75} />}
            {copied ? <span>Copied</span> : null}
          </button>
        </Tooltip>
      </div>
      {html === null ? (
        <pre className="eva-codeblock-body">
          <code>{code}</code>
        </pre>
      ) : (
        <pre className="eva-codeblock-body">
          {/* highlight.js escapes the source; only its own span markup is HTML. */}
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      )}
    </div>
  )
}
