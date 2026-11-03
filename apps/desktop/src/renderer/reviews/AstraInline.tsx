import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Textarea } from '@mantine/core'
import {
  IconArrowBackUp,
  IconExternalLink,
  IconLock,
  IconPlayerStopFilled,
  IconTool,
} from '@tabler/icons-react'
import { astraItemUrl, type AstraItem, type AstraTurn } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { invoke, on } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { Markdown } from '../chat/markdown/Markdown'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { agoPhrase } from './review-model'
import { Avatar, fail } from './review-ui'
import { astraThreads, showsTyping, type AstraBlock, type AstraThread } from './astra-timeline'

/** An ask on its way to main: shown at once as Isaac's turn, with her typing slot after it. */
interface Sending {
  id: string
  text: string
  at: number
}

/**
 * An item's Astra session as Reviews holds it: loaded on open, kept current from main's updates,
 * and `ask` to start or continue it. `context` is read only when the ask starts the session.
 * `threads` already carries an ask still on its way, so it and her typing show right away.
 */
export function useAstraItem(url: string): {
  item: AstraItem | null
  threads: AstraThread[]
  asking: boolean
  ask: (text: string, label: string, context: () => string) => Promise<boolean>
} {
  const [item, setItem] = useState<AstraItem | null>(null)
  const [sending, setSending] = useState<Sending | null>(null)
  useEffect(() => {
    let live = true
    setItem(null)
    void invoke('reviews.astraThread', { url }).then((r) => {
      if (live && r.ok) setItem(r.value)
    })
    const off = on('reviews.astraUpdate', (s) => {
      // Main keeps a Linear ticket's session under its key, whichever link opened it.
      if (s.url === astraItemUrl(url)) setItem(s)
    })
    return () => {
      live = false
      off()
    }
  }, [url])
  const ask = useCallback(
    async (text: string, label: string, context: () => string): Promise<boolean> => {
      setSending({ id: `sending-${Date.now()}`, text, at: Date.now() })
      const r = await invoke('reviews.astraAsk', {
        url,
        label,
        // Only the first ask seeds the session; a follow-up sends the question alone.
        context: item?.file ? '' : context(),
        text,
      })
      setSending(null)
      if (!r.ok) {
        fail("Couldn't reach Astra", r.error.message)
        return false
      }
      setItem(r.value)
      return true
    },
    [url, item?.file],
  )
  const turns: AstraTurn[] = [
    ...(item?.turns ?? []),
    ...(sending
      ? [
          {
            id: sending.id,
            role: 'user' as const,
            text: sending.text,
            streaming: false,
            at: sending.at,
          },
        ]
      : []),
  ]
  const pending =
    sending !== null ||
    (item !== null && (item.working || item.waiting !== null || item.error !== null))
  return { item, threads: astraThreads(turns, pending), asking: sending !== null, ask }
}

/** Which surface's comment thread an Astra thread dresses as. */
export type AstraCardLook = 'linear' | 'slack' | 'pr'

const LOOK: Record<AstraCardLook, { thread: string; card: string; body: string }> = {
  linear: { thread: 'eva-rv-lthread', card: 'eva-rv-lcomment', body: 'eva-rv-lcomment-body' },
  slack: { thread: 'eva-rv-athread', card: 'eva-rv-smsg', body: 'eva-rv-smsg-body' },
  pr: { thread: 'eva-rv-athread eva-rv-athread-pr', card: 'eva-rv-acomment', body: '' },
}

function Private({ title }: { title?: string }) {
  return (
    <span className="eva-rv-astra-private" title={title ?? 'Only you see this; it is never posted'}>
      <IconLock size={11} /> Private
    </span>
  )
}

/** Three dots that pulse while Astra writes, in a message bubble. */
export function TypingDots() {
  return (
    <span
      className="eva-rv-typing"
      role="status"
      aria-label="Astra is typing"
      data-testid="review-astra-typing"
    >
      <span />
      <span />
      <span />
    </span>
  )
}

/** One comment of a thread in the surface's own card: Slack's avatar-beside rows, else head over body. */
function Post({
  look,
  face,
  name,
  subtitle,
  when,
  body,
  testid,
  role,
}: {
  look: AstraCardLook
  face: ReactNode
  name: string
  subtitle?: string
  when: ReactNode
  body: ReactNode
  testid: string
  role: 'ask' | 'reply'
}) {
  const { card, body: bodyClass } = LOOK[look]
  const head = (
    <div className="eva-rv-comment-head">
      {look === 'slack' ? null : face}
      <b>{name}</b>
      {subtitle ? <span className="eva-rv-dim">{subtitle}</span> : null}
      {when}
      <span className="eva-rv-spacer" />
      <Private />
    </div>
  )
  if (look === 'slack') {
    return (
      <div className={`${card} eva-rv-astra-card`} data-astra={role} data-testid={testid}>
        <div className="eva-rv-smsg-row">
          <span className="eva-rv-savatar">{face}</span>
          <div className="eva-rv-smsg-main">
            {head}
            <div className={bodyClass}>{body}</div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={`${card} eva-rv-astra-card`} data-astra={role} data-testid={testid}>
      {head}
      <div className={bodyClass}>{body}</div>
    </div>
  )
}

/**
 * Astra's reply in a thread: her answers as Markdown (widgets included) growing while they stream,
 * tool calls as one quiet line, her typing dots while she works with no text streaming yet. Use
 * as reply puts her answer in the item's comment box (posting still asks first); Open session
 * shows the session in the chat view; Stop ends her running turn.
 */
function AstraReply({
  block,
  item,
  newest,
  busy,
  asking,
  look,
  when,
  onUseAsReply,
}: {
  block: Extract<AstraBlock, { kind: 'reply' }>
  item: AstraItem | null
  /** The session's newest reply: it carries her working, waiting and error state. */
  newest: boolean
  busy: boolean
  /** An ask of his is on its way to her. */
  asking: boolean
  look: AstraCardLook
  when: ReactNode
  onUseAsReply: (text: string) => void
}) {
  const open = async (): Promise<void> => {
    if (!item?.file) return
    // An idle process lets go first, so the chat view takes the session over cleanly.
    await invoke('reviews.astraRelease', { url: item.url })
    openPlace(placeOf('chat', { chat: item.file }))
  }
  const stop = async (): Promise<void> => {
    if (!item) return
    const r = await invoke('reviews.astraStop', { url: item.url })
    if (!r.ok) fail("Couldn't stop Astra", r.error.message)
  }
  const answer = block.turns.filter((t) => t.role === 'assistant').at(-1)
  const working = newest && item?.working === true
  const typing = newest && showsTyping(block, asking || working)
  const done = !(newest && busy)
  return (
    <Post
      look={look}
      role="reply"
      testid="review-astra"
      face={<AgentPortrait id="astra" className="eva-rv-astra-face" />}
      name="Astra"
      subtitle="AI assistant"
      when={when}
      body={
        <div className="eva-rv-astra-a">
          {block.turns.map((t) =>
            t.role === 'tool' ? (
              <div key={t.id} className="eva-rv-astra-tool eva-rv-dim eva-rv-small">
                <IconTool size={11} />
                <span className="eva-rv-ellipsis">{t.text.split('\n', 1)[0]}</span>
              </div>
            ) : t.text.trim() ? (
              <div key={t.id} className="eva-rv-astra-answer" data-testid="review-astra-answer">
                <Markdown text={t.text} />
              </div>
            ) : null,
          )}
          {typing ? <TypingDots /> : null}
          {newest && item?.waiting ? (
            <div className="eva-rv-astra-wait">
              {item.waiting}: answer it on your phone or in the session.
            </div>
          ) : null}
          {newest && item?.error ? (
            <div className="eva-rv-error eva-rv-small">{item.error}</div>
          ) : null}
          {done || working ? (
            <div className="eva-rv-astra-actions">
              {answer && !answer.streaming && done ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconArrowBackUp size={12} />}
                  onClick={() => onUseAsReply(answer.text)}
                  data-testid="review-astra-use"
                >
                  Use as reply
                </Button>
              ) : null}
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconExternalLink size={12} />}
                disabled={!item?.file}
                onClick={() => void open()}
                data-testid="review-astra-open"
              >
                Open session
              </Button>
              {working ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  leftSection={<IconPlayerStopFilled size={11} />}
                  onClick={() => void stop()}
                  data-testid="review-astra-stop"
                >
                  Stop
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  )
}

/** The reply box under a private thread: whatever is typed goes to Astra in this thread, never posted. */
function ThreadReplyBox({
  busy,
  onSend,
}: {
  busy: boolean
  onSend: (text: string) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const send = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    if (await onSend(t)) setText('')
  }
  return (
    <div className="eva-rv-athread-reply" data-testid="review-astra-thread-reply">
      <Textarea
        autosize
        minRows={1}
        maxRows={8}
        size="sm"
        value={text}
        placeholder="Reply to Astra"
        aria-label="Reply to Astra"
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send()
          }
        }}
        data-testid="review-astra-thread-input"
      />
      {text.trim() ? (
        <div className="eva-rv-composer-foot">
          <span className="eva-rv-dim eva-rv-small">
            <IconLock size={11} /> Private to Astra, never posted · Cmd+Enter
          </span>
          <span className="eva-rv-spacer" />
          <Button size="xs" variant="subtle" disabled={busy} onClick={() => void send()}>
            Reply
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One private Astra thread in an item's timeline, dressed as that surface's own thread: Isaac's
 * @Astra comment as the root (his card, marked Private), the replies indented under it (his as
 * his comments, hers with her portrait, "Astra" and "AI assistant"), and the thread's own reply
 * box, whose text goes to the same item session with no @Astra needed. Nothing here is posted.
 */
export function AstraThreadView({
  thread,
  item,
  newest,
  busy,
  asking,
  now,
  look,
  me = 'Isaac',
  onReply,
  onUseAsReply,
}: {
  thread: AstraThread
  item: AstraItem | null
  /** This thread holds the session's newest ask (her working state shows in it). */
  newest: boolean
  /** She is working, waiting or failed, or an ask is on its way. */
  busy: boolean
  asking: boolean
  now: number
  look: AstraCardLook
  me?: string
  /** Sends a reply typed in this thread to Astra (the surface adds the thread's naming line). */
  onReply: (root: string, text: string) => Promise<boolean>
  onUseAsReply: (text: string) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const last = thread.replies.at(-1)
  const size =
    thread.replies.length * 1_000_000 +
    (last?.kind === 'reply' ? last.turns.reduce((n, t) => n + t.text.length, 0) : 0)
  useEffect(() => {
    if (newest) end.current?.scrollIntoView({ block: 'nearest' })
  }, [newest, size])
  const when = (at: number | undefined) =>
    at === undefined ? null : <span className="eva-rv-dim">{agoPhrase(at, now)}</span>
  const mine = (turn: AstraTurn, testid: string, role: 'ask' | 'reply') => (
    <Post
      look={look}
      role={role}
      testid={testid}
      face={<Avatar login={me} />}
      name={me}
      when={when(turn.at)}
      body={<div className="eva-rv-astra-q">{turn.text}</div>}
    />
  )
  return (
    <div className={LOOK[look].thread} data-testid="review-astra-thread">
      {mine(thread.root, 'review-astra-question', 'ask')}
      <div className="eva-rv-lreplies">
        {thread.replies.map((b) =>
          b.kind === 'ask' ? (
            <div key={b.id}>{mine(b.turn, 'review-astra-thread-ask', 'reply')}</div>
          ) : (
            <AstraReply
              key={b.id}
              block={b}
              item={item}
              newest={newest && b === last}
              busy={busy}
              asking={asking}
              look={look}
              when={when(b.at)}
              onUseAsReply={onUseAsReply}
            />
          ),
        )}
        <ThreadReplyBox busy={asking} onSend={(text) => onReply(thread.root.text, text)} />
        <div ref={end} />
      </div>
    </div>
  )
}

/**
 * All of an item's private threads at their place in a timeline: renders `thread` with what the
 * whole session knows (whether it is the newest, her busy state).
 */
export function threadPropsOf(astra: ReturnType<typeof useAstraItem>) {
  const busy =
    astra.asking ||
    (astra.item !== null &&
      (astra.item.working || astra.item.waiting !== null || astra.item.error !== null))
  return (thread: AstraThread) => ({
    thread,
    item: astra.item,
    newest: thread.newest === true,
    busy,
    asking: astra.asking,
  })
}
