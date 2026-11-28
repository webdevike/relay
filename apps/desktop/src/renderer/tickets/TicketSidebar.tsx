import { useEffect, useState, type ReactNode } from 'react'
import { Text, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconBox, IconCircleDashed, IconExternalLink } from '@tabler/icons-react'
import type { AgentCard, LinearTicket } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import {
  TERMINAL_TICKET_STATE_TYPES,
  TicketsBoard,
  type TicketDetail,
  type TicketTeam,
} from '@relay/protocol'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { COLUMN_TITLE } from '../agents-board/board-view'
import { PR_ICON, PersonAvatar } from '../agents-board/CardChips'
import type { TicketPr } from '../agents-board/ticket-prs'
import { ApprovalNote } from './ApprovalNote'
import {
  LinearStatus,
  PRIORITY_LABEL,
  PriorityIcon,
  StatusConfirm,
  StatusMenu,
} from './LinearStatus'
import { legacyLinksOf, type TicketData } from './ticket-data'
import { ticketPlace, type TicketRef } from './ticket-place'
import { useTicketMutation, type MutationView } from './use-mutation'

type TeamState = TicketTeam['states'][number]

/** What the sidebar shows: the host's ticket, else the synced card's facts, else the card alone. */
interface SideFacts {
  state: { name: string; color: string } | null
  priority: number | null
  assignee: { name: string; avatarUrl: string | null } | null
  labels: ReadonlyArray<{ name: string; color: string }>
  project: string | null
  milestone: string | null
  related: ReadonlyArray<{ key: string; title: string; kind: string }>
}

const RELATION_WORD: Record<TicketDetail['relations'][number]['kind'], string> = {
  blocks: 'blocks',
  blockedBy: 'blocked by',
  related: 'related',
  duplicate: 'duplicate',
  duplicateOf: 'duplicate of',
  similar: 'similar',
}

function relatedOf(d: TicketDetail): SideFacts['related'] {
  const parent = d.parent ? [{ key: d.parent.key, title: d.parent.title, kind: 'parent' }] : []
  return [...parent, ...d.relations.map((r) => ({ ...r, kind: RELATION_WORD[r.kind] }))]
}

function factsOfDetail(d: TicketDetail): SideFacts {
  return {
    state: d.state,
    priority: d.priority,
    assignee: d.assignee,
    labels: d.labels,
    project: d.project?.name ?? null,
    milestone: d.milestone?.name ?? null,
    related: relatedOf(d),
  }
}

function factsOfCard(t: NonNullable<AgentCard['ticket']>): SideFacts {
  return {
    state: t.state,
    priority: t.priority,
    assignee: t.assignee,
    labels: t.labels,
    project: t.project?.name ?? null,
    milestone: t.milestone?.name ?? null,
    related: t.parent ? [{ key: t.parent.key, title: t.parent.title, kind: 'parent' }] : [],
  }
}

const NO_FACTS: SideFacts = {
  state: null,
  priority: null,
  assignee: null,
  labels: [],
  project: null,
  milestone: null,
  related: [],
}

export function sideFactsOf(detail: TicketDetail | null, card: AgentCard | null): SideFacts {
  if (detail) return factsOfDetail(detail)
  return card?.ticket ? factsOfCard(card.ticket) : NO_FACTS
}

/** The team's workflow states from the host's board, in Linear's order. */
async function teamStates(teamId: string): Promise<TeamState[]> {
  const r = await invoke('tickets.board', {})
  if (!r.ok) throw new Error(r.error.message)
  if (r.value.source !== 'host') throw new Error(r.value.message)
  const team = TicketsBoard.parse(r.value.board).teams?.find((t) => t.id === teamId)
  if (!team) throw new Error('The host hasn’t sent this team’s states yet.')
  return [...team.states].sort((a, b) => a.position - b.position)
}

const VIEW_TOAST: Partial<Record<MutationView['kind'], 'red' | 'yellow'>> = {
  refused: 'red',
  failed: 'red',
  unknown: 'yellow',
}

/** A refusal, failure or lost answer says so once. */
function useMutationToasts(view: MutationView): void {
  useEffect(() => {
    const color = VIEW_TOAST[view.kind]
    if (color && 'message' in view) notifications.show({ color, message: view.message })
  }, [view])
}

/**
 * The status as a picker over the team's states; the pick goes through the host's gate (a move to
 * Done or Canceled asks first). Shown only when the gate is open for this page.
 */
function StatusPicker({
  detail,
  viewerId,
  onDone,
}: {
  detail: TicketDetail
  viewerId: string | null
  onDone: () => void
}) {
  const [opened, setOpened] = useState(false)
  const [states, setStates] = useState<TeamState[] | null>(null)
  const [target, setTarget] = useState<TeamState | null>(null)
  const m = useTicketMutation(viewerId, () => {
    notifications.show({ message: `${detail.key} moved to ${target?.name ?? 'its new status'}.` })
    onDone()
  })
  useMutationToasts(m.view)
  const open = (next: boolean): void => {
    setOpened(next)
    if (!next || states !== null) return
    teamStates(detail.team.id).then(setStates, (e: unknown) => {
      setOpened(false)
      notifications.show({ color: 'red', message: `Couldn't read the statuses: ${String(e)}` })
    })
  }
  const pick = (s: TeamState): void => {
    if (s.id === detail.state.id) return
    setTarget(s)
    const mutation = {
      kind: 'setState' as const,
      issueId: detail.id,
      fromStateId: detail.state.id,
      toStateId: s.id,
    }
    m.run(mutation, { confirm: TERMINAL_TICKET_STATE_TYPES[s.type] })
  }
  const busy = m.view.kind === 'preparing' || m.view.kind === 'committing'
  return (
    <>
      <StatusMenu
        state={detail.state}
        moving={busy && target ? target.name : null}
        states={states}
        opened={opened}
        onOpen={open}
        onPick={pick}
        isCurrent={(s) => s.id === detail.state.id}
        write="gate"
      />
      <StatusConfirm
        opened={m.view.kind === 'confirming'}
        title={`Move ${detail.key} to ${target?.name ?? ''}?`}
        onCancel={m.cancel}
        onConfirm={m.confirm}
      >
        {m.view.kind === 'confirming' ? (
          <ApprovalNote approval={m.view.approval} />
        ) : (
          <Text size="sm">This changes its status in Linear.</Text>
        )}
      </StatusConfirm>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="eva-tk-sect">
      <h3 className="eva-tk-sidh">{title}</h3>
      {children}
    </section>
  )
}

/** The status without a picker: Linear's state when known, else the card's column. */
function StatusLabel({ card, f }: { card: AgentCard | null; f: SideFacts }) {
  const name = f.state?.name ?? (card ? COLUMN_TITLE[card.column] : null)
  if (name === null) return null
  return (
    <div className="eva-tk-prow" data-testid="ticket-status">
      {f.state ? (
        <i className="eva-tk-dot" style={{ background: f.state.color }} aria-hidden />
      ) : null}
      {name}
    </div>
  )
}

/**
 * The status: a picker through the host's gate when it is open, today's Reviews picker when the
 * host can't serve tickets (legacy), else a label.
 */
function StatusRow({ data, card, f }: { data: TicketData; card: AgentCard | null; f: SideFacts }) {
  const d = data.detail
  if (d && data.writeMode === 'gate')
    return <StatusPicker detail={d} viewerId={data.me.linearViewerId} onDone={data.refresh} />
  if (data.writeMode === 'legacy' && data.legacy)
    return <LinearStatus ticket={data.legacy} onChanged={data.refresh} />
  return <StatusLabel card={card} f={f} />
}

function Properties({ data, card, f }: { data: TicketData; card: AgentCard | null; f: SideFacts }) {
  return (
    <Section title="Properties">
      <StatusRow data={data} card={card} f={f} />
      {f.priority !== null ? (
        <div className="eva-tk-prow" data-testid="ticket-priority">
          <PriorityIcon label={PRIORITY_LABEL[f.priority] ?? ''} />
          {PRIORITY_LABEL[f.priority]}
        </div>
      ) : null}
      {f.assignee ? (
        <div className="eva-tk-prow" data-testid="ticket-assignee">
          <PersonAvatar person={f.assignee} size={18} />
          {f.assignee.name}
        </div>
      ) : (
        <div className="eva-tk-prow eva-tk-dim">Unassigned</div>
      )}
    </Section>
  )
}

function Labels({ f }: { f: SideFacts }) {
  return (
    <Section title="Labels">
      {f.labels.length === 0 ? <div className="eva-tk-prow eva-tk-dim">No labels</div> : null}
      {f.labels.map((l) => (
        <div key={l.name} className="eva-tk-prow">
          <i className="eva-tk-dot" style={{ background: l.color }} aria-hidden />
          {l.name}
        </div>
      ))}
    </Section>
  )
}

function Project({ f }: { f: SideFacts }) {
  return (
    <Section title="Project">
      {f.project ? (
        <div className="eva-tk-prow" data-testid="ticket-project">
          <IconBox size={15} stroke={1.5} aria-hidden />
          {f.project}
        </div>
      ) : (
        <div className="eva-tk-prow eva-tk-dim">No project</div>
      )}
      {f.project && f.milestone ? (
        <div className="eva-tk-prow eva-tk-tree" data-testid="ticket-milestone">
          <span className="eva-tk-elbow" aria-hidden />
          <IconCircleDashed size={14} stroke={1.5} className="eva-tk-dim" aria-hidden />
          {f.milestone}
        </div>
      ) : null}
    </Section>
  )
}

function Prs({ at, prs, go }: { at: TicketRef; prs: readonly TicketPr[]; go: (p: Place) => void }) {
  if (prs.length === 0) return null
  return (
    <Section title="Pull requests">
      {prs.map((p) => {
        const Glyph = PR_ICON[p.state ?? 'open']
        return (
          <UnstyledButton
            key={`${p.repo}#${p.number}`}
            className="eva-tk-prow eva-tk-rel"
            data-pr={p.state ?? 'open'}
            onClick={() => go(ticketPlace(at.id, { item: at.kind === 'item', pr: p }))}
            data-testid={`ticket-side-pr-${p.repo.split('/')[1]}-${p.number}`}
          >
            <Glyph size={14} stroke={1.75} className="eva-tk-prglyph" aria-hidden />
            <span className="eva-tk-dim">#{p.number}</span>
            <span className="eva-tk-rel-t">{p.title ?? p.repo}</span>
          </UnstyledButton>
        )
      })}
    </Section>
  )
}

function Related({ f, go }: { f: SideFacts; go: (p: Place) => void }) {
  return (
    <Section title="Related">
      {f.related.length === 0 ? <div className="eva-tk-prow eva-tk-dim">None</div> : null}
      {f.related.map((r) => (
        <UnstyledButton
          key={`${r.kind}:${r.key}`}
          className="eva-tk-prow eva-tk-rel"
          onClick={() => go(ticketPlace(r.key))}
          data-testid={`ticket-related-${r.key}`}
        >
          <IconCircleDashed size={14} stroke={1.5} className="eva-tk-dim" aria-hidden />
          <span className="eva-tk-dim">{r.key}</span>
          <span className="eva-tk-rel-t">{r.title}</span>
          <span className="eva-tk-dim eva-tk-rel-k">{r.kind}</span>
        </UnstyledButton>
      ))}
    </Section>
  )
}

/** What Reviews' Linear read links besides its PRs, as its rail showed: other links, commits. */
function Links({ ticket }: { ticket: LinearTicket }) {
  const { commits, other } = legacyLinksOf(ticket)
  if (commits === 0 && other.length === 0) return null
  return (
    <Section title="Links">
      {other.map((l) => (
        <UnstyledButton
          key={l.url}
          className="eva-tk-prow eva-tk-rel"
          onClick={() => openLink(l.url)}
          title={l.url}
          data-testid="ticket-link"
        >
          <IconExternalLink size={14} stroke={1.5} className="eva-tk-dim" aria-hidden />
          <span className="eva-tk-rel-t">{l.title || l.url}</span>
        </UnstyledButton>
      ))}
      {commits > 0 ? (
        <div className="eva-tk-prow eva-tk-dim" data-testid="ticket-commits">
          {commits} linked {commits === 1 ? 'commit' : 'commits'}
        </div>
      ) : null}
    </Section>
  )
}

/**
 * The properties sidebar after Linear's: status (a picker through the host's gate when writes are
 * open, today's Reviews picker without host sync), priority, assignee, labels, project and
 * milestone, the pull requests (each opens its page), the legacy read's other links and commits,
 * and related tickets. Without Linear details it shows the card's own facts.
 */
export function TicketSidebar({
  at,
  data,
  card,
  prs,
  go,
}: {
  at: TicketRef
  data: TicketData
  card: AgentCard | null
  prs: readonly TicketPr[]
  go: (place: Place) => void
}) {
  const f = sideFactsOf(data.detail, card)
  return (
    <aside className="eva-tk-side" data-testid="ticket-sidebar" aria-label="Properties">
      <Properties data={data} card={card} f={f} />
      {at.kind === 'key' ? <Labels f={f} /> : null}
      {at.kind === 'key' ? <Project f={f} /> : null}
      <Prs at={at} prs={prs} go={go} />
      {data.legacy ? <Links ticket={data.legacy} /> : null}
      {at.kind === 'key' ? <Related f={f} go={go} /> : null}
    </aside>
  )
}
