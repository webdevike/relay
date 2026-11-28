// What hangs off the ticket besides Linear: who works on it (column, pill, agent, why), the
// agent's session, its ledger and worktree, the hand-off to Astra (asked first), and the pull
// requests (each opens its page). Every link the board's side panel had lives here.
import { useState } from 'react'
import { Button, Group, Textarea, Tooltip, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconMessageCircle,
  IconSend,
} from '@tabler/icons-react'
import type { AgentCard, AgentLink } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openTargetOf } from '../navigation/open-target'
import { EvaModal } from '../overlay'
import { ListPill } from '../ui/list'
import { agoPhrase } from '../reviews/review-model'
import { fail } from '../reviews/review-ui'
import { COLUMN_ICON, PILL_TONE, PR_ICON } from '../agents-board/CardChips'
import { COLUMN_TITLE } from '../agents-board/board-view'
import { openAgentLink } from '../agents-board/agent-link'
import type { TicketPr } from '../agents-board/ticket-prs'
import { ticketPlace, type TicketRef } from './ticket-place'

const VIA_WORDS: Record<TicketPr['via'], string> = {
  linear: 'linked in Linear',
  agent: "the agent's PR",
  branch: 'branch names the ticket',
  title: 'title names the ticket',
}

/** Hands the ticket to Astra after Isaac confirms, with an optional note. */
function SendToAstra({ card, url }: { card: AgentCard & { key: string }; url: string }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (): Promise<void> => {
    setBusy(true)
    const r = await invoke('reviews.sendTicket', {
      key: card.key,
      title: card.title,
      url,
      note: note.trim(),
    })
    setBusy(false)
    if (!r.ok) return fail("Couldn't reach Astra", r.error.message)
    setOpen(false)
    setNote('')
    notifications.show(
      r.value.status === 'sent'
        ? { message: `Sent ${card.key} to Astra.`, color: 'green' }
        : { message: `Test instance, not sent: ${r.value.command}`, color: 'gray' },
    )
  }
  return (
    <>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconSend size={14} />}
        onClick={() => setOpen(true)}
        data-testid="ticket-send"
      >
        Send to Astra
      </Button>
      <EvaModal
        opened={open}
        onClose={() => setOpen(false)}
        title={`Send ${card.key} to Astra?`}
        size={480}
        testid="ticket-send-modal"
      >
        <div className="eva-tk-dim">
          Astra starts work on it, or hands it to its auto-work session when one is live.
        </div>
        <Textarea
          mt="sm"
          autosize
          minRows={2}
          placeholder="Anything she should know (optional)"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          data-testid="ticket-send-note"
        />
        <Group justify="flex-end" gap="xs" mt="md">
          <Button variant="default" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void send()} data-testid="ticket-send-confirm">
            Send
          </Button>
        </Group>
      </EvaModal>
    </>
  )
}

/** Who works on the card: its column, pill and agent, why it sits there, and the hand-off. */
function AgentRow({ card, linearUrl }: { card: AgentCard; linearUrl: string | null }) {
  const Column = COLUMN_ICON[card.column]
  const key = card.key
  return (
    <div className="eva-tk-agent" data-testid="ticket-agent">
      <div className="eva-tk-agentrow">
        <span className="eva-tk-column" data-column={card.column}>
          <Column size={15} stroke={1.75} aria-hidden />
          {COLUMN_TITLE[card.column]}
        </span>
        <ListPill tone={PILL_TONE[card.pill.tone]}>{card.pill.label}</ListPill>
        {card.agent ? <span className="eva-tk-dim">{card.agent}</span> : null}
        <span className="eva-tk-spacer" />
        {key !== null && linearUrl !== null ? (
          <SendToAstra card={{ ...card, key }} url={linearUrl} />
        ) : null}
      </div>
      {card.reason ? (
        <p className="eva-tk-reason" data-testid="ticket-reason">
          {card.reason}
        </p>
      ) : null}
    </div>
  )
}

function SessionRow({ card, link, now }: { card: AgentCard; link: AgentLink; now: number }) {
  const running = card.column === 'working'
  const sub = card.intent ?? link.sub ?? 'No status yet'
  return (
    <UnstyledButton
      className="eva-tk-resrow"
      data-running={running || undefined}
      onClick={(e) => openAgentLink(link.open, openTargetOf(e))}
      data-testid="ticket-session"
    >
      <IconMessageCircle size={15} stroke={1.5} className="eva-tk-dim" aria-hidden />
      <span className="eva-tk-res-t">
        {running ? <span className="eva-tk-live" aria-label="Running" /> : null}
        {link.label}
        <span className="eva-tk-dim"> {sub}</span>
      </span>
      <span className="eva-tk-dim">
        {card.activityAt !== null ? agoPhrase(card.activityAt, now) : 'Open session'}
      </span>
    </UnstyledButton>
  )
}

function FileRow({ link }: { link: AgentLink }) {
  const Glyph = link.kind === 'ledger' ? IconFileText : IconFolder
  const what = link.kind === 'ledger' ? 'Work item' : 'Worktree'
  return (
    <UnstyledButton
      className="eva-tk-resrow"
      onClick={(e) => openAgentLink(link.open, openTargetOf(e))}
      data-testid={`ticket-link-${link.kind}`}
    >
      <Glyph size={15} stroke={1.5} className="eva-tk-dim" aria-hidden />
      <span className="eva-tk-res-t">{link.label}</span>
      <span className="eva-tk-dim">{what}</span>
    </UnstyledButton>
  )
}

function PrRow({ at, pr, go }: { at: TicketRef; pr: TicketPr; go: (p: Place) => void }) {
  const Glyph = PR_ICON[pr.state ?? 'open']
  const id = `${pr.repo.split('/')[1]}#${pr.number}`
  return (
    <Tooltip label={VIA_WORDS[pr.via]} openDelay={400}>
      <UnstyledButton
        className="eva-tk-resrow"
        data-pr={pr.state ?? 'open'}
        onClick={() => go(ticketPlace(at.id, { item: at.kind === 'item', pr }))}
        data-testid={`ticket-pr-${pr.repo.split('/')[1]}-${pr.number}`}
      >
        <Glyph size={15} stroke={1.5} className="eva-tk-prglyph" aria-hidden />
        <span className="eva-tk-res-t">{pr.title ? `${pr.title} · ${id}` : id}</span>
        <span className="eva-tk-dim">{pr.state ?? 'open'}</span>
      </UnstyledButton>
    </Tooltip>
  )
}
/** The card's own rows: who works on it, its session, its ledger and worktree. */
function CardRows({
  card,
  linearUrl,
  now,
}: {
  card: AgentCard
  linearUrl: string | null
  now: number
}) {
  const session = card.links.find((l) => l.kind === 'session')
  const files = card.links.filter((l) => l.kind === 'ledger' || l.kind === 'worktree')
  return (
    <>
      <AgentRow card={card} linearUrl={linearUrl} />
      {session ? <SessionRow card={card} link={session} now={now} /> : null}
      {files.map((l) => (
        <FileRow key={`${l.kind}:${l.label}`} link={l} />
      ))}
    </>
  )
}

export function Resources({
  at,
  card,
  prs,
  linearUrl,
  now,
  go,
}: {
  at: TicketRef
  card: AgentCard | null
  prs: readonly TicketPr[]
  /** The ticket's Linear link: it goes to Astra only with one. */
  linearUrl: string | null
  now: number
  go: (place: Place) => void
}) {
  const [open, setOpen] = useState(true)
  const Toggle = open ? IconChevronDown : IconChevronRight
  return (
    <section className="eva-tk-res" data-testid="ticket-resources">
      <UnstyledButton
        className="eva-tk-reshead"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="ticket-resources-toggle"
      >
        <Toggle size={14} stroke={1.75} aria-hidden />
        Resources
      </UnstyledButton>
      {open ? (
        <div className="eva-tk-resrows">
          {card ? (
            <CardRows card={card} linearUrl={at.kind === 'key' ? linearUrl : null} now={now} />
          ) : null}
          {prs.map((p) => (
            <PrRow key={`${p.repo}#${p.number}`} at={at} pr={p} go={go} />
          ))}
          {card === null && prs.length === 0 ? (
            <div className="eva-tk-dim eva-tk-resrow">No resources yet.</div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
