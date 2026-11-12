import { useState } from 'react'
import { UnstyledButton } from '@mantine/core'
import { IconChevronRight, IconPointer } from '@tabler/icons-react'
import type { DesignRequestSummary } from './design-request'
import './design.css'

/**
 * A sent Design Mode request in the chat: the change, the elements and the style edits; the full
 * prompt the agent read (selectors, DOM, styles) opens under Details.
 */
export function DesignRequestText({
  summary,
  raw,
}: {
  summary: DesignRequestSummary
  raw: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="eva-design-request" data-testid="design-request">
      <div className="eva-design-request-head">
        <IconPointer size={14} />
        Design request
      </div>
      {summary.change ? <div className="eva-design-request-change">{summary.change}</div> : null}
      <ol className="eva-design-request-list">
        {summary.elements.map((e, i) => (
          <li key={i}>
            <code>{e.label}</code>
            {e.source ? <span className="eva-design-request-dim"> {e.source}</span> : null}
          </li>
        ))}
        {summary.edits.map((e, i) => (
          <li key={`edit-${i}`} className="eva-design-request-dim">
            {e}
          </li>
        ))}
      </ol>
      <UnstyledButton
        className="eva-design-request-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronRight size={12} data-open={open || undefined} />
        Details
      </UnstyledButton>
      {open ? <pre className="eva-design-request-raw">{raw}</pre> : null}
    </div>
  )
}
