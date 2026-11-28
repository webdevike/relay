// The PR page's Comments tab (PLAN T5.5), grown from Reviews' Conversation: the PR body, the
// conversation comments, reviews, review (line) comments and pushes in time order, with Isaac's
// private assistant threads at their place. Images come through the shared markdown media path
// (widths kept). Reactions show who on hover; a click sets Isaac's own as desired state through the
// host gate (`react`). The box posts a comment only after the gate's confirm; the old confirmed
// `reviews.comment` only without a capable host (`prWritePath`). A message to any configured
// assistant goes to her own private session on the PR (the ticket page's routing), never to GitHub.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActionIcon, Badge, Tooltip, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconGitCommit, IconMoodPlus } from '@tabler/icons-react'
import type { ReviewComment, ReviewPr } from '@evaos/contract'
import type { PrReactionTarget } from '@relay/protocol'
import { invoke } from '../ipc'
import { Markdown } from '../chat/markdown/Markdown'
import { EvaPopover } from '../overlay'
import { Composer, ConfirmPost, MutationNotice } from '../tickets/Composer'
import { agentOf, assistantsIn, type Person } from '../tickets/activity-model'
import {
  AskNotices,
  AssistantReply,
  askAssistants,
  useAssistantSessions,
} from '../tickets/AssistantReply'
import { useMentionAssistants } from '../tickets/mention-assistants'
import type { MutationView } from '../tickets/use-mutation'
import { mergeTimeline } from './astra-timeline'
import { prContext } from './astra-context'
import { ago, agoPhrase } from './review-model'
import { Avatar, fail } from './review-ui'
import { reviewStateOf } from './PrSidebar'
import { ApprovalNote } from '../tickets/ApprovalNote'
import {
  GITHUB_REACTION,
  PR_ACTIONS_STALE,
  prLoginOf,
  prWritePath,
  prWritesOn,
  useGithubLogin,
  usePrWrite,
} from './pr-write'

type Reactions = Array<{ emoji: string; users: string[] }>

interface ReactCtx {
  me: string | null
  canReact: boolean
  /** Isaac's reactions as he last set them here, until the next read shows them (`target|emoji`). */
  local: Readonly<Record<string, boolean>>
  onSet: (target: PrReactionTarget, emoji: string, on: boolean) => void
}

const targetKey = (t: PrReactionTarget): string => ('id' in t ? `${t.kind}:${t.id}` : t.kind)

/** The read's reactions with Isaac's own as he set them since. */
function shownReactions(base: Reactions, target: PrReactionTarget, ctx: ReactCtx): Reactions {
  const me = ctx.me ?? 'you'
  const out = base.map((r) => ({ ...r, users: [...r.users] }))
  for (const [key, on] of Object.entries(ctx.local)) {
    const [t, emoji] = key.split('|') as [string, string]
    if (t !== targetKey(target)) continue
    let r = out.find((x) => x.emoji === emoji)
    if (!r && on) out.push((r = { emoji, users: [] }))
    if (!r) continue
    r.users = on ? [...new Set([...r.users, me])] : r.users.filter((u) => u !== me)
  }
  return out.filter((r) => r.users.length > 0)
}

function ReactionChips({
  reactions,
  target,
  ctx,
}: {
  reactions: Reactions | undefined
  target: PrReactionTarget
  ctx: ReactCtx
}) {
  const [picking, setPicking] = useState(false)
  const shown = shownReactions(reactions ?? [], target, ctx)
  if (shown.length === 0 && !ctx.canReact) return null
  const mine = (emoji: string): boolean =>
    ctx.me !== null && (shown.find((r) => r.emoji === emoji)?.users.includes(ctx.me) ?? false)
  return (
    <div className="eva-rv-reactions" data-testid="pr-reactions">
      {shown.map((r) => (
        <Tooltip key={r.emoji} label={r.users.join(', ')} openDelay={300}>
          <UnstyledButton
            className="eva-rv-reaction"
            data-mine={mine(r.emoji) || undefined}
            aria-pressed={mine(r.emoji)}
            aria-label={`${r.emoji} ${r.users.length}`}
            disabled={!ctx.canReact || !GITHUB_REACTION[r.emoji]}
            onClick={() => ctx.onSet(target, r.emoji, !mine(r.emoji))}
            data-testid="pr-reaction"
          >
            <span>{r.emoji}</span>
            <span>{r.users.length}</span>
          </UnstyledButton>
        </Tooltip>
      ))}
      {ctx.canReact ? (
        <EvaPopover opened={picking} onChange={setPicking} position="bottom-start">
          <EvaPopover.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={22}
              aria-label="Add reaction"
              onClick={() => setPicking((p) => !p)}
              data-testid="pr-react-add"
            >
              <IconMoodPlus size={14} stroke={1.5} />
            </ActionIcon>
          </EvaPopover.Target>
          <EvaPopover.Dropdown>
            <div className="eva-rv-picker-row">
              {Object.keys(GITHUB_REACTION).map((e) => (
                <UnstyledButton
                  key={e}
                  className="eva-rv-reaction-pick"
                  aria-label={`React ${e}`}
                  onClick={() => {
                    setPicking(false)
                    ctx.onSet(target, e, !mine(e))
                  }}
                >
                  {e}
                </UnstyledButton>
              ))}
            </div>
          </EvaPopover.Dropdown>
        </EvaPopover>
      ) : null}
    </div>
  )
}

function CommentCard({
  author,
  verb,
  at,
  now,
  body,
  extra,
  children,
}: {
  author: string
  verb: string
  at: number
  now: number
  body: string
  extra?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="eva-rv-comment" data-testid="pr-comment">
      <div className="eva-rv-comment-head">
        <Avatar login={author} />
        <b>{author}</b>
        <span className="eva-rv-dim">
          {verb} {agoPhrase(at, now)}
        </span>
        {extra}
      </div>
      {body.trim() ? <Markdown text={body} /> : null}
      {children}
    </div>
  )
}

/** A review thread on a line of the diff: where, its first comment and its replies. */
function ReviewThread({
  thread,
  now,
  ctx,
}: {
  thread: ReviewComment[]
  now: number
  ctx: ReactCtx
}) {
  const root = thread[0]!
  const line = root.line ?? root.originalLine
  return (
    <div className="eva-rv-rthread" data-testid="pr-review-thread">
      <div className="eva-rv-rthread-where eva-rv-mono">
        {root.path}
        {line === null ? '' : `:${line}`}
        {root.outdated ? (
          <Badge size="xs" variant="light" color="gray" ml="xs">
            Outdated
          </Badge>
        ) : null}
      </div>
      {thread.map((c) => (
        <CommentCard
          key={c.id}
          author={c.author}
          verb="commented"
          at={c.at}
          now={now}
          body={c.body}
        >
          <ReactionChips
            reactions={c.reactions}
            target={{ kind: 'reviewComment', id: c.id }}
            ctx={ctx}
          />
        </CommentCard>
      ))}
    </div>
  )
}

/** Review comments as threads (a reply joins its root), each at its first comment's time. */
function reviewThreadsOf(comments: readonly ReviewComment[]): ReviewComment[][] {
  const byRoot = new Map<number, ReviewComment[]>()
  for (const c of comments) {
    const root = c.inReplyTo ?? c.id
    byRoot.set(root, [...(byRoot.get(root) ?? []), c])
  }
  return [...byRoot.values()]
}

interface Item {
  at: number
  key: string
  node: ReactNode
}

function itemsOf(pr: ReviewPr, now: number, ctx: ReactCtx): Item[] {
  const pushes = pr.commits.map((c) => ({
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
  }))
  const said = pr.timeline.map((t, i) => ({
    at: t.at,
    key: `t${t.id ?? i}`,
    node: (
      <CommentCard
        author={t.author}
        verb={t.kind === 'review' ? reviewStateOf(t.state ?? '').label.toLowerCase() : 'commented'}
        at={t.at}
        now={now}
        body={t.body}
      >
        {t.kind === 'comment' && t.id !== undefined ? (
          <ReactionChips
            reactions={t.reactions}
            target={{ kind: 'issueComment', id: t.id }}
            ctx={ctx}
          />
        ) : null}
      </CommentCard>
    ),
  }))
  const threads = reviewThreadsOf(pr.reviewComments ?? []).map((thread) => ({
    at: thread[0]!.at,
    key: `r${thread[0]!.id}`,
    node: <ReviewThread thread={thread} now={now} ctx={ctx} />,
  }))
  return [...pushes, ...said, ...threads].sort((a, b) => a.at - b.at)
}

/** The PR's people as the composer's @ list (GitHub logins: a mention is `@login`). */
const peopleOf = (pr: ReviewPr): Person[] =>
  pr.participants.map((l) => ({ name: l, handle: l, url: '' }))

/** Isaac's reactions through the gate (desired state), shown at once and kept until the next read. */
function useReactions(pr: ReviewPr, onChanged: () => void): ReactCtx {
  const me = useGithubLogin()
  const [local, setLocal] = useState<Record<string, boolean>>({})
  const last = useRef<string | null>(null)
  const write = usePrWrite(prLoginOf(pr), () => onChanged())
  const v = write.view
  // Not written (refused, failed, or unknown): the chip goes back to what GitHub has.
  useEffect(() => {
    if (v.kind !== 'refused' && v.kind !== 'failed' && v.kind !== 'unknown') return
    const key = last.current
    if (key) setLocal(({ [key]: _, ...rest }) => rest)
    fail("Couldn't react", v.message)
  }, [v])
  return {
    me,
    canReact: prWritesOn(pr),
    local,
    onSet: (target, emoji, on) => {
      const content = GITHUB_REACTION[emoji]
      if (!content) return
      const key = `${targetKey(target)}|${emoji}`
      last.current = key
      setLocal((l) => ({ ...l, [key]: on }))
      write.run({ kind: 'react', repo: pr.repo, number: pr.number, target, emoji: content, on })
    },
  }
}

const IDLE: MutationView = { kind: 'idle' }
const STALE: MutationView = { kind: 'refused', message: PR_ACTIONS_STALE }

/**
 * The comment box's writes, by the host's capability (`prWritePath`): the gate's post (confirmed);
 * the old confirmed path only without a capable host; refused (`stale`, Retry re-reads) when a
 * capable host's read came without its facts.
 */
function usePost(pr: ReviewPr, onPosted: () => void) {
  const gate = usePrWrite(prLoginOf(pr), () => {
    notifications.show({ message: 'Posted on GitHub.', color: 'green' })
    onPosted()
  })
  const [legacy, setLegacy] = useState<{ body: string; busy: boolean } | null>(null)
  const [stale, setStale] = useState(false)
  const post = (body: string): void => {
    const path = prWritePath(pr)
    if (path === 'gate') gate.run({ kind: 'comment', repo: pr.repo, number: pr.number, body })
    else if (path === 'legacy') setLegacy({ body, busy: false })
    else setStale(true)
  }
  const postLegacy = async (): Promise<void> => {
    if (!legacy) return
    setLegacy({ ...legacy, busy: true })
    const r = await invoke('reviews.comment', {
      repo: pr.repo,
      number: pr.number,
      body: legacy.body,
    })
    setLegacy(null)
    if (!r.ok)
      return fail(r.error.code === 'dry-run' ? 'Not posted' : "Couldn't post it", r.error.message)
    notifications.show({ message: 'Posted on GitHub.', color: 'green' })
    onPosted()
  }
  return { gate, legacy, setLegacy, post, postLegacy, stale, setStale }
}

type Posting = ReturnType<typeof usePost>

/** The confirm before a comment posts: the gate's approval in full, or the legacy path's own words. */
function CommentConfirm({ pr, posting, draft }: { pr: ReviewPr; posting: Posting; draft: string }) {
  const v = posting.gate.view
  const legacy = posting.legacy
  return (
    <ConfirmPost
      opened={v.kind === 'confirming' || v.kind === 'committing' || legacy !== null}
      title="Post this comment on GitHub?"
      text={v.kind === 'confirming' ? (v.approval.text ?? draft) : draft}
      note={
        v.kind === 'confirming' ? (
          <ApprovalNote approval={v.approval} />
        ) : (
          `Posts as you on ${pr.repo}#${pr.number}. Everyone on the PR sees it.`
        )
      }
      confirmLabel="Post comment"
      busy={v.kind === 'committing' || legacy?.busy === true}
      onConfirm={() => (legacy ? void posting.postLegacy() : posting.gate.confirm())}
      onCancel={() => (legacy ? posting.setLegacy(null) : posting.gate.cancel())}
    />
  )
}

export function PrComments({
  pr,
  now,
  onChanged,
}: {
  pr: ReviewPr
  now: number
  onChanged: () => void
}) {
  const [draft, setDraft] = useState('')
  const label = `${pr.repo.split('/')[1]}#${pr.number}`
  const assistants = useMentionAssistants()
  const { sessions, slots } = useAssistantSessions({
    url: pr.url,
    label,
    context: () => prContext(pr),
  })
  const ctx = useReactions(pr, onChanged)
  const posting = usePost(pr, () => {
    setDraft('')
    onChanged()
  })
  const people = peopleOf(pr)
  const sessionOf = new Map(sessions.flatMap((s) => s.threads.map((t) => [t, s] as const)))
  const v = posting.gate.view

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    const named = [...new Set(assistantsIn(text, assistants).map(agentOf))]
    if (named.length === 0) return posting.post(text)
    // An assistant is mentioned: a private ask in her own session on the PR; nothing is posted.
    void askAssistants(sessions, named, text).then((ok) => ok && setDraft(''))
  }

  return (
    <>
      {slots}
      <div className="eva-rv-scroll">
        <div className="eva-rv-conv" data-testid="review-conversation">
          <CommentCard
            author={pr.author.login}
            verb="opened this"
            at={pr.createdAt}
            now={now}
            body=""
          >
            <div className="eva-rv-body" data-testid="pr-body">
              {pr.body.trim() ? (
                <Markdown text={pr.body} />
              ) : (
                <span className="eva-rv-dim">No description.</span>
              )}
            </div>
            <ReactionChips reactions={pr.bodyReactions} target={{ kind: 'prBody' }} ctx={ctx} />
          </CommentCard>
          <div className="eva-rv-timeline">
            {mergeTimeline(itemsOf(pr, now, ctx), (i) => i.at, [...sessionOf.keys()]).map((e) => {
              if (e.kind === 'comment') return <div key={e.item.key}>{e.item.node}</div>
              const session = sessionOf.get(e.thread)!
              return (
                <AssistantReply
                  key={`${session.agent}-${e.thread.id}`}
                  session={session}
                  thread={e.thread}
                  now={now}
                  me="Isaac"
                  look="pr"
                />
              )
            })}
          </div>
        </div>
      </div>
      <div className="eva-rv-composer">
        <Composer
          value={draft}
          onChange={setDraft}
          people={people}
          placeholder="Leave a comment. Type @Astra to ask Astra privately."
          target={`posts on ${label} as you`}
          busy={astra.asking || v.kind === 'preparing' || v.kind === 'committing'}
          onSend={send}
          testid="review-composer"
        />
        <MutationNotice view={v} onRetry={posting.gate.retry} onDismiss={posting.gate.cancel} />
        <MutationNotice
          view={posting.stale ? STALE : IDLE}
          onRetry={() => {
            posting.setStale(false)
            onChanged()
          }}
          onDismiss={() => posting.setStale(false)}
        />
        <AskNotices sessions={sessions} />
      </div>
      <CommentConfirm pr={pr} posting={posting} draft={draft.trim()} />
    </>
  )
}
