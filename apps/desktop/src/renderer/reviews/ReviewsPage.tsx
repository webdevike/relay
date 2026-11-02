import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, SegmentedControl, TextInput, Textarea } from '@mantine/core'
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
import type { LinearTicket, ReviewPr, ReviewRow, SlackRow } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { Markdown } from '../chat/markdown/Markdown'
import { LinearDetail } from './LinearDetail'
import { SlackDetail } from './SlackDetail'
import { ReviewFiles } from './ReviewFiles'
import { ReviewGuide } from './ReviewGuide'
import { ago, agoPhrase, mentionsAstra, nextAfter, prKey, queueGroups } from './review-model'
import { Avatar, RailSection, fail, useLocal } from './review-ui'
import { AstraThreadView, threadPropsOf, useAstraItem } from './AstraInline'
import { mergeTimeline, threadReplyText } from './astra-timeline'
import { prContext } from './astra-context'
import { loadQueue, reviewsStore, useReviews, useReviewsSurface } from './reviews-store'
import './reviews.css'

type Tab = 'conversation' | 'files' | 'checks' | 'guide'

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

function Conversation({
  pr,
  now,
  astra,
  onUseAsReply,
}: {
  pr: ReviewPr
  now: number
  /** The PR's Astra session: its private threads join the timeline by time. */
  astra: ReturnType<typeof useAstraItem>
  onUseAsReply: (text: string) => void
}) {
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
  const threadProps = threadPropsOf(astra)

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
        {mergeTimeline(items, (i) => i.at, astra.threads).map((e) =>
          e.kind === 'astra' ? (
            <AstraThreadView
              key={`astra-${e.thread.id}`}
              {...threadProps(e.thread)}
              now={now}
              look="pr"
              onReply={(root, text) =>
                astra.ask(
                  threadReplyText(root, text),
                  `${pr.repo.split('/')[1]}#${pr.number}`,
                  () => prContext(pr),
                )
              }
              onUseAsReply={onUseAsReply}
            />
          ) : (
            <div key={e.item.key}>{e.item.node}</div>
          ),
        )}
      </div>
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
  const [draft, setDraft] = useState('')
  const [confirm, setConfirm] = useState<'comment' | 'review' | null>(null)
  const [event, setEvent] = useState<(typeof REVIEW_EVENTS)[number]['value']>('comment')
  const [busy, setBusy] = useState(false)
  const ref = { repo: pr.repo, number: pr.number }
  const viewedSet = new Set(viewed)

  const astra = useAstraItem(pr.url)

  // Cmd+Enter or Comment: @Astra asks Astra in this PR's own session; anything else asks before it posts.
  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    if (mentionsAstra(text)) {
      setBusy(true)
      const label = `${pr.repo.split('/')[1]}#${pr.number}`
      if (await astra.ask(text, label, () => prContext(pr))) setDraft('')
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
            {tab === 'conversation' ? (
              <Conversation pr={pr} now={now} astra={astra} onUseAsReply={setDraft} />
            ) : null}
            {tab === 'files' ? (
              <ReviewFiles
                pr={pr}
                viewed={viewedSet}
                focus={focusFile}
                onViewed={(p, on) => setViewed(on ? [...viewed, p] : viewed.filter((v) => v !== p))}
              />
            ) : null}
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
                  disabled={!draft.trim() || busy || astra.asking}
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

/** Reviews: the pull request, ticket or Slack thread picked in the sidebar queue (Conversation, Files, Checks, Guide). */
export function ReviewsPage(_: { place: Place }) {
  useReviewsSurface()
  const queue = useReviews((s) => s.queue)
  const error = useReviews((s) => s.error)
  const view = useReviews((s) => s.view)
  const selected = useReviews((s) => s.selected)
  const ticket = useReviews((s) => s.ticket)
  const thread = useReviews((s) => s.thread)
  const linear = useReviews((s) => s.linear)
  const slack = useReviews((s) => s.slack)
  const autoOpened = useReviews((s) => s.autoOpened)
  const [pr, setPr] = useState<{ key: string; pr: ReviewPr; at: number } | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const loadPr = useCallback(async (row: ReviewRow) => {
    setPrError(null)
    const r = await invoke('reviews.pr', { repo: row.repo, number: row.number })
    if (r.ok) setPr({ key: prKey(row), pr: r.value, at: Date.now() })
    else setPrError(r.error.message)
  }, [])

  // Open the first PR that needs Isaac once the queue arrives.
  useEffect(() => {
    if (!queue || selected || ticket || thread || autoOpened) return
    const first = queueGroups(queue, view).find((g) => g.rows.length > 0 && g.id !== 'completed')
      ?.rows[0]
    if (first) reviewsStore.setState({ autoOpened: true, selected: first })
  }, [queue, view, selected, ticket, thread, autoOpened])

  useEffect(() => {
    if (selected && pr?.key !== prKey(selected)) void loadPr(selected)
  }, [selected, pr, loadPr])

  const markDone = async (
    url: string,
    updatedAt: number,
  ): Promise<Record<string, number> | null> => {
    const r = await invoke('reviews.done', { url, updatedAt, done: true })
    if (!r.ok) {
      fail("Couldn't mark it done", r.error.message)
      return null
    }
    reviewsStore.setState((s) => ({
      doneLocal: r.value,
      queue: s.queue ? { ...s.queue, done: r.value } : s.queue,
    }))
    return r.value
  }

  const done = async (): Promise<void> => {
    if (!queue || !pr || !selected) return
    if (!(await markDone(pr.pr.url, Math.max(selected.updatedAt, pr.pr.updatedAt)))) return
    const next = nextAfter(queueGroups(reviewsStore.getState().queue ?? queue, view), pr.key)
    reviewsStore.setState({ selected: next })
    if (!next) setPr(null)
    notifications.show({ message: `Done: ${pr.pr.title}`, color: 'green' })
  }

  const doneTicket = async (t: LinearTicket): Promise<void> => {
    if (!ticket) return
    const marks = await markDone(t.url, Math.max(ticket.updatedAt, Date.now()))
    if (!marks) return
    const rows = linear.rows ?? []
    const at = rows.findIndex((x) => x.key === ticket.key)
    const rest = rows.filter((x) => x.key !== ticket.key && !(marks[x.url]! >= x.updatedAt))
    reviewsStore.setState({ ticket: rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null })
    notifications.show({ message: `Done: ${t.key} ${t.title}`, color: 'green' })
  }

  // Done holds a thread back until someone writes in it again.
  const doneThread = async (row: SlackRow): Promise<void> => {
    const marks = await markDone(row.url, row.updatedAt)
    if (!marks) return
    const rows = slack.queue?.rows ?? []
    const at = rows.findIndex((x) => x.url === row.url)
    const rest = rows.filter((x) => x.url !== row.url && !(marks[x.url]! >= x.updatedAt))
    reviewsStore.setState({ thread: rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null })
    notifications.show({ message: `Done: ${row.channelName}`, color: 'green' })
  }

  const shown = selected && pr?.key === prKey(selected) ? pr : null
  return (
    <div className="eva-rv" data-testid="reviews-page">
      {thread ? (
        <SlackDetail
          key={thread.url}
          row={thread}
          now={now}
          onBack={() => reviewsStore.setState({ thread: null })}
          onDone={() => void doneThread(thread)}
        />
      ) : ticket ? (
        <LinearDetail
          key={ticket.key}
          row={ticket}
          now={now}
          onBack={() => reviewsStore.setState({ ticket: null })}
          onDone={(t) => void doneTicket(t)}
        />
      ) : error ? (
        <div className="eva-rv-placeholder eva-rv-error">Couldn't read GitHub: {error}</div>
      ) : shown ? (
        <Detail
          pr={shown.pr}
          fetchedAt={shown.at}
          now={now}
          onBack={() => {
            reviewsStore.setState({ selected: null })
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
                ? 'Pick a pull request, ticket or Slack thread from the queue.'
                : 'Loading your reviews...'}
        </div>
      )}
    </div>
  )
}
