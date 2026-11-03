import { useState, type ReactNode } from 'react'
import { Button } from '@mantine/core'
import type { Proposal } from '@evaos/contract'
import { acceptProposal, dismissProposal, loadMeeting, loadMeetings } from './meetings-store'

export interface ProposalRowProps {
  stem: string
  meetingTitle: string
  proposal: Proposal
  /** Overrides the default Accept and Dismiss buttons. */
  actions?: ReactNode
  /** Resolved proposals render dim with a status badge. */
  dim?: boolean
}

type Pending = 'accept' | 'dismiss' | null

/** One proposal. All text is rendered as React text only. */
export function ProposalRow({ stem, meetingTitle, proposal, actions, dim }: ProposalRowProps) {
  const [pending, setPending] = useState<Pending>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const id = proposal.id
  const actionable = !dim && proposal.status === 'proposed'

  const run = async (kind: 'accept' | 'dismiss'): Promise<void> => {
    if (pending !== null) return
    setPending(kind)
    setRefusal(null)
    const r = await (kind === 'accept' ? acceptProposal(stem, id) : dismissProposal(stem, id))
    setPending(null)
    if (r.ok) return
    if (r.code === 'partial-accept') setRefusal(r.message)
    else if (r.code === 'not-proposed' || r.code === 'changed-on-disk' || r.code === 'not-found') {
      setRefusal(`work/meetings/${stem}.json changed on disk. Reload the meeting and try again.`)
    } else setRefusal(r.message)
  }

  const reload = (): void => {
    setRefusal(null)
    void Promise.all([loadMeeting(stem), loadMeetings()])
  }

  const defaultActions = actionable ? (
    <>
      <Button
        size="xs"
        data-testid={`meeting-accept-${id}`}
        disabled={pending !== null}
        loading={pending === 'accept'}
        onClick={() => void run('accept')}
      >
        Accept todo
      </Button>
      <Button
        size="xs"
        variant="default"
        data-testid={`meeting-dismiss-${id}`}
        disabled={pending !== null}
        loading={pending === 'dismiss'}
        onClick={() => void run('dismiss')}
      >
        Dismiss proposal
      </Button>
    </>
  ) : null
  const shown = actions ?? defaultActions

  return (
    <div
      className="eva-mt-proposal"
      data-testid={`proposal-${id}`}
      data-stem={stem}
      data-dim={dim ? 'true' : undefined}
    >
      <div className="eva-mt-proposal-main">
        {meetingTitle !== '' ? <span className="eva-mt-label">{meetingTitle}</span> : null}
        <span className="eva-mt-proposal-text">{proposal.text}</span>
        {proposal.source ? <span className="eva-mt-label">From {proposal.source}</span> : null}
      </div>
      {dim && proposal.status !== 'proposed' ? (
        <span className="eva-mt-badge" data-testid={`proposal-status-${id}`}>
          {proposal.status === 'accepted' ? 'Accepted' : 'Dismissed'}
        </span>
      ) : null}
      {shown ? <div className="eva-mt-proposal-actions">{shown}</div> : null}
      {refusal !== null ? (
        <div className="eva-mt-refusal" role="alert" data-testid={`meeting-refusal-${id}`}>
          <span>{refusal}</span>
          <Button size="xs" variant="default" data-testid={`meeting-reload-${id}`} onClick={reload}>
            Reload
          </Button>
        </div>
      ) : null}
    </div>
  )
}
