// New issue from a comment (PLAN T2.5): the modal is the confirm. Title and description are
// prefilled and editable; team and project are the source ticket's, the state is the team's
// `Todo` (exact name; otherwise Isaac picks). One `createIssue` write (`id: opId`), linked to the
// comment by `sourceCommentId` and `referenceCommentId`.
import { useEffect, useState } from 'react'
import { Button, Select, TextInput, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  TicketsBoard,
  type TicketComment,
  type TicketDetail,
  type TicketOutcome,
} from '@relay/protocol'
import { invoke } from '../ipc'
import { EvaModal } from '../overlay'
import { issueTitleOf, todoState } from './activity-model'
import { MutationNotice } from './Composer'
import { useTicketMutation } from './use-mutation'

/** Linear's template Isaac's eng issues start from, looked up by this exact name. */
export const ISSUE_TEMPLATE = 'Default Eng Template'

type States = { id: string; name: string }[]

/** The team's workflow states from the host's board, in Linear's order; a string says why not. */
function useTeamStates(teamId: string, opened: boolean): States | string | null {
  const [states, setStates] = useState<States | string | null>(null)
  useEffect(() => {
    if (!opened) return
    let live = true
    void invoke('tickets.board', {}).then((r) => {
      if (!live) return
      if (!r.ok) return setStates(r.error.message)
      if (r.value.source !== 'host') return setStates(r.value.message)
      const team = TicketsBoard.parse(r.value.board).teams?.find((t) => t.id === teamId)
      setStates(
        team
          ? [...team.states].sort((a, b) => a.position - b.position)
          : 'The host hasn’t sent this team’s states yet.',
      )
    })
    return () => {
      live = false
    }
  }, [teamId, opened])
  return states
}

export function NewIssueModal({
  comment,
  detail,
  onClose,
  onCreated,
}: {
  /** The comment it comes from; null: closed. */
  comment: TicketComment | null
  detail: TicketDetail
  onClose: () => void
  onCreated: (outcome: TicketOutcome) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [stateId, setStateId] = useState<string | null>(null)
  const states = useTeamStates(detail.team.id, comment !== null)
  const write = useTicketMutation((o) => {
    onCreated(o)
    onClose()
  })
  useEffect(() => {
    if (!comment) return
    setTitle(issueTitleOf(comment.body))
    setBody(comment.body)
    setStateId(null)
  }, [comment])
  useEffect(() => {
    if (Array.isArray(states)) setStateId((s) => s ?? todoState(states)?.id ?? null)
  }, [states])
  // This modal is the confirm: once the gate approves the exact issue, it is written.
  const { view, confirm } = write
  useEffect(() => {
    if (view.kind === 'confirming') confirm()
  }, [view.kind, confirm])

  const create = (): void => {
    if (!comment || !stateId || !title.trim()) return
    write.run({
      kind: 'createIssue',
      teamId: detail.team.id,
      stateId,
      templateId: null,
      projectId: detail.project?.id ?? null,
      title: title.trim(),
      description: body,
      sourceCommentId: comment.id,
      referenceCommentId: comment.id,
    })
  }
  const close = (): void => {
    write.cancel()
    onClose()
  }
  const busy = view.kind === 'preparing' || view.kind === 'committing' || view.kind === 'confirming'
  const options = Array.isArray(states) ? states.map((s) => ({ value: s.id, label: s.name })) : []
  return (
    <EvaModal opened={comment !== null} onClose={close} title="New issue from comment" size={520}>
      <div className="eva-tk-newissue" data-testid="new-issue-modal">
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          data-testid="new-issue-title"
        />
        <Textarea
          label="Description"
          autosize
          minRows={3}
          maxRows={12}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          data-testid="new-issue-body"
        />
        <Select
          label="Status"
          data={options}
          value={stateId}
          onChange={setStateId}
          placeholder={typeof states === 'string' ? states : 'Pick a status'}
          disabled={!Array.isArray(states)}
          comboboxProps={{ withinPortal: false }}
          data-testid="new-issue-state"
        />
        <div className="eva-rv-dim eva-rv-small" data-testid="new-issue-facts">
          {`In ${detail.team.key}${detail.project ? `, project ${detail.project.name}` : ''}, linked to this comment. `}
          {`${ISSUE_TEMPLATE} isn’t applied: the host doesn’t list Linear templates yet.`}
        </div>
        <MutationNotice view={view} onRetry={write.retry} onDismiss={write.cancel} />
        <div className="eva-rv-modal-actions">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!stateId || !title.trim()}
            onClick={create}
            data-testid="new-issue-create"
          >
            Create issue
          </Button>
        </div>
      </div>
    </EvaModal>
  )
}

/** The created issue, said once. */
export function notifyCreated(o: TicketOutcome): void {
  notifications.show({
    message: o.result?.key ? `Created ${o.result.key}.` : 'Issue created.',
    color: 'green',
  })
}
