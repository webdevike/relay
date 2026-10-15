import { memo, useState } from 'react'
import { Collapse } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'
import type { ChatMessage } from '@evaos/chat-core/message'

export type Segment = { kind: 'text' | 'code'; text: string }

/** Splits assistant text into prose and fenced code. An unterminated fence runs to the end. */
export function splitFences(text: string): Segment[] {
  const out: Segment[] = []
  let buf: string[] = []
  let inFence = false
  const flush = (kind: Segment['kind']): void => {
    if (buf.length > 0 || kind === 'code') out.push({ kind, text: buf.join('\n') })
    buf = []
  }
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (inFence) {
        flush('code')
        inFence = false
      } else {
        flush('text')
        inFence = true
      }
      continue
    }
    buf.push(line)
  }
  flush(inFence ? 'code' : 'text')
  return out.filter((s) => s.kind === 'code' || s.text.trim() !== '')
}

function Chevron({ open }: { open: boolean }) {
  return <IconChevronRight size={14} className="eva-chevron" data-open={open} aria-hidden />
}

function ThinkingRow({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="eva-row-thinking">
      <button
        type="button"
        className="eva-row-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Chevron open={open} />
        <span className="eva-label eva-dim">Thinking</span>
      </button>
      <Collapse expanded={open} transitionDuration={150}>
        {open ? <div className="eva-thinking-text">{m.text}</div> : null}
      </Collapse>
    </div>
  )
}

function ToolRow({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const tool = m.tool
  return (
    <div className="eva-row-tool">
      <button
        type="button"
        className="eva-row-toggle eva-tool-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Chevron open={open} />
        <span className="eva-label eva-mono">{m.text}</span>
        {m.detail ? <span className="eva-label eva-dim eva-tool-detail">{m.detail}</span> : null}
        <span className="eva-label eva-dim eva-tool-status">{tool?.status ?? 'done'}</span>
      </button>
      <Collapse expanded={open} transitionDuration={150}>
        {open ? (
          <div className="eva-tool-body">
            {tool?.input ? <pre className="eva-pre">{tool.input}</pre> : null}
            {tool?.result ? <pre className="eva-pre">{tool.result}</pre> : null}
          </div>
        ) : null}
      </Collapse>
    </div>
  )
}

function MessageRowImpl({ m }: { m: ChatMessage }) {
  let body
  if (m.role === 'user') {
    body = (
      <div className="eva-turn-user">
        <div className="eva-bubble">{m.text}</div>
      </div>
    )
  } else if (m.role === 'assistant') {
    body = (
      <div className="eva-assistant">
        {splitFences(m.text).map((seg, i) =>
          seg.kind === 'code' ? (
            <pre key={i} className="eva-code">
              {seg.text}
            </pre>
          ) : (
            <div key={i} className="eva-prose">
              {seg.text}
            </div>
          ),
        )}
      </div>
    )
  } else if (m.role === 'thinking') {
    body = <ThinkingRow m={m} />
  } else if (m.role === 'tool') {
    body = <ToolRow m={m} />
  } else {
    body = <div className="eva-label eva-dim">{m.text}</div>
  }
  return (
    <div className="eva-row" data-testid={`msg-${m.id}`} data-role={m.role}>
      <div className="eva-row-inner">{body}</div>
    </div>
  )
}

export const MessageRow = memo(MessageRowImpl)
