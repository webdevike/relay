/**
 * Comment pins on the Canvas page, drawn like a live room's (Figma style): a pin sits on the card it
 * was left on (it follows the card) or on a board spot, at screen size whatever the zoom. A pin
 * opens its thread in a popover: the messages, a reply field, Resolve, and a quiet "Ask Nova" that
 * starts a live session on the board and hands the thread over. A new comment is a draft pin with
 * just the field; Enter saves it into the board file.
 */
import { Button, Textarea } from '@mantine/core'
import { IconCheck, IconMessageCircle, IconSparkles } from '@tabler/icons-react'
import { useStore } from '@xyflow/react'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import type { CanvasThread } from '@evaos/contract'
import { EvaPopover } from '../overlay'
import { ago, awaitingAnswer, excerpt, pinPoint, type Anchor, type Box } from './comment-model'

/** The assistant the page asks (its name on the button). */
export const ASK_NAME = 'Nova'

export interface CommentsProps {
  threads: readonly CanvasThread[]
  /** Every card's box in board space. */
  boxes: ReadonlyMap<string, Box>
  /** A comment being written (no thread yet): its pin and the field. */
  draft: Anchor | null
  openId: string | null
  onOpen: (id: string | null) => void
  /** Saves the draft as a new thread. Rejects with the reason it could not. */
  onStart: (text: string) => Promise<void>
  onCancelDraft: () => void
  onReply: (thread: string, text: string) => Promise<void>
  onResolve: (thread: string, resolved: boolean) => void
  /** Starts a session on the board and hands `thread` to Nova; resolves with why not, else null. */
  onAsk: (thread: string) => Promise<string | null>
}

function Face({ name, color }: { name: string; color: string }) {
  return (
    <span className="eva-cv-face" style={{ background: color }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** The reply (or first comment) field: Enter sends, Shift+Enter breaks the line, Escape is the popover's. */
function Composer({
  label,
  placeholder,
  send,
  testid,
}: {
  label: string
  placeholder: string
  send: (text: string) => Promise<void>
  testid: string
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    const body = text.trim()
    if (body === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await send(body)
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const keys = (e: KeyboardEvent): void => {
    // The board's own keys (Delete removes the selection, `/` opens a comment) stay out of the field.
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }
  return (
    <div className="eva-cv-composer">
      <Textarea
        autoFocus
        autosize
        minRows={1}
        maxRows={5}
        size="xs"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        maxLength={4000}
        className="eva-cv-composer-field"
        data-testid={`${testid}-input`}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={keys}
        error={error}
        disabled={busy}
      />
      <Button
        size="compact-xs"
        data-testid={`${testid}-send`}
        disabled={text.trim() === '' || busy}
        loading={busy}
        onClick={() => void submit()}
      >
        Send
      </Button>
    </div>
  )
}

function ThreadBody({
  thread,
  onReply,
  onResolve,
  onAsk,
}: {
  thread: CanvasThread
  onReply: CommentsProps['onReply']
  onResolve: CommentsProps['onResolve']
  onAsk: CommentsProps['onAsk']
}) {
  const [asking, setAsking] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const ask = async (): Promise<void> => {
    setAsking(true)
    setRefusal(null)
    const why = await onAsk(thread.id)
    // On success the board gives way to the live room; only a refusal is left to say.
    setAsking(false)
    setRefusal(why)
  }
  return (
    <div className="eva-cv-thread" data-testid="canvas-thread" data-thread={thread.id}>
      <ol className="eva-cv-thread-messages">
        {thread.messages.map((m) => (
          <li key={m.id} className="eva-cv-thread-message" data-kind={m.kind}>
            <Face name={m.name} color={m.color} />
            <div className="eva-cv-thread-text">
              <div className="eva-cv-thread-who">
                <b>{m.name}</b>
                <span>{ago(m.ts)}</span>
              </div>
              <p>{m.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <Composer
        label="Reply"
        placeholder="Reply"
        testid="canvas-thread-reply"
        send={(text) => onReply(thread.id, text)}
      />
      <div className="eva-cv-thread-actions">
        {awaitingAnswer(thread) ? (
          <Button
            variant="subtle"
            color="gray"
            size="compact-xs"
            leftSection={<IconSparkles size={12} stroke={1.5} />}
            data-testid="canvas-thread-ask"
            loading={asking}
            title={`Start a live session on this board with ${ASK_NAME}, who answers this comment`}
            onClick={() => void ask()}
          >
            {`Ask ${ASK_NAME}`}
          </Button>
        ) : null}
        <Button
          variant="subtle"
          color="gray"
          size="compact-xs"
          leftSection={<IconCheck size={12} stroke={1.5} />}
          data-testid="canvas-thread-resolve"
          onClick={() => onResolve(thread.id, !thread.resolved)}
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </Button>
      </div>
      {refusal !== null ? (
        <p className="eva-cv-thread-error" role="alert" data-testid="canvas-thread-ask-error">
          {refusal}
        </p>
      ) : null}
    </div>
  )
}

/** One pin at screen point `at`, wrapping `popover` content when it is the open one. */
function Pin({
  at,
  thread,
  open,
  children,
  onClick,
  onClose,
}: {
  at: { x: number; y: number }
  thread: CanvasThread | null
  open: boolean
  children?: ReactNode
  onClick: () => void
  onClose: () => void
}) {
  const first = thread?.messages[0]
  const button = (
    <button
      type="button"
      className="eva-cv-pin"
      data-testid="canvas-pin"
      data-thread={thread?.id ?? 'draft'}
      data-open={open ? 'true' : undefined}
      data-resolved={thread?.resolved ? 'true' : undefined}
      aria-label={first ? `Comment by ${first.name}: ${excerpt(first.text, 60)}` : 'New comment'}
      title={first ? excerpt(first.text, 80) : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {first ? (
        <Face name={first.name} color={first.color} />
      ) : (
        <IconMessageCircle size={14} stroke={1.5} />
      )}
    </button>
  )
  return (
    <div className="eva-cv-pin-slot" style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
      {open ? (
        <EvaPopover
          opened
          onChange={(o) => {
            if (!o) onClose()
          }}
          position="right-start"
          shadow="md"
          trapFocus={false}
          returnFocus={false}
        >
          <EvaPopover.Target>{button}</EvaPopover.Target>
          <EvaPopover.Dropdown className="eva-cv-thread-pop" onKeyDown={(e) => e.stopPropagation()}>
            {children}
          </EvaPopover.Dropdown>
        </EvaPopover>
      ) : (
        button
      )}
    </div>
  )
}

/** The pins over the board; render it inside the board's React Flow (it follows pan and zoom). */
export function Comments(props: CommentsProps) {
  const { threads, boxes, draft, openId } = props
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const screen = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: p.x * zoom + tx,
    y: p.y * zoom + ty,
  })
  const draftAt = (() => {
    if (!draft) return null
    const p = pinPoint(draft, boxes)
    return p ? screen(p) : null
  })()
  return (
    <div className="eva-cv-pins" data-testid="canvas-pins">
      {threads.map((t) => {
        // A resolved pin shows only while its thread is open, like a live room's.
        if (t.resolved && t.id !== openId) return null
        const p = pinPoint(t, boxes)
        if (!p || t.messages.length === 0) return null
        const open = t.id === openId
        return (
          <Pin
            key={t.id}
            at={screen(p)}
            thread={t}
            open={open}
            onClick={() => props.onOpen(open ? null : t.id)}
            onClose={() => props.onOpen(null)}
          >
            <ThreadBody
              thread={t}
              onReply={props.onReply}
              onResolve={props.onResolve}
              onAsk={props.onAsk}
            />
          </Pin>
        )
      })}
      {draftAt ? (
        <Pin
          key="draft"
          at={draftAt}
          thread={null}
          open
          onClick={props.onCancelDraft}
          onClose={props.onCancelDraft}
        >
          <div className="eva-cv-thread" data-testid="canvas-thread" data-thread="draft">
            <Composer
              label="Comment"
              placeholder="Comment"
              testid="canvas-thread-new"
              send={props.onStart}
            />
          </div>
        </Pin>
      ) : null}
    </div>
  )
}
