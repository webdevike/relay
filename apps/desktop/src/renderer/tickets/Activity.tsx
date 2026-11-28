// The ticket page's description and activity (PLAN T2.5, T3.1, T4.2): comment threads by root id
// with their reactions and "..." menus, inline threads on the description (drawn into it through
// `InlineThreads`), private assistant threads in the thread they were asked in or at their place
// in time, a reply box per thread and the composer. People comments go through the host's gate
// (`comment`, exact-text confirm), the legacy `reviews.linearComment` path (writeMode legacy) or
// are hidden (none); a message to an assistant stays private in Relay (her own item session,
// `AssistantReply.tsx`), never through the gate.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconCircleCheckFilled } from '@tabler/icons-react'
import type {
  TicketActor,
  TicketComment,
  TicketConfirm,
  TicketDetail,
  TicketMutation,
  TicketOutcome,
} from '@relay/protocol'
import { mergeTimeline, type AstraThread } from '../reviews/astra-timeline'
import {
  NO_EDITS,
  agentOf,
  askedIn,
  assistantsIn,
  commentActions,
  detailContext,
  focusTarget,
  isInline,
  peopleOf,
  quoteAsk,
  reactionKey,
  threadAsk,
  threadsOf,
  withLocal,
  type CommentAction,
  type LocalEdits,
  type Person,
  type Thread,
} from './activity-model'
import {
  AskNotices,
  AssistantReply,
  useAssistantSessions,
  type AssistantSession,
} from './AssistantReply'
import { ApprovalNote } from './ApprovalNote'
import { CommentBlock, CommentMarkdown } from './CommentBlock'
import {
  Composer,
  ConfirmPost,
  MutationNotice,
  linearBody,
  postLegacyComment,
  quoteOf,
} from './Composer'
import type { AnchorContext } from './inline-anchor'
import { InlineThreads, useInlineHost, useInlineHostRef, type InlineDraft } from './InlineThreads'
import { NewIssueModal, notifyCreated } from './NewIssueModal'
import type { TicketData } from './ticket-data'
import { useTicketMutation } from './use-mutation'
import '../reviews/reviews.css'
import './activity.css'

/**
 * The ticket's description as Markdown (images at their width, mentions as pills), with the parts
 * the activity draws its inline threads into.
 */
export function TicketDescription({ data }: { data: TicketData }) {
  const hostRef = useInlineHostRef(data.key)
  const d = data.detail
  if (!d) return null
  return (
    <div
      className="eva-tk-description eva-tk-inline"
      data-testid="ticket-description"
      ref={hostRef}
    >
      <div data-inline-body>
        {d.description.trim() ? (
          <CommentMarkdown text={d.description} people={peopleOf(d)} />
        ) : (
          <span className="eva-rv-dim">No description.</span>
        )}
      </div>
      <ClippedNotice detail={d} />
      <div className="eva-tk-inline-layer" data-inline-layer />
      <div className="eva-tk-inline-foot" data-inline-foot />
    </div>
  )
}

/** What the host left out of this page to keep it bounded (`detail.clipped`); Linear has it all. */
export function clippedWords(clipped: TicketDetail['clipped']): string | null {
  if (!clipped) return null
  const parts = [
    clipped.description ? 'the end of the description' : null,
    clipped.comments > 0
      ? `${clipped.comments} older ${clipped.comments === 1 ? 'comment' : 'comments'}`
      : null,
  ].filter((p) => p !== null)
  return parts.length > 0
    ? `Not shown here: ${parts.join(' and ')}. Open it in Linear for all of it.`
    : null
}

function ClippedNotice({ detail }: { detail: TicketDetail }) {
  const words = clippedWords(detail.clipped)
  return words ? (
    <div className="eva-rv-dim eva-rv-small" role="note" data-testid="ticket-clipped">
      {words}
    </div>
  ) : null
}

export function Activity({
  data,
  focusCommentId,
}: {
  data: TicketData
  focusCommentId: string | null
}) {
  if (!data.detail) return null
  return <TicketActivity data={data} detail={data.detail} focusCommentId={focusCommentId} />
}

type Edit = (l: LocalEdits) => LocalEdits

/** An inline comment's place: the description's document, and for a new one its quote. */
interface Where {
  documentContentId?: string
  quotedText?: string
  anchor?: AnchorContext
}

/** A post on its way: where it goes and the exact body Linear gets. */
interface Post {
  parentId: string | null
  body: string
  where?: Where
}

/** A new inline comment being written: the selected words and the box's text. */
type InlineBox = InlineDraft & { text: string }

const copy = (text: string, message: string): void => {
  void navigator.clipboard.writeText(text).then(
    () => notifications.show({ message }),
    () => notifications.show({ message: 'Couldn’t copy it.', color: 'red' }),
  )
}

/** The comment Isaac just posted, shown until the host's ticket has it (its id is the opId). */
function postedComment(
  o: TicketOutcome,
  p: Post,
  me: TicketActor | null,
  d: TicketDetail,
): TicketComment {
  const where = p.where ?? {}
  return {
    id: o.result?.id ?? o.opId,
    parentId: p.parentId,
    documentContentId: where.documentContentId ?? null,
    quotedText: where.quotedText ?? null,
    ...(where.anchor && { anchor: where.anchor }),
    author: me,
    body: p.body,
    at: Date.now(),
    editedAt: null,
    resolvedAt: null,
    resolvingUser: null,
    reactions: [],
    url: o.result?.url ?? d.url,
  }
}

/** A reply in an inline thread goes to the same description document (Linear's contract). */
const replyWhere = (root: TicketComment): Where | undefined =>
  root.documentContentId === null ? undefined : { documentContentId: root.documentContentId }

/**
 * Comment, reply and every comment action: the gate writes (one lifecycle for posts, one for the
 * rest), the legacy post, and this visit's local edits applied after each landed write.
 */
function useActivityWrites(data: TicketData, detail: TicketDetail, me: TicketActor | null) {
  const [local, setLocal] = useState<LocalEdits>(NO_EDITS)
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<{ rootId: string; text: string } | null>(null)
  const [inline, setInline] = useState<InlineBox | null>(null)
  const [legacy, setLegacy] = useState<Post | null>(null)
  const [legacyBusy, setLegacyBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [pendingPost, setPendingPost] = useState<Post | null>(null)
  const [pendingAct, setPendingAct] = useState<{ m: TicketMutation; edit: Edit } | null>(null)
  const refresh = data.refresh

  const clear = useCallback((p: Post) => {
    if (p.where?.quotedText) setInline(null)
    else if (p.parentId) setReply(null)
    else setDraft('')
  }, [])
  const post = useTicketMutation(data.me.linearViewerId, (o) => {
    if (!pendingPost) return
    setLocal((l) => ({ ...l, posted: [...l.posted, postedComment(o, pendingPost, me, detail)] }))
    clear(pendingPost)
    refresh()
  })
  const act = useTicketMutation(data.me.linearViewerId, () => {
    if (pendingAct) setLocal(pendingAct.edit)
    setEditing(null)
    refresh()
  })
  const write = (m: TicketMutation, edit: Edit): void => {
    setPendingAct({ m, edit })
    act.run(m)
  }

  const postPublic = (p: Post): void => {
    if (data.writeMode === 'gate') {
      setPendingPost(p)
      const parent = p.parentId ? { parentId: p.parentId } : {}
      post.run({ kind: 'comment', issueId: detail.id, body: p.body, ...parent, ...p.where })
    } else if (data.writeMode === 'legacy') setLegacy(p)
  }
  const confirmLegacy = async (): Promise<void> => {
    if (!legacy) return
    setLegacyBusy(true)
    const ok = await postLegacyComment({
      issueId: detail.id,
      parentId: legacy.parentId,
      body: legacy.body,
    })
    setLegacyBusy(false)
    setLegacy(null)
    if (!ok) return
    clear(legacy)
    refresh()
  }
  return {
    local,
    draft,
    setDraft,
    reply,
    setReply,
    inline,
    setInline,
    editing,
    setEditing,
    post,
    pendingPost,
    pendingAct,
    act,
    write,
    postPublic,
    clear,
    legacy,
    legacyBusy,
    setLegacy,
    confirmLegacy,
  }
}

type Writes = ReturnType<typeof useActivityWrites>

/** What a comment's "..." menu does. */
function actionHandlers(
  w: Writes,
  thread: Thread,
  onNewIssue: (c: TicketComment) => void,
): (c: TicketComment, a: CommentAction) => void {
  return (c, a) => {
    const run: Record<CommentAction, () => void> = {
      edit: () => w.setEditing(c.id),
      resolve: () =>
        w.write({ kind: 'resolve', rootId: c.id, on: true }, (l) => ({
          ...l,
          resolved: { ...l.resolved, [c.id]: true },
        })),
      unresolve: () =>
        w.write({ kind: 'resolve', rootId: c.id, on: false }, (l) => ({
          ...l,
          resolved: { ...l.resolved, [c.id]: false },
        })),
      copyLink: () => copy(c.url, 'Link copied.'),
      copyMarkdown: () => copy(c.body, 'Copied as Markdown.'),
      newIssue: () => onNewIssue(c),
      delete: () =>
        w.write(
          {
            kind: 'deleteComment',
            commentId: c.id,
            replyCount: c.id === thread.root.id ? thread.replies.length : 0,
          },
          (l) => ({ ...l, deleted: [...l.deleted, c.id] }),
        ),
    }
    run[a]()
  }
}

/** The delete confirm's words: a root's delete takes its replies, and says so. */
function deleteConfirm(
  m: TicketMutation | undefined,
  comments: readonly TicketComment[],
): { note: string; body: string } | null {
  if (m?.kind !== 'deleteComment') return null
  const n = m.replyCount
  const replies = n === 0 ? '' : ` This also deletes its ${n} ${n === 1 ? 'reply' : 'replies'}.`
  const body = comments.find((c) => c.id === m.commentId)?.body ?? ''
  return { note: `Deletes it from Linear for everyone.${replies}`, body }
}

/** A private assistant thread and whose session it is. */
interface PrivateThread {
  session: AssistantSession
  thread: AstraThread
}

/** Private threads by the Linear thread they were asked in; the rest stand on their own. */
function splitPrivate(
  sessions: readonly AssistantSession[],
  rootIds: ReadonlySet<string>,
): { byRoot: Map<string, PrivateThread[]>; loose: PrivateThread[] } {
  const byRoot = new Map<string, PrivateThread[]>()
  const loose: PrivateThread[] = []
  for (const session of sessions) {
    for (const thread of session.threads) {
      const rootId = askedIn(thread.root.text).rootId
      if (rootId && rootIds.has(rootId))
        byRoot.set(rootId, [...(byRoot.get(rootId) ?? []), { session, thread }])
      else loose.push({ session, thread })
    }
  }
  return { byRoot, loose }
}

interface ThreadCtx {
  detail: TicketDetail
  data: TicketData
  w: Writes
  now: number
  people: Person[]
  mentionable: Person[]
  flash: string | null
  anchor: (id: string) => (el: HTMLDivElement | null) => void
  expanded: ReadonlySet<string>
  expand: (rootId: string) => void
  send: (text: string, thread: Thread | null) => void
  busy: boolean
  onNewIssue: (c: TicketComment) => void
  /** The private assistant threads asked in this Linear thread. */
  privateOf: (rootId: string) => readonly PrivateThread[]
}

function ThreadView({ thread, ctx }: { thread: Thread; ctx: ThreadCtx }) {
  const { w, data, detail } = ctx
  const root = thread.root
  const onAction = actionHandlers(w, thread, ctx.onNewIssue)
  const quote = (text: string): void =>
    w.setReply((r) => ({
      rootId: root.id,
      text: `${r?.rootId === root.id ? r.text : ''}${quoteOf(text)}`,
    }))
  if (root.resolvedAt !== null && !ctx.expanded.has(root.id)) {
    return (
      <ResolvedRow root={root} count={thread.replies.length} onShow={() => ctx.expand(root.id)} />
    )
  }
  const block = (c: TicketComment, isRoot: boolean): ReactNode => (
    <CommentBlock
      key={c.id}
      c={c}
      now={ctx.now}
      people={ctx.people}
      meId={data.me.linearViewerId}
      actions={commentActions(c, {
        meId: data.me.linearViewerId,
        isRoot,
        writeMode: data.writeMode,
      })}
      onAction={(a) => onAction(c, a)}
      onReply={
        isRoot && data.writeMode !== 'none'
          ? () => w.setReply((r) => (r?.rootId === root.id ? r : { rootId: root.id, text: '' }))
          : undefined
      }
      onQuote={quote}
      canReact={data.writeMode === 'gate'}
      onReact={(emoji, on) =>
        w.write({ kind: 'react', commentId: c.id, emoji, on }, (l) => ({
          ...l,
          reacted: { ...l.reacted, [reactionKey(c.id, emoji)]: on },
        }))
      }
      editing={w.editing === c.id}
      editBusy={w.act.view.kind === 'committing'}
      onSaveEdit={(body) =>
        w.write({ kind: 'editComment', commentId: c.id, body }, (l) => ({
          ...l,
          edited: { ...l.edited, [c.id]: body },
        }))
      }
      onCancelEdit={() => w.setEditing(null)}
      flash={ctx.flash === c.id}
      anchor={ctx.anchor(c.id)}
    />
  )
  const replying = w.reply?.rootId === root.id ? w.reply : null
  const asked = ctx.privateOf(root.id)
  return (
    <div className="eva-rv-lthread" data-testid="ticket-thread" data-root-id={root.id}>
      {block(root, true)}
      {replying || thread.replies.length + asked.length > 0 ? (
        <div className="eva-rv-lreplies">
          {thread.replies.map((c) => block(c, false))}
          {asked.map((p) => (
            <AssistantReply
              key={`${p.session.agent}-${p.thread.id}`}
              session={p.session}
              thread={p.thread}
              now={ctx.now}
              me={data.me.name ?? 'You'}
            />
          ))}
          {replying ? (
            <Composer
              value={replying.text}
              onChange={(text) => w.setReply({ rootId: root.id, text })}
              people={ctx.mentionable}
              placeholder={`Reply to ${root.author?.name ?? 'this thread'}. Type @ to mention, @Astra to ask privately.`}
              target={`sends to Linear as a reply in this thread on ${detail.key}`}
              busy={ctx.busy}
              autoFocus
              onSend={() => ctx.send(replying.text, thread)}
              onCancel={() => w.setReply(null)}
              testid="ticket-reply-box"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ResolvedRow({
  root,
  count,
  onShow,
}: {
  root: TicketComment
  count: number
  onShow: () => void
}) {
  return (
    <div className="eva-tk-resolved" data-testid="ticket-thread-resolved" data-root-id={root.id}>
      <IconCircleCheckFilled size={14} className="eva-tk-resolved-icon" />
      <span className="eva-rv-dim eva-rv-ellipsis">
        {`Resolved thread · ${root.author?.name ?? 'Someone'}: ${root.body.replace(/\s+/g, ' ').slice(0, 80)}`}
        {count > 0 ? ` (${count} ${count === 1 ? 'reply' : 'replies'})` : ''}
      </span>
      <span className="eva-rv-spacer" />
      <Button size="compact-xs" variant="subtle" color="gray" onClick={onShow}>
        Show
      </Button>
    </div>
  )
}

/**
 * `#comment-<id>`: opens its thread when resolved, scrolls to it and flashes it once; a comment in
 * an inline thread opens that thread's popover on the description instead.
 */
function useFocus(
  threads: Thread[],
  inline: Thread[],
  focusCommentId: string | null,
  expand: (id: string) => void,
  openInline: (id: string) => void,
) {
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [flash, setFlash] = useState<string | null>(null)
  const target = focusTarget(threads, focusCommentId)
  const rootId = target?.rootId ?? null
  const commentId = target?.commentId ?? null
  const inlineRoot = focusTarget(inline, focusCommentId)?.rootId ?? null
  useEffect(() => {
    if (!rootId || !commentId) return
    expand(rootId)
    setFlash(commentId)
  }, [rootId, commentId, expand])
  useEffect(() => {
    if (inlineRoot) openInline(inlineRoot)
  }, [inlineRoot, openInline])
  useEffect(() => {
    if (flash) anchors.current.get(flash)?.scrollIntoView({ block: 'center' })
  }, [flash])
  const anchor = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) anchors.current.set(id, el)
      else anchors.current.delete(id)
    },
    [],
  )
  return { flash, anchor }
}

/** The confirm's title and button for what is posted. */
function postWords(post: Post | null): { title: string; label: string } {
  const reply = post?.parentId != null
  const what = post?.where?.quotedText ? 'inline comment' : reply ? 'reply' : 'comment'
  return { title: `Post this ${what} on Linear?`, label: reply ? 'Post reply' : 'Post comment' }
}

/**
 * The exact-text confirm of a comment, reply or inline comment. Gate: the host's approval in full
 * (its text, the quote, the summary naming the ticket and account); legacy: Isaac's own text.
 */
function PostConfirm({
  post,
  approval,
  busy,
  ticketKey,
  onConfirm,
  onCancel,
}: {
  post: Post | null
  approval: TicketConfirm | null
  busy: boolean
  ticketKey: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const words = postWords(post)
  const quoted = post?.where?.quotedText
  return (
    <ConfirmPost
      opened={post !== null}
      title={words.title}
      text={approval?.text ?? post?.body ?? ''}
      note={
        approval ? (
          <ApprovalNote approval={approval} />
        ) : (
          <>
            {quoted ? <div>{`On “${quoted}”`}</div> : null}
            <div>{`Posts as you on ${ticketKey}. Everyone on the ticket sees it.`}</div>
          </>
        )
      }
      confirmLabel={words.label}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

/** Every confirm the activity asks: gate post, legacy post, delete (replies disclosed). */
function Confirms({ w, detail }: { w: Writes; detail: TicketDetail }) {
  const view = w.post.view
  const acting = w.act.view.kind === 'confirming' ? w.act.view.approval : null
  const deleting = acting ? deleteConfirm(w.pendingAct?.m, detail.comments) : null
  return (
    <>
      <PostConfirm
        post={view.kind === 'confirming' ? w.pendingPost : null}
        approval={view.kind === 'confirming' ? view.approval : null}
        busy={false}
        ticketKey={detail.key}
        onConfirm={w.post.confirm}
        onCancel={w.post.cancel}
      />
      <PostConfirm
        post={w.legacy}
        approval={null}
        busy={w.legacyBusy}
        ticketKey={detail.key}
        onConfirm={() => void w.confirmLegacy()}
        onCancel={() => w.setLegacy(null)}
      />
      <ConfirmPost
        opened={deleting !== null}
        title="Delete this comment?"
        text={acting?.text ?? deleting?.body ?? ''}
        note={
          <>
            <div>{deleting?.note ?? ''}</div>
            {acting ? <ApprovalNote approval={acting} /> : null}
          </>
        }
        confirmLabel="Delete"
        danger
        busy={false}
        onConfirm={w.act.confirm}
        onCancel={w.act.cancel}
      />
    </>
  )
}

/** Where a message goes: the thread it answers, or the description words it is about. */
interface Target {
  thread: Thread | null
  inline: InlineDraft | null
}

/** The comment Linear gets for a message to people. */
function publicPost(
  body: string,
  people: Person[],
  t: Target,
  documentContentId: string | null,
): Post {
  const text = linearBody(body, people)
  if (t.thread) return { parentId: t.thread.root.id, body: text, where: replyWhere(t.thread.root) }
  if (t.inline && documentContentId) {
    const { quote, anchor } = t.inline
    return { parentId: null, body: text, where: { documentContentId, quotedText: quote, anchor } }
  }
  return { parentId: null, body: text }
}

/** What a private ask sends: in a thread it carries the thread, on new words the quote. */
function privateAsk(body: string, t: Target): string {
  if (t.thread) return threadAsk(body, t.thread)
  return t.inline ? quoteAsk(body, t.inline.quote) : body
}

/**
 * Sends a message: to people, a comment through the gate (or legacy path); mentioning an assistant,
 * a private ask to each assistant mentioned and nothing else (DECISIONS 7). The box clears once
 * it went out.
 */
function useSend(
  w: Writes,
  detail: TicketDetail,
  people: Person[],
  sessions: readonly AssistantSession[],
) {
  return (text: string, t: Target): void => {
    const body = text.trim()
    if (!body) return
    const named = new Set(assistantsIn(body).map(agentOf))
    if (named.size === 0) {
      w.postPublic(publicPost(body, people, t, detail.documentContentId))
      return
    }
    const ask = privateAsk(body, t)
    const to = sessions.filter((s) => named.has(s.agent))
    void Promise.all(to.map((s) => s.ask(ask))).then((sent) => {
      if (!sent.every(Boolean)) return
      if (t.thread) w.setReply(null)
      else if (t.inline) w.setInline(null)
      else w.setDraft('')
    })
  }
}

/** The box of a new inline comment, in the description's popover. */
function InlineDraftBox({
  box,
  w,
  mentionable,
  ticketKey,
  busy,
  onSend,
}: {
  box: InlineBox
  w: Writes
  mentionable: Person[]
  ticketKey: string
  busy: boolean
  onSend: () => void
}) {
  return (
    <div className="eva-tk-inline-draft">
      <blockquote className="eva-tk-quoted">{box.quote}</blockquote>
      <Composer
        value={box.text}
        onChange={(text) => w.setInline((b) => (b ? { ...b, text } : b))}
        people={mentionable}
        placeholder="Comment on this text. Type @ to mention, @Astra to ask privately."
        target={`sends to ${ticketKey} as an inline comment`}
        busy={busy}
        autoFocus
        onSend={onSend}
        onCancel={() => w.setInline(null)}
        sendLabel="Comment"
        testid="inline-composer"
      />
    </div>
  )
}

function TicketActivity({
  data,
  detail,
  focusCommentId,
}: {
  data: TicketData
  detail: TicketDetail
  focusCommentId: string | null
}) {
  const now = Date.now()
  const meId = data.me.linearViewerId
  const me: TicketActor | null = meId
    ? { id: meId, name: data.me.name ?? 'You', avatarUrl: null }
    : null
  const w = useActivityWrites(data, detail, me)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [newIssue, setNewIssue] = useState<TicketComment | null>(null)
  const [openInline, setOpenInline] = useState<string | null>(null)
  const composer = useRef<HTMLDivElement>(null)
  const expand = useCallback(
    (id: string) => setExpanded((s) => (s.has(id) ? s : new Set(s).add(id))),
    [],
  )
  const showInline = useCallback(
    (id: string | null) => {
      if (id) expand(id)
      setOpenInline(id)
    },
    [expand],
  )
  const host = useInlineHost(detail.key)
  const all = threadsOf(withLocal(detail.comments, w.local, me, now))
  // Inline threads live on the description while it is on the page.
  const inline = host ? all.filter((t) => isInline(t.root)) : []
  const threads = all.filter((t) => !inline.includes(t))
  const { flash, anchor } = useFocus(threads, inline, focusCommentId, expand, showInline)
  const sessions = useAssistantSessions({
    url: detail.url,
    label: detail.key,
    context: () => detailContext(detail),
  })
  const people = peopleOf(detail)
  const mentionable = people.filter((p) => p.id !== meId)
  const priv = splitPrivate(sessions, new Set(all.map((t) => t.root.id)))
  const sessionOf = new Map(priv.loose.map((p) => [p.thread, p.session]))
  const timeline = mergeTimeline(threads, (t) => t.root.at, [...sessionOf.keys()])
  const posting = w.post.view.kind === 'preparing' || w.post.view.kind === 'committing'
  const busy = posting || sessions.some((s) => s.sending)
  const send = useSend(w, detail, people, sessions)
  const ctx: ThreadCtx = {
    detail,
    data,
    w,
    now,
    people,
    mentionable,
    flash,
    anchor,
    expanded,
    expand,
    send: (text, thread) => send(text, { thread, inline: null }),
    busy,
    onNewIssue: setNewIssue,
    privateOf: (rootId) => priv.byRoot.get(rootId) ?? [],
  }
  const quoteToComposer = (text: string): void => {
    w.setDraft((d) => `${d}${quoteOf(text)}`)
    composer.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    composer.current?.querySelector('textarea')?.focus()
  }

  return (
    <section className="eva-tk-activity" data-testid="ticket-activity">
      {host ? (
        <InlineThreads
          host={host}
          text={detail.description}
          threads={inline}
          canComment={data.writeMode === 'gate' && detail.documentContentId !== null}
          open={openInline}
          onOpen={showInline}
          draft={w.inline}
          onDraft={(d) => w.setInline(d ? { ...d, text: '' } : null)}
          renderThread={(t) => <ThreadView thread={t} ctx={ctx} />}
          renderDraft={() =>
            w.inline ? (
              <InlineDraftBox
                box={w.inline}
                w={w}
                mentionable={mentionable}
                ticketKey={detail.key}
                busy={busy}
                onSend={() => w.inline && send(w.inline.text, { thread: null, inline: w.inline })}
              />
            ) : null
          }
          onQuote={quoteToComposer}
        />
      ) : null}
      <h3 className="eva-tk-activity-head">Activity</h3>
      {timeline.length === 0 ? <div className="eva-rv-dim">No comments yet.</div> : null}
      {timeline.map((e) => {
        const session = e.kind === 'astra' ? sessionOf.get(e.thread) : undefined
        if (e.kind === 'comment')
          return <ThreadView key={e.item.root.id} thread={e.item} ctx={ctx} />
        return session ? (
          <AssistantReply
            key={`${session.agent}-${e.thread.id}`}
            session={session}
            thread={e.thread}
            now={now}
            me={data.me.name ?? 'You'}
          />
        ) : null
      })}
      <MutationNotice view={w.act.view} onRetry={w.act.retry} onDismiss={w.act.cancel} />
      <AskNotices sessions={sessions} />
      {data.writeMode === 'none' ? null : (
        <div className="eva-tk-composer" data-ticket-composer ref={composer}>
          <Composer
            value={w.draft}
            onChange={w.setDraft}
            people={mentionable}
            placeholder="Leave a comment. Type @ to mention, @Astra to ask privately."
            target={`sends to ${detail.key} as a new comment`}
            busy={busy}
            onSend={() => send(w.draft, { thread: null, inline: null })}
            testid="ticket-composer"
          />
          <MutationNotice view={w.post.view} onRetry={w.post.retry} onDismiss={w.post.cancel} />
        </div>
      )}
      <Confirms w={w} detail={detail} />
      <NewIssueModal
        comment={newIssue}
        detail={detail}
        viewerId={data.me.linearViewerId}
        onClose={() => setNewIssue(null)}
        onCreated={notifyCreated}
      />
    </section>
  )
}
