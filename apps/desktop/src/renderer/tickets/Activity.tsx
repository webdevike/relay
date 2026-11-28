// The ticket page's description and activity (PLAN T2.5): comment threads by root id with their
// reactions and "..." menus, private assistant threads at their place in time, a reply box per
// thread and the composer. People comments go through the host's gate (`comment`, exact-text
// confirm), the legacy `reviews.linearComment` path (writeMode legacy) or are hidden (none); a
// message to an assistant stays private in Relay (`useAstraItem().ask`), never through the gate.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconCircleCheckFilled } from '@tabler/icons-react'
import type {
  TicketActor,
  TicketComment,
  TicketDetail,
  TicketMutation,
  TicketOutcome,
} from '@relay/protocol'
import { AstraThreadView, threadPropsOf, useAstraItem } from '../reviews/AstraInline'
import { mergeTimeline, threadReplyText } from '../reviews/astra-timeline'
import {
  NO_EDITS,
  commentActions,
  detailContext,
  focusTarget,
  peopleOf,
  privacyOf,
  reactionKey,
  threadsOf,
  withLocal,
  type CommentAction,
  type LocalEdits,
  type Person,
  type Thread,
} from './activity-model'
import { CommentBlock, CommentMarkdown } from './CommentBlock'
import {
  Composer,
  ConfirmPost,
  MutationNotice,
  linearBody,
  postLegacyComment,
  quoteOf,
} from './Composer'
import { NewIssueModal, notifyCreated } from './NewIssueModal'
import type { TicketData } from './ticket-data'
import { useTicketMutation } from './use-mutation'
import '../reviews/reviews.css'
import './activity.css'

/** The ticket's description as Markdown (images at their width, mentions as pills). */
export function TicketDescription({ data }: { data: TicketData }) {
  const d = data.detail
  if (!d) return null
  return (
    <div className="eva-tk-description" data-testid="ticket-description">
      {d.description.trim() ? (
        <CommentMarkdown text={d.description} people={peopleOf(d)} />
      ) : (
        <span className="eva-rv-dim">No description.</span>
      )}
    </div>
  )
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

/** A post on its way: where it goes and the exact body Linear gets. */
interface Post {
  parentId: string | null
  body: string
}

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
  return {
    id: o.result?.id ?? o.opId,
    parentId: p.parentId,
    documentContentId: null,
    quotedText: null,
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

/**
 * Comment, reply and every comment action: the gate writes (one lifecycle for posts, one for the
 * rest), the legacy post, and this visit's local edits applied after each landed write.
 */
function useActivityWrites(data: TicketData, detail: TicketDetail, me: TicketActor | null) {
  const [local, setLocal] = useState<LocalEdits>(NO_EDITS)
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<{ rootId: string; text: string } | null>(null)
  const [legacy, setLegacy] = useState<Post | null>(null)
  const [legacyBusy, setLegacyBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [pendingPost, setPendingPost] = useState<Post | null>(null)
  const [pendingAct, setPendingAct] = useState<{ m: TicketMutation; edit: Edit } | null>(null)
  const refresh = data.refresh

  const clear = useCallback((p: Post) => {
    if (p.parentId) setReply(null)
    else setDraft('')
  }, [])
  const post = useTicketMutation((o) => {
    if (!pendingPost) return
    setLocal((l) => ({ ...l, posted: [...l.posted, postedComment(o, pendingPost, me, detail)] }))
    clear(pendingPost)
    refresh()
  })
  const act = useTicketMutation(() => {
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
      post.run({ kind: 'comment', issueId: detail.id, body: p.body, ...parent })
    } else if (data.writeMode === 'legacy') setLegacy(p)
  }
  const confirmLegacy = async (): Promise<void> => {
    if (!legacy) return
    setLegacyBusy(true)
    const ok = await postLegacyComment({ issueId: detail.id, ...legacy })
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
    editing,
    setEditing,
    post,
    pendingPost,
    pendingAct,
    act,
    write,
    postPublic,
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
  send: (text: string, root: TicketComment | null) => void
  busy: boolean
  onNewIssue: (c: TicketComment) => void
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
  return (
    <div className="eva-rv-lthread" data-testid="ticket-thread" data-root-id={root.id}>
      {block(root, true)}
      {thread.replies.length > 0 || replying ? (
        <div className="eva-rv-lreplies">
          {thread.replies.map((c) => block(c, false))}
          {replying ? (
            <Composer
              value={replying.text}
              onChange={(text) => w.setReply({ rootId: root.id, text })}
              people={ctx.mentionable}
              placeholder={`Reply to ${root.author?.name ?? 'this thread'}. Type @ to mention, @Astra to ask privately.`}
              target={`sends to Linear as a reply in this thread on ${detail.key}`}
              busy={ctx.busy}
              autoFocus
              onSend={() => ctx.send(replying.text, root)}
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

/** `#comment-<id>`: opens its thread when resolved, scrolls to it and flashes it once. */
function useFocus(threads: Thread[], focusCommentId: string | null, expand: (id: string) => void) {
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [flash, setFlash] = useState<string | null>(null)
  const target = focusTarget(threads, focusCommentId)
  const rootId = target?.rootId ?? null
  const commentId = target?.commentId ?? null
  useEffect(() => {
    if (!rootId || !commentId) return
    expand(rootId)
    setFlash(commentId)
  }, [rootId, commentId, expand])
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

/** The exact-text confirm of a comment or reply (gate: with the host's summary). */
function PostConfirm({
  post,
  summary,
  busy,
  ticketKey,
  onConfirm,
  onCancel,
}: {
  post: Post | null
  summary: string | null
  busy: boolean
  ticketKey: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const reply = post?.parentId != null
  return (
    <ConfirmPost
      opened={post !== null}
      title={reply ? 'Post this reply on Linear?' : 'Post this comment on Linear?'}
      text={post?.body ?? ''}
      note={
        <>
          {summary ? <div>{summary}</div> : null}
          <div>{`Posts as you on ${ticketKey}. Everyone on the ticket sees it.`}</div>
        </>
      }
      confirmLabel={reply ? 'Post reply' : 'Post comment'}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

/** Every confirm the activity asks: gate post, legacy post, delete (replies disclosed). */
function Confirms({ w, detail }: { w: Writes; detail: TicketDetail }) {
  const view = w.post.view
  const deleting =
    w.act.view.kind === 'confirming' ? deleteConfirm(w.pendingAct?.m, detail.comments) : null
  return (
    <>
      <PostConfirm
        post={view.kind === 'confirming' ? w.pendingPost : null}
        summary={view.kind === 'confirming' ? view.summary : null}
        busy={false}
        ticketKey={detail.key}
        onConfirm={w.post.confirm}
        onCancel={w.post.cancel}
      />
      <PostConfirm
        post={w.legacy}
        summary={null}
        busy={w.legacyBusy}
        ticketKey={detail.key}
        onConfirm={() => void w.confirmLegacy()}
        onCancel={() => w.setLegacy(null)}
      />
      <ConfirmPost
        opened={deleting !== null}
        title="Delete this comment?"
        text={deleting?.body ?? ''}
        note={deleting?.note ?? ''}
        confirmLabel="Delete"
        danger
        busy={false}
        onConfirm={w.act.confirm}
        onCancel={w.act.cancel}
      />
    </>
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
  const expand = useCallback(
    (id: string) => setExpanded((s) => (s.has(id) ? s : new Set(s).add(id))),
    [],
  )
  const threads = threadsOf(withLocal(detail.comments, w.local, me, now))
  const { flash, anchor } = useFocus(threads, focusCommentId, expand)
  const astra = useAstraItem(detail.url)
  const people = peopleOf(detail)
  const mentionable = people.filter((p) => p.id !== meId)
  const timeline = mergeTimeline(threads, (t) => t.root.at, astra.threads)
  const threadProps = threadPropsOf(astra)
  const busy = astra.asking || w.post.view.kind === 'preparing' || w.post.view.kind === 'committing'

  const send = (text: string, root: TicketComment | null): void => {
    const body = text.trim()
    if (!body) return
    if (privacyOf(body, people) === 'public') {
      w.postPublic({ parentId: root?.id ?? null, body: linearBody(body, people) })
      return
    }
    // An assistant is mentioned: a private ask in Relay; nothing is posted.
    const about = root
      ? `(about ${root.author?.name ?? 'a'}'s comment: "${root.body.slice(0, 300)}") `
      : ''
    void astra
      .ask(`${about}${body}`, detail.key, () => detailContext(detail))
      .then((ok) => {
        if (!ok) return
        if (root) w.setReply(null)
        else w.setDraft('')
      })
  }
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
    send,
    busy,
    onNewIssue: setNewIssue,
  }

  return (
    <section className="eva-tk-activity" data-testid="ticket-activity">
      <h3 className="eva-tk-activity-head">Activity</h3>
      {timeline.length === 0 ? <div className="eva-rv-dim">No comments yet.</div> : null}
      {timeline.map((e) =>
        e.kind === 'astra' ? (
          <AstraThreadView
            key={`astra-${e.thread.id}`}
            {...threadProps(e.thread)}
            now={now}
            look="linear"
            me={data.me.name ?? 'You'}
            onReply={(root, text) =>
              astra.ask(threadReplyText(root, text), detail.key, () => detailContext(detail))
            }
            onUseAsReply={w.setDraft}
          />
        ) : (
          <ThreadView key={e.item.root.id} thread={e.item} ctx={ctx} />
        ),
      )}
      <MutationNotice view={w.act.view} onRetry={w.act.retry} onDismiss={w.act.cancel} />
      {data.writeMode === 'none' ? null : (
        <div className="eva-tk-composer" data-ticket-composer>
          <Composer
            value={w.draft}
            onChange={w.setDraft}
            people={mentionable}
            placeholder="Leave a comment. Type @ to mention, @Astra to ask privately."
            target={`sends to ${detail.key} as a new comment`}
            busy={busy}
            onSend={() => send(w.draft, null)}
            testid="ticket-composer"
          />
          <MutationNotice view={w.post.view} onRetry={w.post.retry} onDismiss={w.post.cancel} />
        </div>
      )}
      <Confirms w={w} detail={detail} />
      <NewIssueModal
        comment={newIssue}
        detail={detail}
        onClose={() => setNewIssue(null)}
        onCreated={notifyCreated}
      />
    </section>
  )
}
