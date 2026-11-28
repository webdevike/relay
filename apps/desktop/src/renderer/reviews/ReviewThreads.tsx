// A PR's review threads inline in the Diff tab: each thread under its line (an outdated one on the
// line it was written on, marked Outdated), images through the markdown media path, and replies and
// new threads written through the host gate (`reviewReply` / `reviewComment`) after Isaac confirms
// the exact text. A message to any configured assistant never goes to GitHub: it is a private ask
// in her own session on the PR (the ticket page's routing, DECISIONS 7), anchored to the line, and
// her thread shows on that line; replies in it stay in that thread.
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Badge, Button } from '@mantine/core'
import { IconArrowBackUp } from '@tabler/icons-react'
import type { ReviewComment, ReviewPr } from '@evaos/contract'
import type { PrMutation } from '@relay/protocol'
import type { DiffLine, Hunk } from '@relay/protocol/unified-diff'
import { Markdown } from '../chat/markdown/Markdown'
import { Composer, ConfirmPost, MutationNotice } from '../tickets/Composer'
import { agentOf, assistantsIn } from '../tickets/activity-model'
import {
  AskNotices,
  AssistantReply,
  askAssistants,
  useAssistantSessions,
  type AssistantSession,
} from '../tickets/AssistantReply'
import { useMentionAssistants } from '../tickets/mention-assistants'
import { prContext } from './astra-context'
import type { AstraThread } from './astra-timeline'
import type { DiffAnnotate, DiffCommentOn } from './DiffView'
import { ApprovalNote } from '../tickets/ApprovalNote'
import { prLoginOf, prWritesOn, usePrWrite, type PrWrite } from './pr-write'
import { agoPhrase } from './review-model'
import { Avatar } from './review-ui'
import {
  anchorText,
  asksIndex,
  placeOf,
  threadIndex,
  threadsOf,
  threadsOn,
  unplacedThreads,
  type DiffSide,
  type ReviewThread,
} from './review-threads'
import '../tickets/activity.css'
import './diff-tree.css'

/** Where the open composer writes: a new thread on a line, or a reply in a thread. */
type Draft =
  | { kind: 'new'; path: string; side: DiffSide; line: number; text: string }
  | { kind: 'reply'; root: ReviewComment; text: string }

const NO_PEOPLE: never[] = []

function CommentView({ c, now }: { c: ReviewComment; now: number }) {
  return (
    <div className="eva-rv-ithread-comment" data-testid="review-inline-comment">
      <div className="eva-rv-comment-head">
        <Avatar login={c.author} />
        <b>{c.author}</b>
        <span className="eva-rv-dim">{c.id < 0 ? 'just now' : agoPhrase(c.at, now)}</span>
      </div>
      {c.body.trim() ? <Markdown text={c.body} /> : null}
    </div>
  )
}

interface Ctx {
  now: number
  writes: boolean
  draft: Draft | null
  busy: boolean
  setDraft: (d: Draft | null) => void
  send: () => void
}

function DraftBox({ ctx, placeholder }: { ctx: Ctx; placeholder: string }) {
  const { draft } = ctx
  if (!draft) return null
  return (
    <Composer
      value={draft.text}
      onChange={(text) => ctx.setDraft({ ...draft, text })}
      people={NO_PEOPLE}
      placeholder={placeholder}
      target="GitHub"
      busy={ctx.busy}
      onSend={ctx.send}
      onCancel={() => ctx.setDraft(null)}
      sendLabel={draft.kind === 'reply' ? 'Reply' : 'Comment'}
      autoFocus
      testid="review-inline-composer"
    />
  )
}

function ThreadView({ t, ctx }: { t: ReviewThread; ctx: Ctx }) {
  const replying = ctx.draft?.kind === 'reply' && ctx.draft.root.id === t.root.id
  return (
    <div
      className="eva-rv-ithread"
      data-testid="review-inline-thread"
      data-outdated={t.outdated || undefined}
      data-thread={t.root.id}
    >
      {t.outdated ? (
        <Badge size="xs" variant="light" color="gray" data-testid="review-inline-outdated">
          Outdated
        </Badge>
      ) : null}
      <CommentView c={t.root} now={ctx.now} />
      {t.replies.map((r) => (
        <CommentView key={r.id} c={r} now={ctx.now} />
      ))}
      {replying ? <DraftBox ctx={ctx} placeholder="Reply on GitHub, or @Astra privately" /> : null}
      {ctx.writes && !replying ? (
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconArrowBackUp size={12} />}
          onClick={() => ctx.setDraft({ kind: 'reply', root: t.root, text: '' })}
          data-testid="review-inline-reply"
        >
          Reply
        </Button>
      ) : null}
    </div>
  )
}

export interface InlineThreads {
  /** The threads (and the open composer) under a file's lines. */
  annotate: (path: string) => DiffAnnotate
  /** Starts a thread on a line; undefined when this PR takes no writes. */
  onComment: (path: string) => DiffCommentOn | undefined
  /** A file's threads whose line isn't in the diff shown, above it. */
  unplaced: (path: string, hunks: readonly Hunk[]) => ReactNode
  /** The confirm and the write's notice. */
  overlay: ReactNode
}

/** The written text a gate write sends, for the confirm and the local copy. */
function mutationOf(pr: ReviewPr, d: Draft, body: string): PrMutation | null {
  if (d.kind === 'reply')
    return { kind: 'reviewReply', repo: pr.repo, number: pr.number, commentId: d.root.id, body }
  if (!pr.headSha) return null
  const { path, line, side } = d
  return {
    kind: 'reviewComment',
    repo: pr.repo,
    number: pr.number,
    commitId: pr.headSha,
    path,
    line,
    side,
    body,
  }
}

/** What Isaac just posted, shown in place until the PR is read again. */
function localOf(m: PrMutation, root: ReviewComment | null): ReviewComment | null {
  const base = { id: -Date.now(), author: 'You', at: Date.now(), outdated: false }
  if (m.kind === 'reviewReply' && root)
    return { ...root, ...base, inReplyTo: root.id, body: m.body, reactions: [] }
  if (m.kind !== 'reviewComment') return null
  const { path, line, side, body } = m
  return { ...base, inReplyTo: null, path, line, originalLine: line, side, body }
}

function askText(d: Draft, text: string): string {
  if (d.kind === 'new') return `${anchorText(d.path, d.side, d.line)} ${text}`
  const at = d.root.line ?? d.root.originalLine ?? 0
  const about = `(about ${d.root.author}'s review comment: "${d.root.body.slice(0, 300)}")`
  return `${anchorText(d.root.path, d.root.side, at)} ${about} ${text}`
}

/** The exact-text confirm of a line comment or reply: the host's approval in full. */
function DraftConfirm({ write, draft }: { write: PrWrite; draft: Draft | null }) {
  const v = write.view
  const reply = draft?.kind === 'reply'
  return (
    <ConfirmPost
      opened={v.kind === 'confirming'}
      title={reply ? 'Reply on GitHub' : 'Comment on GitHub'}
      text={v.kind === 'confirming' ? (v.approval.text ?? draft?.text.trim()) : draft?.text.trim()}
      note={v.kind === 'confirming' ? <ApprovalNote approval={v.approval} /> : null}
      confirmLabel={reply ? 'Post reply' : 'Post comment'}
      busy={v.kind === 'committing'}
      onConfirm={write.confirm}
      onCancel={write.cancel}
    />
  )
}

/** The inline threads for one PR's Diff tab. */
export function useInlineThreads(pr: ReviewPr, onChanged?: () => void): InlineThreads {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [posted, setPosted] = useState<ReviewComment[]>([])
  const writes = prWritesOn(pr)
  const write = usePrWrite(prLoginOf(pr), (_, m) => {
    const local = localOf(m, draft?.kind === 'reply' ? draft.root : null)
    if (local) setPosted((p) => [...p, local])
    setDraft(null)
    onChanged?.()
  })
  const assistants = useMentionAssistants()
  const { sessions, slots } = useAssistantSessions({
    url: pr.url,
    label: `${pr.repo}#${String(pr.number)}`,
    context: () => prContext(pr),
  })
  const threads = useMemo(
    () => threadsOf([...(pr.reviewComments ?? []), ...posted]),
    [pr.reviewComments, posted],
  )
  const index = useMemo(() => threadIndex(threads), [threads])
  const sessionOf = useMemo(
    () =>
      new Map<AstraThread, AssistantSession>(sessions.flatMap((s) => s.threads.map((t) => [t, s]))),
    [sessions],
  )
  const asks = useMemo(() => asksIndex([...sessionOf.keys()]), [sessionOf])
  const busy =
    sessions.some((s) => s.sending) ||
    write.view.kind === 'preparing' ||
    write.view.kind === 'committing'
  const now = Date.now()

  const send = useCallback(() => {
    const d = draft
    const text = d?.text.trim() ?? ''
    if (!d || !text) return
    const named = [...new Set(assistantsIn(text, assistants).map(agentOf))]
    if (named.length > 0) {
      void askAssistants(sessions, named, askText(d, text)).then((ok) => {
        if (ok) setDraft(null)
      })
      return
    }
    const m = mutationOf(pr, d, text)
    if (m) write.run(m)
  }, [draft, pr, assistants, sessions, write])

  const ctx: Ctx = { now, writes, draft, busy, setDraft, send }
  const askView = (t: AstraThread) => {
    const session = sessionOf.get(t)
    return session ? (
      <AssistantReply
        key={`${session.agent}-${t.id}`}
        session={session}
        thread={t}
        now={now}
        me="Isaac"
        look="pr"
      />
    ) : null
  }

  const annotate =
    (path: string): DiffAnnotate =>
    (lines) => {
      const on = threadsOn(index, path, lines)
      const asked = threadsOn(asks, path, lines)
      const here =
        draft?.kind === 'new' &&
        draft.path === path &&
        lines.some((l) => {
          const p = placeOf(l)
          return p !== null && p.side === draft.side && p.line === draft.line
        })
      if (on.length === 0 && asked.length === 0 && !here) return null
      return (
        <div className="eva-rv-ithreads" data-testid="review-inline-threads">
          {on.map((t) => (
            <ThreadView key={t.root.id} t={t} ctx={ctx} />
          ))}
          {asked.map(askView)}
          {here ? (
            <DraftBox ctx={ctx} placeholder="Comment on GitHub, or @Astra privately" />
          ) : null}
        </div>
      )
    }

  const onComment = (path: string): DiffCommentOn | undefined => {
    if (!writes) return undefined
    return (l: DiffLine) => {
      const p = placeOf(l)
      if (p) setDraft({ kind: 'new', path, ...p, text: '' })
    }
  }

  const unplaced = (path: string, hunks: readonly Hunk[]): ReactNode => {
    const away = unplacedThreads(threads, path, hunks)
    if (away.length === 0) return null
    return (
      <div className="eva-rv-ithreads" data-testid="review-inline-unplaced">
        {away.map((t) => (
          <ThreadView key={t.root.id} t={t} ctx={ctx} />
        ))}
      </div>
    )
  }

  const overlay = (
    <>
      <DraftConfirm write={write} draft={draft} />
      <div className="eva-rv-ithreads-notice">
        <MutationNotice view={write.view} onRetry={write.retry} onDismiss={write.cancel} />
        <AskNotices sessions={sessions} />
      </div>
      {slots}
    </>
  )
  return { annotate, onComment, unplaced, overlay }
}
