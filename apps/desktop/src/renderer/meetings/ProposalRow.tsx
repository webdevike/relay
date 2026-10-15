import type { ReactNode } from 'react'
import type { Proposal } from '@evaos/contract'

export interface ProposalRowProps {
  stem: string
  meetingTitle: string
  proposal: Proposal
  /** Accept and Dismiss buttons arrive in 03-18. */
  actions?: ReactNode
  /** Resolved proposals render dim with a status badge. */
  dim?: boolean
}

/** One proposal. All text is rendered as React text only. */
export function ProposalRow({ stem, meetingTitle, proposal, actions, dim }: ProposalRowProps) {
  return (
    <div
      className="eva-mt-proposal"
      data-testid={`proposal-${proposal.id}`}
      data-stem={stem}
      data-dim={dim ? 'true' : undefined}
    >
      <div className="eva-mt-proposal-main">
        {meetingTitle !== '' ? <span className="eva-mt-label">{meetingTitle}</span> : null}
        <span className="eva-mt-proposal-text">{proposal.text}</span>
        {proposal.source ? <span className="eva-mt-label">From {proposal.source}</span> : null}
      </div>
      {dim && proposal.status !== 'proposed' ? (
        <span className="eva-mt-badge" data-testid={`proposal-status-${proposal.id}`}>
          {proposal.status === 'accepted' ? 'Accepted' : 'Dismissed'}
        </span>
      ) : null}
      {actions ? <div className="eva-mt-proposal-actions">{actions}</div> : null}
    </div>
  )
}
