// One pull request's page (PLAN T5.1), the same on the Reviews page, a review tab and a ticket's PR
// route (`ticket:<KEY>/pr/<owner>/<repo>/<n>`): a header, tabs Guide | Diff | Comments, and the
// sidebar (status, merge, reviewers, checks, tickets, details), foldable to a status strip with the
// choice kept. In a narrow pane the sidebar starts folded and opens over the content.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button, Loader, SegmentedControl, Textarea, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconBook2,
  IconCheck,
  IconChevronLeft,
  IconExternalLink,
  IconFileDiff,
  IconGitBranch,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconMessage,
  IconMessages,
  IconRefresh,
} from '@tabler/icons-react'
import type { ReviewApprove, ReviewPr } from '@evaos/contract'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { EvaModal } from '../overlay'
import { parseBool, parseOneOf, usePref } from '../ui-prefs'
import { PrComments } from './PrComments'
import { PrSidebar, PrStrip } from './PrSidebar'
import { ReviewFiles } from './ReviewFiles'
import { ReviewGuide } from './ReviewGuide'
import { ago, agoPhrase } from './review-model'
import { SourceMark, fail, useLocal } from './review-ui'
import { refreshRowStatus } from './row-status'

const TABS = ['guide', 'diff', 'comments'] as const
type Tab = (typeof TABS)[number]
const parseTab = parseOneOf(TABS)

/** Below this width the page is a narrow pane: the sidebar starts folded and opens over the tab. */
export const NARROW_PX = 760

/** Whether the element is narrower than NARROW_PX (an unmeasured element counts as wide). */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setNarrow(el.clientWidth > 0 && el.clientWidth < NARROW_PX)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return narrow
}

const REVIEW_EVENTS = [
  { value: 'comment', label: 'Comment' },
  { value: 'approve', label: 'Approve' },
  { value: 'request-changes', label: 'Request changes' },
] as const
type ReviewEvent = (typeof REVIEW_EVENTS)[number]['value']

/** Approve on an auto-work draft: straight to Astra (no confirm), the ledger read on open and refresh. */
interface Approval {
  /** Approve shows on an auto-work draft waiting on Isaac; null elsewhere. */
  approval: ReviewApprove | null
  approving: boolean
  error: string | null
  approve: () => Promise<void>
}

function useApproval(pr: ReviewPr, fetchedAt: number): Approval {
  const [approval, setApproval] = useState<ReviewApprove | null>(null)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = { repo: pr.repo, number: pr.number }
  useEffect(() => {
    let live = true
    void invoke('reviews.approvable', ref).then((r) => {
      if (live) setApproval(r.ok ? r.value : null)
    })
    return () => {
      live = false
    }
  }, [pr.repo, pr.number, fetchedAt])
  const approve = async (): Promise<void> => {
    setApproving(true)
    setError(null)
    const r = await invoke('reviews.approve', ref)
    setApproving(false)
    if (!r.ok) return setError(`Couldn't reach Astra: ${r.error.message}`)
    setApproval((a) => (a ? { ...a, state: 'sent' } : a))
    if (r.value.status !== 'sent')
      notifications.show({ message: `Test instance, not sent: ${r.value.command}`, color: 'gray' })
    refreshRowStatus()
  }
  return { approval, approving, error, approve }
}

function ApproveButton({ a }: { a: Approval }) {
  if (a.approval?.state === 'running')
    return (
      <Tooltip label="Self-review running" openDelay={300}>
        <span
          className="eva-rv-dim"
          role="img"
          aria-label="Self-review running"
          data-testid="review-approve-running"
        >
          <Loader size={14} />
        </span>
      </Tooltip>
    )
  return (
    <>
      {a.error ? (
        <span className="eva-rv-bad eva-rv-small" data-testid="review-approve-error">
          {a.error}
        </span>
      ) : null}
      {a.approval ? (
        <Button
          size="xs"
          leftSection={<IconCheck size={14} />}
          disabled={a.approval.state === 'sent'}
          loading={a.approving}
          onClick={() => void a.approve()}
          data-testid="review-approve"
        >
          {a.approval.state === 'sent' ? 'Approved' : 'Approve'}
        </Button>
      ) : null}
    </>
  )
}

function IconBtn({
  label,
  onClick,
  testid,
  children,
}: {
  label: string
  onClick: () => void
  testid?: string
  children: ReactNode
}) {
  return (
    <Tooltip label={label} openDelay={300}>
      <button
        type="button"
        className="eva-rv-iconbtn"
        aria-label={label}
        data-testid={testid}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/** Approve, request changes or comment as a GitHub review, after Isaac writes it here. */
function ReviewModal({
  pr,
  opened,
  onClose,
  onPosted,
}: {
  pr: ReviewPr
  opened: boolean
  onClose: () => void
  onPosted: () => void
}) {
  const [event, setEvent] = useState<ReviewEvent>('comment')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true)
    const r = await invoke('reviews.review', {
      repo: pr.repo,
      number: pr.number,
      event,
      body: body.trim(),
    })
    setBusy(false)
    if (!r.ok)
      return fail(r.error.code === 'dry-run' ? 'Not posted' : "Couldn't post it", r.error.message)
    setBody('')
    onClose()
    notifications.show({ message: 'Posted on GitHub.', color: 'green' })
    onPosted()
  }
  return (
    <EvaModal opened={opened} onClose={onClose} title="Review changes" size={480}>
      <SegmentedControl
        fullWidth
        value={event}
        onChange={(v) => setEvent(v as ReviewEvent)}
        data={REVIEW_EVENTS.map((e) => ({ value: e.value, label: e.label }))}
        data-testid="review-event"
      />
      <Textarea
        mt="sm"
        autosize
        minRows={3}
        placeholder="Summary (optional for Approve)"
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        data-testid="review-body"
      />
      <div className="eva-rv-modal-actions">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          disabled={event !== 'approve' && !body.trim()}
          onClick={() => void submit()}
          data-testid="review-submit"
        >
          Submit review on GitHub
        </Button>
      </div>
    </EvaModal>
  )
}

function stateWord(pr: ReviewPr): string {
  if (pr.draft) return 'Draft'
  if (pr.state === 'MERGED') return 'Merged'
  return pr.state === 'OPEN' ? 'Open' : 'Closed'
}

function Head({ pr, now }: { pr: ReviewPr; now: number }) {
  const state = stateWord(pr)
  return (
    <div className="eva-rv-head">
      <h1 className="eva-rv-title eva-rv-title-wrap">{pr.title}</h1>
      <div className="eva-rv-meta">
        <SourceMark source="github" size={13} />
        <span className="eva-rv-mono" title={pr.repo} data-testid="review-head-id">
          {pr.repo.split('/')[1]}#{pr.number}
        </span>
        ·
        {state !== 'Open' ? (
          <>
            <span
              className="eva-rv-pill"
              data-tone={state === 'Merged' ? 'violet' : 'gray'}
              data-testid="review-head-state"
            >
              {state}
            </span>
            ·
          </>
        ) : null}
        <span>{pr.author.login}</span>·<span>{ago(pr.createdAt, now)}</span>·
        <span className="eva-rv-add">+{pr.additions}</span>
        <span className="eva-rv-del">−{pr.deletions}</span>
        <Tooltip label={`${pr.head} into ${pr.base}`} openDelay={300}>
          <span className="eva-rv-branchicon" role="img" aria-label={`${pr.head} into ${pr.base}`}>
            <IconGitBranch size={13} />
          </span>
        </Tooltip>
      </div>
    </div>
  )
}

function Tabs({ pr, tab, onTab }: { pr: ReviewPr; tab: Tab; onTab: (t: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string; count?: number; icon: ReactNode }> = [
    { id: 'guide', label: 'Guide', icon: <IconBook2 size={13} /> },
    { id: 'diff', label: 'Diff', count: pr.files.length, icon: <IconFileDiff size={13} /> },
    {
      id: 'comments',
      label: 'Comments',
      count: pr.timeline.length + (pr.reviewComments?.length ?? 0) + 1,
      icon: <IconMessages size={13} />,
    },
  ]
  return (
    <nav className="eva-rv-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className="eva-rv-tab"
          data-testid={`review-tab-${t.id}`}
          onClick={() => onTab(t.id)}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined ? <span className="eva-rv-dim">{t.count}</span> : null}
        </button>
      ))}
    </nav>
  )
}

/** Files marked viewed, kept locally per PR. */
function useViewed(url: string) {
  const [viewed, setViewed] = useLocal<string[]>(`eva-reviews-viewed:${url}`, [])
  return {
    set: new Set(viewed),
    mark: (p: string, on: boolean) =>
      setViewed(on ? [...viewed, p] : viewed.filter((v) => v !== p)),
  }
}

function TabBody({
  pr,
  tab,
  now,
  narrow,
  onTab,
  onRefresh,
  onReload,
  onReview,
}: {
  pr: ReviewPr
  tab: Tab
  now: number
  narrow: boolean
  onTab: (t: Tab) => void
  onRefresh: () => void
  onReload: (() => Promise<boolean>) | undefined
  onReview: () => void
}) {
  const [focusFile, setFocusFile] = useState<string | null>(null)
  const viewed = useViewed(pr.url)
  if (tab === 'comments') return <PrComments pr={pr} now={now} onChanged={onRefresh} />
  return (
    <>
      <div className="eva-rv-scroll">
        {tab === 'diff' ? (
          <ReviewFiles
            pr={pr}
            viewed={viewed.set}
            focus={focusFile}
            compact={narrow}
            onViewed={viewed.mark}
            onChanged={onRefresh}
          />
        ) : (
          <ReviewGuide
            pr={pr}
            viewed={viewed.set}
            onViewed={viewed.mark}
            onViewInDiff={(p) => {
              setFocusFile(p)
              onTab('diff')
            }}
            onStale={onReload}
          />
        )}
      </div>
      <div className="eva-rv-dock">
        <button
          type="button"
          className="eva-rv-dockbtn"
          onClick={onReview}
          data-testid="review-changes-dock"
        >
          <IconMessage size={14} /> Review changes
        </button>
      </div>
    </>
  )
}

/** The sidebar's place: open as kept (wide), or folded unless opened here (narrow). */
function useSidebar(narrow: boolean) {
  const [kept, setKept] = usePref<boolean>('reviews.prSidebar', true, parseBool)
  const [narrowOpen, setNarrowOpen] = useState(false)
  const open = narrow ? narrowOpen : kept
  const toggle = (): void => (narrow ? setNarrowOpen(!narrowOpen) : setKept(!kept))
  return { open, toggle }
}

export interface PrViewProps {
  pr: ReviewPr
  fetchedAt: number
  now: number
  onBack?: () => void
  onRefresh: () => void
  /** Reloads only the PR: true when a new PR came, false when the read failed (the Guide says so). */
  onReload?: () => Promise<boolean>
  onDone?: () => void
  /** The folded sidebar's strip under the header (off where the page has its own, the ticket's). */
  strip?: boolean
}

function TopBar({
  p,
  sideOpen,
  onSide,
  onReview,
}: {
  p: PrViewProps
  sideOpen: boolean
  onSide: () => void
  onReview: () => void
}) {
  const approval = useApproval(p.pr, p.fetchedAt)
  return (
    <header className="eva-rv-topbar">
      {p.onBack ? (
        <IconBtn label="Back to inbox" onClick={p.onBack} testid="review-back">
          <IconChevronLeft size={14} />
        </IconBtn>
      ) : null}
      <span className="eva-rv-spacer" />
      <IconBtn
        label={`Updated ${agoPhrase(p.fetchedAt, p.now)}. Refresh`}
        onClick={p.onRefresh}
        testid="review-refresh"
      >
        <IconRefresh size={14} />
      </IconBtn>
      <IconBtn label="Open on GitHub" onClick={() => openLink(p.pr.url, { reviews: false })}>
        <IconExternalLink size={14} />
      </IconBtn>
      <ApproveButton a={approval} />
      <Button
        size="xs"
        variant="default"
        leftSection={<IconMessage size={14} />}
        onClick={onReview}
        data-testid="review-changes"
      >
        Review
      </Button>
      {p.onDone ? (
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCheck size={14} />}
          onClick={p.onDone}
          data-testid="review-done"
        >
          Done
        </Button>
      ) : null}
      <IconBtn
        label={sideOpen ? 'Hide details' : 'Show details'}
        onClick={onSide}
        testid="pr-sidebar-toggle"
      >
        {sideOpen ? (
          <IconLayoutSidebarRightCollapse size={14} />
        ) : (
          <IconLayoutSidebarRightExpand size={14} />
        )}
      </IconBtn>
    </header>
  )
}

export function PrView(props: PrViewProps) {
  const { pr, now, onRefresh, strip = true } = props
  const root = useRef<HTMLElement>(null)
  const narrow = useNarrow(root)
  const side = useSidebar(narrow)
  const [tab, setTab] = usePref<Tab>('reviews.prTab', 'comments', parseTab)
  const [reviewing, setReviewing] = useState(false)
  return (
    <section
      ref={root}
      className="eva-rv-detail"
      data-narrow={narrow || undefined}
      data-sidebar={side.open ? 'open' : 'folded'}
      data-testid="review-detail"
    >
      <TopBar
        p={props}
        sideOpen={side.open}
        onSide={side.toggle}
        onReview={() => setReviewing(true)}
      />
      <Head pr={pr} now={now} />
      {strip && !side.open ? <PrStrip pr={pr} /> : null}
      <Tabs pr={pr} tab={tab} onTab={setTab} />
      <div className="eva-rv-main">
        <div className="eva-rv-content">
          <TabBody
            key={pr.url}
            pr={pr}
            tab={tab}
            now={now}
            narrow={narrow}
            onTab={setTab}
            onRefresh={onRefresh}
            onReload={props.onReload}
            onReview={() => setReviewing(true)}
          />
        </div>
        {side.open ? <PrSidebar pr={pr} onChanged={onRefresh} /> : null}
      </div>
      <ReviewModal
        pr={pr}
        opened={reviewing}
        onClose={() => setReviewing(false)}
        onPosted={onRefresh}
      />
    </section>
  )
}
