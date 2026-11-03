import { useState, type ReactNode } from 'react'
import { Button } from '@mantine/core'
import { IconCircleCheck, IconCircleDot, IconCircleX } from '@tabler/icons-react'
import type { Proposal } from '@evaos/contract'
import { ListPill, ListRow } from '../ui/list'
import { acceptProposal, dismissProposal, loadMeeting, loadMeetings } from './meetings-store'

export interface ProposalRowProps {
  stem: string
  meetingTitle: string
  proposal: Proposal
  /** Overrides the default Accept and Dismiss buttons. */
  actions?: ReactNode
  /** Resolved proposals render dim with a status pill. */
  dim?: boolean
}

type Pending = 'accept' | 'dismiss' | null

/** One proposal as a list row: what to do, from which meeting, and Accept or Dismiss. */
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
  const resolved = dim && proposal.status !== 'proposed'
  const Glyph = !resolved
    ? IconCircleDot
    : proposal.status === 'accepted'
      ? IconCircleCheck
      : IconCircleX

  return (
    <>
      <ListRow
        data-testid={`proposal-${id}`}
        data-stem={stem}
        dim={dim}
        multiline
        leading={<Glyph size={16} stroke={1.5} aria-hidden />}
        title={proposal.text}
        meta={
          meetingTitle !== '' || proposal.source ? (
            <>
              {meetingTitle !== '' ? <span>{meetingTitle}</span> : null}
              {meetingTitle !== '' && proposal.source ? ' · ' : null}
              {proposal.source ? <span>From {proposal.source}</span> : null}
            </>
          ) : undefined
        }
        trailing={
          resolved ? (
            <ListPill
              tone={proposal.status === 'accepted' ? 'ok' : 'dim'}
              data-testid={`proposal-status-${id}`}
            >
              {proposal.status === 'accepted' ? 'Accepted' : 'Dismissed'}
            </ListPill>
          ) : (
            (actions ?? defaultActions)
          )
        }
      />
      {refusal !== null ? (
        <div className="eva-mt-refusal" role="alert" data-testid={`meeting-refusal-${id}`}>
          <span>{refusal}</span>
          <Button size="xs" variant="default" data-testid={`meeting-reload-${id}`} onClick={reload}>
            Reload
          </Button>
        </div>
      ) : null}
    </>
  )
}
