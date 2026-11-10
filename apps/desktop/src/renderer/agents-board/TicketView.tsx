// The combined ticket view in the Agents board's side panel: what the agents are doing on it, the
// Linear ticket (status, assignee, priority, description, comments) and one tab per linked pull
// request (Conversation with its reviews and comments, Files, Checks, Guide), each the Reviews
// page's own view. Writes stay explicit: comments and reviews confirm their text first, a status
// moves on a pick, a ticket goes to Astra only from the Send dialog.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Textarea, Tooltip, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconExternalLink,
  IconFileText,
  IconFolder,
  IconLayoutSidebarRightCollapse,
  IconMessageCircle,
  IconSend,
  IconX,
} from '@tabler/icons-react'
import type { AgentCard, LinearTicket, ReviewPr, ReviewPrHit } from '@evaos/contract'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { openTargetOf } from '../navigation/open-target'
import { EvaModal } from '../overlay'
import { ListPill } from '../ui/list'
import { Detail } from '../reviews/ReviewsPage'
import { LinearDetail } from '../reviews/LinearDetail'
import { reviewItemOf } from '../reviews/reviews-store'
import { fail } from '../reviews/review-ui'
import { clockLabel } from '../context/format'
import { COLUMN_ICON, PILL_TONE, PR_ICON } from './AgentCard'
import { COLUMN_TITLE } from './board-view'
import { openAgentLink } from './agent-link'
import { ticketPrs, type TicketPr } from './ticket-prs'

const LINEAR_KEY = /^[A-Z][A-Z0-9]*-\d+$/

const VIA_WORDS: Record<TicketPr['via'], string> = {
  linear: 'linked in Linear',
  agent: "the agent's PR",
  branch: 'branch names the ticket',
  title: 'title names the ticket',
}

/** One linked PR, read when its tab first opens and kept while the panel shows the card. */
function PrTab({ pr, now }: { pr: TicketPr; now: number }) {
  const [loaded, setLoaded] = useState<{ pr: ReviewPr; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { repo, number } = pr
  const load = useCallback(async (): Promise<void> => {
    setError(null)
    const r = await invoke('reviews.pr', { repo, number })
    if (r.ok) setLoaded({ pr: r.value, at: Date.now() })
    else setError(r.error.message)
  }, [repo, number])
  useEffect(() => {
    void load()
  }, [load])
  if (!loaded)
    return (
      <div className="eva-ab-tv-note" data-testid="ticket-pr-loading">
        {error ? `Couldn't load ${pr.repo}#${pr.number}: ${error}` : 'Loading the pull request...'}
      </div>
    )
  return (
    <Detail
      pr={loaded.pr}
      fetchedAt={loaded.at}
      now={now}
      onRefresh={() => void load()}
      variant="panel"
    />
  )
}

/** Who works on the card and how: its column, why it sits there, the session on it, the hand-off. */
function AgentStrip({
  card,
  linearUrl,
  now,
}: {
  card: AgentCard
  /** The ticket's Linear link: a ticket goes to Astra only with one. */
  linearUrl: string | null
  now: number
}) {
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const Column = COLUMN_ICON[card.column]
  const session = card.links.find((l) => l.kind === 'session') ?? null
  const files = card.links.filter((l) => l.kind === 'ledger' || l.kind === 'worktree')
  const running = card.column === 'working'
  const canSend = card.key !== null && linearUrl !== null

  const send = async (): Promise<void> => {
    if (!card.key || !linearUrl) return
    setBusy(true)
    const r = await invoke('reviews.sendTicket', {
      key: card.key,
      title: card.title,
      url: linearUrl,
      note: note.trim(),
    })
    setBusy(false)
    if (!r.ok) return fail("Couldn't reach Astra", r.error.message)
    setSending(false)
    setNote('')
    notifications.show(
      r.value.status === 'sent'
        ? { message: `Sent ${card.key} to Astra.`, color: 'green' }
        : { message: `Test instance, not sent: ${r.value.command}`, color: 'gray' },
    )
  }

  return (
    <section className="eva-ab-tv-agent" data-testid="ticket-agent">
      <div className="eva-ab-tv-agentrow">
        <span className="eva-ab-pcolumn" data-column={card.column}>
          <Column size={16} stroke={1.75} className="eva-ab-colicon" aria-hidden />
          <span>{COLUMN_TITLE[card.column]}</span>
        </span>
        <ListPill tone={PILL_TONE[card.pill.tone]}>{card.pill.label}</ListPill>
        {card.agent ? <span className="eva-ab-tv-dim">{card.agent}</span> : null}
        <span className="eva-ab-tv-spacer" />
        {files.map((l) => {
          const Glyph = l.kind === 'ledger' ? IconFileText : IconFolder
          return (
            <Tooltip key={`${l.kind}:${l.label}`} label={l.label} openDelay={300}>
              <UnstyledButton
                className="eva-ab-tv-iconbtn"
                aria-label={l.kind === 'ledger' ? 'Open the work item' : 'Open the worktree'}
                data-testid={`agents-link-${l.kind}`}
                onClick={(e) => openAgentLink(l.open, openTargetOf(e))}
              >
                <Glyph size={15} stroke={1.5} />
              </UnstyledButton>
            </Tooltip>
          )
        })}
        {canSend ? (
          <Button
            size="xs"
            variant="default"
            leftSection={<IconSend size={14} />}
            onClick={() => setSending(true)}
            data-testid="ticket-send"
          >
            Send to Astra
          </Button>
        ) : null}
      </div>
      <p className="eva-ab-reason" data-testid="agents-panel-reason">
        {card.reason}
      </p>
      {session ? (
        <UnstyledButton
          className="eva-ab-tv-session"
          data-running={running || undefined}
          data-testid="ticket-session"
          onClick={(e) => openAgentLink(session.open, openTargetOf(e))}
        >
          <IconMessageCircle size={16} stroke={1.5} className="eva-ab-linkicon" aria-hidden />
          <span className="eva-ab-linktext">
            <span className="eva-ab-linklabel">
              {running ? <span className="eva-ab-tv-live" aria-label="Running" /> : null}
              {session.label}
            </span>
            <span className="eva-ab-linksub">
              {card.intent ?? session.sub ?? 'No status yet'}
              {card.activityAt !== null ? ` · ${clockLabel(card.activityAt, now)}` : ''}
            </span>
          </span>
          <span className="eva-ab-tv-open">Open session</span>
        </UnstyledButton>
      ) : null}

      <EvaModal
        opened={sending}
        onClose={() => setSending(false)}
        title={`Send ${card.key ?? ''} to Astra?`}
        size={480}
      >
        <div className="eva-ab-tv-dim">
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
        <div className="eva-rv-modal-actions">
          <Button variant="default" onClick={() => setSending(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void send()} data-testid="ticket-send-confirm">
            Send
          </Button>
        </div>
      </EvaModal>
    </section>
  )
}

/** The whole panel for one card. `onCollapse`/`onClose` are absent in the narrow drawer, which has its own close. */
export function TicketView({
  card,
  now,
  onClose,
  onCollapse,
}: {
  card: AgentCard
  now: number
  onClose?: () => void
  onCollapse?: () => void
}) {
  const key = card.key
  const isLinear = key !== null && LINEAR_KEY.test(key)
  const [ticket, setTicket] = useState<LinearTicket | null>(null)
  const [hits, setHits] = useState<ReviewPrHit[]>([])
  const [tab, setTab] = useState<string | null>(null)

  useEffect(() => {
    setTicket(null)
    setHits([])
    setTab(null)
    if (!key || !LINEAR_KEY.test(key)) return
    let live = true
    void invoke('reviews.prSearch', { key }).then((r) => {
      if (live && r.ok) setHits(r.value)
    })
    return () => {
      live = false
    }
  }, [key])

  const prs = useMemo(
    () => ticketPrs({ key: key ?? '', links: ticket?.links ?? [], cardPr: card.pr, hits }),
    [key, ticket, card.pr, hits],
  )
  const idOf = (p: TicketPr): string => `${p.repo}#${p.number}`
  const active = prs.find((p) => idOf(p) === tab) ?? prs[0] ?? null
  const stub = isLinear ? reviewItemOf(key) : null
  const linearRow =
    stub?.kind === 'linear'
      ? { ...stub.row, title: card.title, url: card.linear?.url ?? stub.row.url }
      : null
  const linearUrl = ticket?.url ?? card.linear?.url ?? null

  return (
    <div className="eva-ab-tv" data-testid="agents-panel">
      <header className="eva-ab-tv-head">
        {key ? <span className="eva-ab-key">{key}</span> : null}
        <span className="eva-ab-tv-spacer" />
        {linearUrl ? (
          <Tooltip label="Open in Linear" openDelay={300}>
            <UnstyledButton
              className="eva-ab-tv-iconbtn"
              aria-label="Open in Linear"
              onClick={() => openLink(linearUrl, { reviews: false })}
            >
              <IconExternalLink size={15} stroke={1.5} />
            </UnstyledButton>
          </Tooltip>
        ) : null}
        {onCollapse ? (
          <Tooltip label="Collapse panel" openDelay={300}>
            <UnstyledButton
              className="eva-ab-tv-iconbtn"
              aria-label="Collapse panel"
              data-testid="agents-panel-collapse"
              onClick={onCollapse}
            >
              <IconLayoutSidebarRightCollapse size={15} stroke={1.5} />
            </UnstyledButton>
          </Tooltip>
        ) : null}
        {onClose ? (
          <Tooltip label="Close" openDelay={300}>
            <UnstyledButton
              className="eva-ab-tv-iconbtn"
              aria-label="Close panel"
              data-testid="agents-panel-close"
              onClick={onClose}
            >
              <IconX size={15} stroke={1.5} />
            </UnstyledButton>
          </Tooltip>
        ) : null}
      </header>
      <div className="eva-ab-tv-scroll">
        <AgentStrip card={card} linearUrl={isLinear ? linearUrl : null} now={now} />
        {linearRow ? (
          <LinearDetail
            key={linearRow.key}
            row={linearRow}
            now={now}
            variant="panel"
            onLoaded={setTicket}
          />
        ) : (
          <h2 className="eva-rv-lpanel-title eva-ab-tv-title">{card.title}</h2>
        )}

        <section className="eva-ab-tv-prs" data-testid="ticket-prs">
          {prs.length === 0 ? (
            <div className="eva-ab-tv-note">No linked pull requests.</div>
          ) : (
            <>
              <nav className="eva-rv-tabs eva-ab-tv-prtabs" role="tablist">
                {prs.map((p) => {
                  const Glyph = PR_ICON[p.state ?? 'open']
                  const id = idOf(p)
                  return (
                    <Tooltip
                      key={id}
                      label={`${p.title ?? id} (${VIA_WORDS[p.via]})`}
                      openDelay={400}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active !== null && idOf(active) === id}
                        className="eva-rv-tab"
                        data-pr={p.state ?? 'open'}
                        data-testid={`ticket-pr-tab-${p.repo.split('/')[1]}-${p.number}`}
                        onClick={() => setTab(id)}
                      >
                        <Glyph size={13} className="eva-ab-tv-prglyph" aria-hidden />
                        {p.repo.split('/')[1]}#{p.number}
                      </button>
                    </Tooltip>
                  )
                })}
              </nav>
              {active ? <PrTab key={idOf(active)} pr={active} now={now} /> : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
