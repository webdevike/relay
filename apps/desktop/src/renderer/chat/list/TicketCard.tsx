import { useEffect, useState } from 'react'
import { Badge } from '@mantine/core'
import { IconFolder, IconUser } from '@tabler/icons-react'
import type { ChatRow, LinearIssue } from '@evaos/contract'
import { isTicket, keysIn } from '@evaos/chat-core/work'
import { invoke } from '../../ipc'
import { stateTone } from '../widgets/rich/TicketsWidget'
import { useToneColor } from '../widgets/rich/parts'
import { age } from './look'

/** The Linear ticket a chat is about: its work item's key when that is a ticket, else the title's. */
export function ticketOf(row: Pick<ChatRow, 'title' | 'work'>): string | null {
  const key = row.work?.key ?? null
  if (key !== null && isTicket(key)) return key
  return keysIn(row.title)[0] ?? null
}

type Loaded =
  | { state: 'loading' }
  | { state: 'ok'; issue: LinearIssue | null }
  | { state: 'error'; message: string }

/** Fetches `key` from Linear once the card opens (main caches it for a couple of minutes). */
function useIssue(key: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  useEffect(() => {
    let live = true
    setLoaded({ state: 'loading' })
    void invoke('linear.issue', { key }).then((r) => {
      if (!live) return
      setLoaded(r.ok ? { state: 'ok', issue: r.value } : { state: 'error', message: r.error.message })
    })
    return () => {
      live = false
    }
  }, [key])
  return loaded
}

/** The ticket badge's hover card: key, state, title, assignee, project and last update. */
export function TicketCard({ ticket }: { ticket: string }) {
  const loaded = useIssue(ticket)
  const toneColor = useToneColor()
  const line = (icon: React.ReactNode, text: string) => (
    <div className="eva-cl-card-line">
      <span className="eva-cl-card-icon">{icon}</span>
      <span className="eva-cl-card-text">{text}</span>
    </div>
  )
  if (loaded.state !== 'ok' || loaded.issue === null) {
    const note =
      loaded.state === 'loading'
        ? 'Loading…'
        : loaded.state === 'error'
          ? loaded.message
          : 'Not found in Linear'
    return (
      <div className="eva-cl-card" data-testid="ticket-card">
        <div className="eva-cl-card-title">{ticket}</div>
        <div className="eva-cl-card-lines">{note}</div>
      </div>
    )
  }
  const issue = loaded.issue
  const ago = age(issue.updatedAt, Date.now())
  return (
    <div className="eva-cl-card" data-testid="ticket-card">
      <div className="eva-cl-ticket-head">
        <span>{issue.identifier}</span>
        <Badge
          size="xs"
          variant="light"
          radius="sm"
          tt="none"
          color={toneColor(stateTone(issue.stateType as Parameters<typeof stateTone>[0]))}
        >
          {issue.state}
        </Badge>
        <span>{issue.priority}</span>
      </div>
      <div className="eva-cl-card-title">{issue.title}</div>
      <div className="eva-cl-card-lines">
        {line(<IconUser size={12} stroke={1.75} />, issue.assignee ?? 'Unassigned')}
        {issue.project !== null ? line(<IconFolder size={12} stroke={1.75} />, issue.project) : null}
        <span>{ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`}</span>
      </div>
    </div>
  )
}
