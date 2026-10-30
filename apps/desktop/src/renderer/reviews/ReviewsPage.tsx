import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedControl, Textarea } from '@mantine/core'
import { EvaModal } from '../overlay'
import { notifications } from '@mantine/notifications'
import {
  IconBook2,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconExternalLink,
  IconGitBranch,
  IconGitCommit,
  IconGitPullRequest,
  IconGitPullRequestDraft,
  IconLock,
  IconMessage,
  IconRefresh,
} from '@tabler/icons-react'
import type { ReviewPr, ReviewQueue, ReviewRow } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { Markdown } from '../chat/markdown/Markdown'
import { ReviewFiles } from './ReviewFiles'
import { ReviewGuide } from './ReviewGuide'
import {
  ago,
  agoPhrase,
  mentionsAstra,
  nextAfter,
  prKey,
  queueGroups,
  type QueueGroup,
} from './review-model'
import './reviews.css'

type Tab = 'conversation' | 'files' | 'commits' | 'checks' | 'guide'
type View = 'for-me' | 'created'

interface PrivateAsk {
  text: string
  at: number
  status: 'sent' | 'dry-run'
}

/** Per-PR things only this app knows (files marked viewed, private asks to Astra), kept locally. */
function useLocal<T>(key: string | null, empty: T): [T, (v: T) => void] {
  const read = (): T => {
    if (!key) return empty
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : empty
    } catch {
      return empty
    }
  }
  const [value, setValue] = useState<T>(read)
  useEffect(() => setValue(read()), [key])
  return [
    value,
    (v: T) => {
      setValue(v)
      if (key) localStorage.setItem(key, JSON.stringify(v))
    },
  ]
}

function fail(title: string, message: string): void {
  notifications.show({ title, message, color: 'red' })
}

/** Initials in a circle: GitHub avatars are remote images the shell does not load. */
function Avatar({ login }: { login: string }) {
  return (
    <span className="eva-rv-avatar" title={login} aria-hidden>
      {login.slice(0, 1).toUpperCase()}
    </span>
  )
}

function QueueRow({
  row,
  subtitle,
  active,
  now,
  onOpen,
}: {
  row: ReviewRow
  subtitle: string
  active: boolean
  now: number
  onOpen: () => void
}) {
  const Glyph = row.draft ? IconGitPullRequestDraft : IconGitPullRequest
  return (
    <button
      type="button"
      className="eva-rv-qrow"
      data-active={active || undefined}
      data-testid={`review-row-${row.number}`}
      onClick={onOpen}
      title={`${row.repo}#${row.number} ${row.title}`}
    >
      <span className="eva-rv-qrow-line">
        <span className="eva-rv-qrow-title">{row.title}</span>
        <Glyph size={14} className="eva-rv-qrow-icon" data-draft={row.draft || undefined} />
      </span>
      <span className="eva-rv-qrow-line eva-rv-dim">
        <span className="eva-rv-qrow-sub">{subtitle}</span>
        <Avatar login={row.author} />
        <span>{ago(row.updatedAt, now)}</span>
      </span>
    </button>
  )
}

function Queue({
  queue,
  view,
  setView,
  selected,
  onOpen,
  now,
}: {
  queue: ReviewQueue | null
  view: View
  setView: (v: View) => void
  selected: string | null
  onOpen: (r: ReviewRow) => void
  now: number
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({ completed: true })
  const groups: QueueGroup[] = queue ? queueGroups(queue, view) : []
  return (
    <aside className="eva-rv-queue" data-testid="review-queue">
      <div className="eva-rv-queue-title">Reviews</div>
      <SegmentedControl
        size="xs"
        value={view}
        onChange={(v) => setView(v as View)}
        data={[
          { value: 'for-me', label: 'For me' },
          { value: 'created', label: 'Created' },
        ]}
        className="eva-rv-queue-view"
      />
      {queue === null ? <div className="eva-rv-dim eva-rv-pad">Loading...</div> : null}
      {groups.map((g) => (
        <div key={g.id} className="eva-rv-group">
          <button
            type="button"
            className="eva-rv-group-head"
            onClick={() => setClosed({ ...closed, [g.id]: !closed[g.id] })}
          >
            {g.label} <span className="eva-rv-dim">{g.count}</span>
            {closed[g.id] ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
          </button>
          {closed[g.id] ? null : g.rows.length === 0 ? (
            <div className="eva-rv-dim eva-rv-pad">Nothing here.</div>
          ) : (
            g.rows.map((r) => (
              <QueueRow
                key={prKey(r)}
                row={r}
                subtitle={g.subtitle}
                active={selected === prKey(r)}
                now={now}
                onOpen={() => onOpen(r)}
              />
            ))
          )}
        </div>
      ))}
    </aside>
  )
}

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="eva-rv-rail-sec">
      <div className="eva-rv-rail-title">{title}</div>
      {children}
    </section>
  )
}

const REVIEW_STATE: Record<string, { label: string; tone: string }> = {
  PENDING: { label: 'Pending', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'green' },
  CHANGES_REQUESTED: { label: 'Changes', tone: 'red' },
  COMMENTED: { label: 'Commented', tone: 'gray' },
  DISMISSED: { label: 'Dismissed', tone: 'gray' },
}

function Rail({ pr }: { pr: ReviewPr }) {
  return (
    <aside className="eva-rv-rail" data-testid="review-rail">
      <RailSection title="Reviewers">
        {pr.reviewers.length === 0 ? <div className="eva-rv-dim">No reviewers.</div> : null}
        {pr.reviewers.map((r) => {
          const s = REVIEW_STATE[r.state] ?? { label: r.state.toLowerCase(), tone: 'gray' }
          return (
            <div key={r.login} className="eva-rv-rail-person">
              <Avatar login={r.login} />
              <span className="eva-rv-ellipsis">{r.login}</span>
              <span className="eva-rv-spacer" />
              <span className="eva-rv-pill" data-tone={s.tone}>
                {s.label}
              </span>
            </div>
          )
        })}
      </RailSection>
      <RailSection title="Assignees">
        {pr.assignees.length === 0 ? <div className="eva-rv-dim">Nobody assigned.</div> : null}
        {pr.assignees.map((a) => (
          <div key={a} className="eva-rv-rail-person">
            <Avatar login={a} />
            {a}
          </div>
        ))}
      </RailSection>
      <RailSection title="Labels">
        {pr.labels.length === 0 ? (
          <div className="eva-rv-dim">No labels.</div>
        ) : (
          <div className="eva-rv-labels">
            {pr.labels.map((l) => (
              <span key={l.name} className="eva-rv-label" style={{ borderColor: `#${l.color}` }}>
                {l.name}
              </span>
            ))}
          </div>
        )}
      </RailSection>
      <RailSection title="Milestone">
        <div className={pr.milestone ? undefined : 'eva-rv-dim'}>
          {pr.milestone ?? 'No milestone.'}
        </div>
      </RailSection>
      <RailSection title="Projects">
        <div className={pr.projects.length ? undefined : 'eva-rv-dim'}>
          {pr.projects.join(', ') || 'None yet.'}
        </div>
      </RailSection>
      <RailSection title="Participants">
        <div className="eva-rv-labels">
          {pr.participants.map((p) => (
            <Avatar key={p} login={p} />
          ))}
        </div>
      </RailSection>
    </aside>
  )
}

function CheckIcon({ state }: { state: string }) {
  if (state === 'pass') return <IconCircleCheck size={15} className="eva-rv-ok" />
  if (state === 'fail') return <IconCircleX size={15} className="eva-rv-bad" />
  return <IconCircleDashed size={15} className="eva-rv-dim" />
}

function Conversation({ pr, asks, now }: { pr: ReviewPr; asks: PrivateAsk[]; now: number }) {
  // A question just sent shows where it landed: the end of the conversation.
  const lastAsk = useRef<HTMLDivElement>(null)
  const asked = useRef(asks.length)
  useEffect(() => {
    if (asks.length > asked.current) lastAsk.current?.scrollIntoView({ block: 'nearest' })
    asked.current = asks.length
  }, [asks.length])
  // One timeline: comments and reviews interleaved with pushes, oldest first, like E3.
  const items = [
    ...pr.commits.map((c) => ({
      at: c.at,
      key: `c${c.oid}`,
      node: (
        <div className="eva-rv-push">
          <IconGitCommit size={13} className="eva-rv-dim" />
          <b>{c.author}</b> <span className="eva-rv-dim">pushed</span>
          <code className="eva-rv-sha">{c.oid.slice(0, 7)}</code>
          <span className="eva-rv-ellipsis">{c.headline}</span>
          <span className="eva-rv-spacer" />
          <span className="eva-rv-dim">{ago(c.at, now)}</span>
        </div>
      ),
    })),
    ...pr.timeline.map((t, i) => ({
      at: t.at,
      key: `t${i}`,
      node: (
        <div className="eva-rv-comment">
          <div className="eva-rv-comment-head">
            <Avatar login={t.author} />
            <b>{t.author}</b>
            <span className="eva-rv-dim">
              {t.kind === 'review'
                ? (REVIEW_STATE[t.state ?? '']?.label.toLowerCase() ?? 'reviewed')
                : 'commented'}{' '}
              {agoPhrase(t.at, now)}
            </span>
          </div>
          {t.body.trim() ? <Markdown text={t.body} /> : null}
        </div>
      ),
    })),
  ].sort((a, b) => a.at - b.at)

  return (
    <div className="eva-rv-conv" data-testid="review-conversation">
      <div className="eva-rv-comment-head">
        <Avatar login={pr.author.login} />
        <b>{pr.author.login}</b>
        <span className="eva-rv-dim">opened this {agoPhrase(pr.createdAt, now)}</span>
      </div>
      <div className="eva-rv-body">
        {pr.body.trim() ? (
          <Markdown text={pr.body} />
        ) : (
          <span className="eva-rv-dim">No description.</span>
        )}
      </div>
      <div className="eva-rv-timeline">
        {items.map((i) => (
          <div key={i.key}>{i.node}</div>
        ))}
      </div>
      {asks.map((a, i) => (
        <div
          key={i}
          ref={i === asks.length - 1 ? lastAsk : undefined}
          className="eva-rv-private"
          data-testid="review-private-ask"
        >
          <div className="eva-rv-private-head">
            <IconLock size={13} /> Private to Astra{' '}
            <span className="eva-rv-dim">{agoPhrase(a.at, now)}</span>
          </div>
          <div className="eva-rv-private-q">{a.text}</div>
          <div className="eva-rv-dim">
            {a.status === 'sent'
              ? "Sent to Astra's thread. Her answer arrives there, never on GitHub."
              : 'Test instance: not sent to Astra.'}
          </div>
        </div>
      ))}
    </div>
  )
}

function Commits({ pr, now }: { pr: ReviewPr; now: number }) {
  return (
    <div className="eva-rv-list" data-testid="review-commits">
      {pr.commits.map((c) => (
        <button
          type="button"
          key={c.oid}
          className="eva-rv-listrow"
          onClick={() => openLink(`${pr.url}/commits/${c.oid}`)}
        >
          <IconGitCommit size={14} className="eva-rv-dim" />
          <span className="eva-rv-ellipsis">{c.headline}</span>
          <span className="eva-rv-spacer" />
          <span className="eva-rv-dim">{c.author}</span>
          <code className="eva-rv-sha">{c.oid.slice(0, 7)}</code>
          <span className="eva-rv-dim">{ago(c.at, now)}</span>
        </button>
      ))}
    </div>
  )
}

function Checks({ pr }: { pr: ReviewPr }) {
  if (pr.checks.length === 0)
    return <div className="eva-rv-empty">No checks ran on this pull request.</div>
  return (
    <div className="eva-rv-list" data-testid="review-checks">
      {pr.checks.map((c, i) => (
        <button
          type="button"
          key={i}
          className="eva-rv-listrow"
          disabled={!c.url}
          onClick={() => c.url && openLink(c.url)}
        >
          <CheckIcon state={c.state} />
          <span className="eva-rv-ellipsis">{c.name}</span>
          <span className="eva-rv-spacer" />
          <span className="eva-rv-dim">{c.state}</span>
          {c.url ? <IconExternalLink size={13} className="eva-rv-dim" /> : null}
        </button>
      ))}
    </div>
  )
}

const REVIEW_EVENTS = [
  { value: 'comment', label: 'Comment' },
  { value: 'approve', label: 'Approve' },
  { value: 'request-changes', label: 'Request changes' },
] as const

/** The PR: E3 header, tabs, the tab's body beside the rail, and the comment box or review dock. */
function Detail({
  pr,
  fetchedAt,
  now,
  onBack,
  onRefresh,
  onDone,
}: {
  pr: ReviewPr
  fetchedAt: number
  now: number
  onBack: () => void
  onRefresh: () => void
  onDone: () => void
}) {
  const [tab, setTab] = useState<Tab>('conversation')
  const [focusFile, setFocusFile] = useState<string | null>(null)
  const [viewed, setViewed] = useLocal<string[]>(`eva-reviews-viewed:${pr.url}`, [])
  const [asks, setAsks] = useLocal<PrivateAsk[]>(`eva-reviews-asks:${pr.url}`, [])
  const [draft, setDraft] = useState('')
  const [confirm, setConfirm] = useState<'comment' | 'review' | null>(null)
  const [event, setEvent] = useState<(typeof REVIEW_EVENTS)[number]['value']>('comment')
  const [busy, setBusy] = useState(false)
  const ref = { repo: pr.repo, number: pr.number }
  const viewedSet = new Set(viewed)

  const astra = async (text: string): Promise<boolean> => {
    const r = await invoke('reviews.astra', {
      ...ref,
      url: pr.url,
      title: pr.title,
      text,
    })
    if (!r.ok) {
      fail("Couldn't reach Astra", r.error.message)
      return false
    }
    setAsks([...asks, { text, at: Date.now(), status: r.value.status }])
    notifications.show({
      message:
        r.value.status === 'sent'
          ? "Sent to Astra's thread."
          : `Test instance, not sent: ${r.value.command}`,
      color: r.value.status === 'sent' ? 'green' : 'gray',
    })
    return true
  }

  // Cmd+Enter or Comment: @Astra goes privately to Astra; anything else asks before it posts.
  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    if (mentionsAstra(text)) {
      setBusy(true)
      if (await astra(text)) setDraft('')
      setBusy(false)
      return
    }
    setConfirm('comment')
  }

  const post = async (): Promise<void> => {
    setBusy(true)
    const r =
      confirm === 'review'
        ? await invoke('reviews.review', { ...ref, event, body: draft.trim() })
        : await invoke('reviews.comment', { ...ref, body: draft.trim() })
    setBusy(false)
    setConfirm(null)
    if (!r.ok)
      return fail(r.error.code === 'dry-run' ? 'Not posted' : "Couldn't post it", r.error.message)
    setDraft('')
    notifications.show({ message: 'Posted on GitHub.', color: 'green' })
    onRefresh()
  }

  const TABS: Array<{ id: Tab; label: string; count?: number; icon?: ReactNode }> = [
    { id: 'conversation', label: 'Conversation', count: pr.timeline.length + 1 },
    { id: 'files', label: 'Files', count: pr.files.length },
    { id: 'commits', label: 'Commits', count: pr.commits.length },
    { id: 'checks', label: 'Checks', count: pr.checks.length, icon: <IconCircleCheck size={13} /> },
    { id: 'guide', label: 'Guide', icon: <IconBook2 size={13} /> },
  ]
  const state = pr.draft
    ? 'Draft'
    : pr.state === 'OPEN'
      ? 'Open'
      : pr.state === 'MERGED'
        ? 'Merged'
        : 'Closed'

  return (
    <section className="eva-rv-detail" data-testid="review-detail">
      <header className="eva-rv-topbar">
        <button type="button" className="eva-rv-back" onClick={onBack}>
          <IconChevronLeft size={14} /> Inbox
        </button>
        <span className="eva-rv-spacer" />
        <span className="eva-rv-dim eva-rv-small">updated {agoPhrase(fetchedAt, now)}</span>
        <button type="button" className="eva-rv-iconbtn" aria-label="Refresh" onClick={onRefresh}>
          <IconRefresh size={14} />
        </button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCheck size={14} />}
          onClick={onDone}
          data-testid="review-done"
        >
          Done
        </Button>
        <button
          type="button"
          className="eva-rv-iconbtn"
          aria-label="Open on GitHub"
          onClick={() => openLink(pr.url)}
        >
          <IconExternalLink size={14} />
        </button>
      </header>
      <div className="eva-rv-head">
        <div className="eva-rv-titlerow">
          <IconGitPullRequest size={15} className="eva-rv-ok" />
          <span className="eva-rv-dim eva-rv-mono eva-rv-repo" title={pr.repo}>
            {pr.repo}
          </span>
          <span className="eva-rv-dim">#{pr.number}</span>
          <h1 className="eva-rv-title">{pr.title}</h1>
        </div>
        <div className="eva-rv-meta">
          <span
            className="eva-rv-pill"
            data-tone={state === 'Open' ? 'green' : state === 'Merged' ? 'violet' : 'gray'}
          >
            {state}
          </span>
          <span>{pr.author.login}</span>·<span>{ago(pr.createdAt, now)}</span>·
          <IconGitBranch size={12} />
          <span className="eva-rv-mono">{pr.base}</span>
          <span className="eva-rv-dim">‹</span>
          <span className="eva-rv-mono">{pr.head}</span>·
          <span className="eva-rv-add">+{pr.additions}</span>
          <span className="eva-rv-del">-{pr.deletions}</span>
        </div>
      </div>
      <nav className="eva-rv-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className="eva-rv-tab"
            data-testid={`review-tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined ? <span className="eva-rv-dim">{t.count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="eva-rv-main">
        <div className="eva-rv-content">
          <div className="eva-rv-scroll">
            {tab === 'conversation' ? <Conversation pr={pr} asks={asks} now={now} /> : null}
            {tab === 'files' ? (
              <ReviewFiles
                pr={pr}
                viewed={viewedSet}
                focus={focusFile}
                onViewed={(p, on) => setViewed(on ? [...viewed, p] : viewed.filter((v) => v !== p))}
              />
            ) : null}
            {tab === 'commits' ? <Commits pr={pr} now={now} /> : null}
            {tab === 'checks' ? <Checks pr={pr} /> : null}
            {tab === 'guide' ? (
              <ReviewGuide
                pr={pr}
                viewed={viewedSet}
                onViewed={(p, on) => setViewed(on ? [...viewed, p] : viewed.filter((v) => v !== p))}
                onViewInDiff={(p) => {
                  setFocusFile(p)
                  setTab('files')
                }}
              />
            ) : null}
          </div>
          {tab === 'conversation' ? (
            <div className="eva-rv-composer">
              <Textarea
                autosize
                minRows={2}
                maxRows={10}
                value={draft}
                placeholder="Leave a comment. Type @Astra to ask Astra privately."
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void submit()
                  }
                }}
                data-private={mentionsAstra(draft) || undefined}
                data-testid="review-composer"
              />
              <div className="eva-rv-composer-foot">
                <span className="eva-rv-dim eva-rv-small">
                  {mentionsAstra(draft) ? (
                    <>
                      <IconLock size={11} /> Private to Astra, never posted on GitHub
                    </>
                  ) : (
                    'Cmd+Enter to comment'
                  )}
                </span>
                <span className="eva-rv-spacer" />
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={!draft.trim() || busy}
                  onClick={() => void submit()}
                >
                  {mentionsAstra(draft) ? 'Ask Astra' : 'Comment'}
                </Button>
              </div>
            </div>
          ) : tab === 'files' || tab === 'guide' ? (
            <div className="eva-rv-dock">
              <button
                type="button"
                className="eva-rv-dockbtn"
                onClick={() => setConfirm('review')}
                data-testid="review-changes"
              >
                <IconMessage size={14} /> Review changes
              </button>
            </div>
          ) : null}
        </div>
        <Rail pr={pr} />
      </div>

      <EvaModal
        opened={confirm === 'comment'}
        onClose={() => setConfirm(null)}
        title="Post this comment on GitHub?"
        size={480}
      >
        <div className="eva-rv-confirm-text" data-testid="review-confirm-text">
          {draft.trim()}
        </div>
        <div className="eva-rv-dim eva-rv-small">
          Posts as you on {pr.repo}#{pr.number}. Everyone on the PR sees it.
        </div>
        <div className="eva-rv-modal-actions">
          <Button variant="default" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void post()} data-testid="review-confirm-post">
            Post comment
          </Button>
        </div>
      </EvaModal>

      <EvaModal
        opened={confirm === 'review'}
        onClose={() => setConfirm(null)}
        title="Review changes"
        size={480}
      >
        <SegmentedControl
          fullWidth
          value={event}
          onChange={(v) => setEvent(v as typeof event)}
          data={REVIEW_EVENTS.map((e) => ({ value: e.value, label: e.label }))}
        />
        <Textarea
          mt="sm"
          autosize
          minRows={3}
          placeholder="Summary (optional for Approve)"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <div className="eva-rv-modal-actions">
          <Button variant="default" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={event !== 'approve' && !draft.trim()}
            onClick={() => void post()}
          >
            Submit review on GitHub
          </Button>
        </div>
      </EvaModal>
    </section>
  )
}

/** Reviews: Isaac's GitHub review queue beside one pull request (Conversation, Files, Commits, Checks, Guide). */
export function ReviewsPage(_: { place: Place }) {
  const [queue, setQueue] = useState<ReviewQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('for-me')
  const [selected, setSelected] = useState<ReviewRow | null>(null)
  const [pr, setPr] = useState<{ key: string; pr: ReviewPr; at: number } | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  // Back to the queue stays there: the first PR opens by itself only once.
  const [autoOpened, setAutoOpened] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const loadQueue = useCallback(async (refresh: boolean) => {
    const r = await invoke('reviews.queue', { refresh })
    if (r.ok) {
      setQueue(r.value)
      setError(null)
    } else setError(r.error.message)
  }, [])

  const loadPr = useCallback(async (row: ReviewRow) => {
    setPrError(null)
    const r = await invoke('reviews.pr', { repo: row.repo, number: row.number })
    if (r.ok) setPr({ key: prKey(row), pr: r.value, at: Date.now() })
    else setPrError(r.error.message)
  }, [])

  useEffect(() => {
    void loadQueue(false)
  }, [loadQueue])

  // Open the first PR that needs Isaac once the queue arrives.
  useEffect(() => {
    if (!queue || selected || autoOpened) return
    const first = queueGroups(queue, view).find((g) => g.rows.length > 0 && g.id !== 'completed')
      ?.rows[0]
    if (first) {
      setAutoOpened(true)
      setSelected(first)
    }
  }, [queue, view, selected, autoOpened])

  useEffect(() => {
    if (selected && pr?.key !== prKey(selected)) void loadPr(selected)
  }, [selected, pr, loadPr])

  const done = async (): Promise<void> => {
    if (!queue || !pr || !selected) return
    const r = await invoke('reviews.done', {
      url: pr.pr.url,
      updatedAt: Math.max(selected.updatedAt, pr.pr.updatedAt),
      done: true,
    })
    if (!r.ok) return fail("Couldn't mark it done", r.error.message)
    const next = nextAfter(queueGroups(queue, view), pr.key)
    setQueue({ ...queue, done: r.value })
    setSelected(next)
    if (!next) setPr(null)
    notifications.show({ message: `Done: ${pr.pr.title}`, color: 'green' })
  }

  const shown = selected && pr?.key === prKey(selected) ? pr : null
  return (
    <div className="eva-rv" data-testid="reviews-page">
      <Queue
        queue={queue}
        view={view}
        setView={(v) => {
          setView(v)
          setSelected(null)
          setAutoOpened(false)
        }}
        selected={selected ? prKey(selected) : null}
        onOpen={setSelected}
        now={now}
      />
      {error ? (
        <div className="eva-rv-placeholder eva-rv-error">Couldn't read GitHub: {error}</div>
      ) : shown ? (
        <Detail
          pr={shown.pr}
          fetchedAt={shown.at}
          now={now}
          onBack={() => {
            setSelected(null)
            setPr(null)
          }}
          onRefresh={() => {
            if (selected) void loadPr(selected)
            void loadQueue(true)
          }}
          onDone={() => void done()}
        />
      ) : (
        <div className="eva-rv-placeholder eva-rv-dim">
          {prError
            ? `Couldn't load the pull request: ${prError}`
            : selected
              ? 'Loading the pull request...'
              : queue
                ? 'Pick a pull request from the queue.'
                : 'Loading your reviews...'}
        </div>
      )}
    </div>
  )
}
