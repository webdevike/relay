/**
 * Comment pins on the Canvas page, drawn like a live room's (Figma style): a pin sits on the card it
 * was left on (it follows the card) or on a board spot, at screen size whatever the zoom. A pin
 * opens its thread in a popover: the messages, a reply field, Resolve. Typing `@` in a comment lists
 * the agents (the assistants of the registry); a comment that names one is for it: the thread keeps it
 * and a live session on the board with that agent answers it. A new comment is a draft pin with
 * just the field; Enter saves it into the board file.
 */
import { Button, Textarea } from '@mantine/core'
import { IconCheck, IconMessageCircle, IconSparkles } from '@tabler/icons-react'
import { useReactFlow, useStore } from '@xyflow/react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { CanvasThread } from '@evaos/contract'
import {
  DRAG_THRESHOLD,
  OffsetMemory,
  anchorAtPoint,
  clampOffset,
} from '@relay/canvas-live/pindrag'
import type { ThreadAnchor } from '@relay/canvas-live/threads'
import {
  activeMention,
  insertMention,
  suggest,
  type Mentionable,
} from '@relay/canvas-live/mentions'
import { agentOf, useAssistants } from '../assistants/assistants-store'
import { EvaPopover } from '../overlay'
import { portrait } from '../ui/portrait'
import { ago, awaitingAnswer, excerpt, pinPoint, type Anchor, type Box } from './comment-model'

/** Where a thread's session with its agent stands: starting, or why the host refused. */
export type AskState = { phase: 'asking' } | { phase: 'refused'; message: string }

export interface CommentsProps {
  threads: readonly CanvasThread[]
  /** Every card's box in board space. */
  boxes: ReadonlyMap<string, Box>
  /** A comment being written (no thread yet): its pin and the field. */
  draft: Anchor | null
  openId: string | null
  onOpen: (id: string | null) => void
  /** Who an `@` can name here: the registry's assistants. */
  mentionables: readonly Mentionable[]
  /** Threads whose agent is being started, or refused, by thread id. */
  asks: Readonly<Record<string, AskState>>
  /** Saves the draft as a new thread. Rejects with the reason it could not. */
  onStart: (text: string) => Promise<void>
  onCancelDraft: () => void
  onReply: (thread: string, text: string) => Promise<void>
  onResolve: (thread: string, resolved: boolean) => void
  /** Starts a session on the board with the thread's agent and hands it the thread (again, after a refusal). */
  onAsk: (thread: string) => void
  /** A pin dragged: onto a card, or to a board point. */
  onMove: (thread: string, anchor: ThreadAnchor) => void
}

function Face({ name, color }: { name: string; color: string }) {
  return (
    <span className="eva-cv-face" style={{ background: color }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** An assistant's face (its registry portrait), else its initial. */
function AgentFace({ id, name }: { id: string; name: string }) {
  const face = useAssistants((s) => agentOf(s, id)?.avatar ?? null)
  return face === null ? (
    <Face name={name} color="var(--mantine-color-gray-6)" />
  ) : (
    <img className="eva-cv-face" src={portrait(face)} alt="" aria-hidden draggable={false} />
  )
}

/**
 * The reply (or first comment) field: Enter sends, Shift+Enter breaks the line, Escape is the
 * popover's. Typing `@` lists the agents a comment can be for (Arrow keys and Enter or Tab pick,
 * Escape closes the menu only); the `@name` stays in the text, and routes the thread.
 */
function Composer({
  label,
  placeholder,
  send,
  testid,
  mentionables,
}: {
  label: string
  placeholder: string
  send: (text: string) => Promise<void>
  testid: string
  mentionables: readonly Mentionable[]
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [caret, setCaret] = useState(0)
  const [picked, setPicked] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const active = activeMention(text, Math.min(caret, text.length))
  const options = active === null ? [] : suggest(active.query, mentionables)
  const open =
    active !== null && options.length > 0 && dismissed !== `${active.start}:${active.query}`
  useEffect(() => setPicked(0), [active?.query])

  const choose = (candidate: Mentionable): void => {
    if (active === null) return
    const next = insertMention(text, active, candidate)
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => {
      field.current?.focus()
      field.current?.setSelectionRange(next.caret, next.caret)
    })
  }
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
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setPicked((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        const candidate = options[picked]
        if (candidate) choose(candidate)
        return
      }
      if (e.key === 'Escape') {
        // Closes the menu only, not the thread popover under it.
        e.preventDefault()
        if (active) setDismissed(`${active.start}:${active.query}`)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }
  return (
    <div className="eva-cv-composer">
      <div className="eva-cv-mention">
        {open ? (
          <ul
            className="eva-cv-mention-menu"
            role="listbox"
            aria-label="Agents"
            data-testid="canvas-mention-menu"
          >
            {options.map((c, i) => (
              <li key={c.id} role="option" aria-selected={i === picked}>
                <button
                  type="button"
                  className="eva-cv-mention-item"
                  data-picked={i === picked ? 'true' : undefined}
                  data-testid="canvas-mention-option"
                  data-agent={c.id}
                  // The field keeps focus while the menu is clicked.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(c)}
                >
                  <AgentFace id={c.id} name={c.name} />
                  <span className="eva-cv-mention-name">{c.name}</span>
                  {c.hint ? <span className="eva-cv-mention-hint">{c.hint}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Textarea
          ref={field}
          autoFocus
          autosize
          minRows={1}
          maxRows={5}
          size="xs"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          placeholder={placeholder}
          value={text}
          maxLength={4000}
          className="eva-cv-composer-field"
          data-testid={`${testid}-input`}
          onChange={(e) => {
            setCaret(e.currentTarget.selectionStart)
            setText(e.currentTarget.value)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={keys}
          error={error}
          disabled={busy}
        />
      </div>
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
  grip,
  mentionables,
  ask,
  onReply,
  onResolve,
  onAsk,
}: {
  thread: CanvasThread
  grip: Grip
  mentionables: readonly Mentionable[]
  ask: AskState | undefined
  onReply: CommentsProps['onReply']
  onResolve: CommentsProps['onResolve']
  onAsk: CommentsProps['onAsk']
}) {
  const assignee = thread.assignee
    ? (mentionables.find((c) => c.id === thread.assignee) ?? {
        id: thread.assignee,
        name: thread.assignee,
      })
    : null
  return (
    <div className="eva-cv-thread" data-testid="canvas-thread" data-thread={thread.id}>
      <div
        className="eva-cv-thread-for"
        data-testid="canvas-thread-head"
        onPointerDown={grip}
        title="Drag to move this comment"
      >
        {assignee ? (
          <span
            className="eva-cv-thread-assignee"
            data-testid="canvas-thread-assignee"
            data-agent={assignee.id}
            title={`${assignee.name} answers this thread`}
          >
            <AgentFace id={assignee.id} name={assignee.name} />
            <span>{`For ${assignee.name}`}</span>
          </span>
        ) : (
          <span>Comment</span>
        )}
      </div>
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
        placeholder="Reply, @ for an agent"
        testid="canvas-thread-reply"
        mentionables={mentionables}
        send={(text) => onReply(thread.id, text)}
      />
      <div className="eva-cv-thread-actions">
        {ask?.phase === 'asking' ? (
          <span className="eva-cv-thread-status" role="status" data-testid="canvas-thread-asking">
            {`Starting a session with ${assignee?.name ?? 'the agent'}`}
          </span>
        ) : assignee && awaitingAnswer(thread) ? (
          // Only a thread the live room has not picked up (the host refused, or Relay was down) needs a second try.
          <Button
            variant="subtle"
            color="gray"
            size="compact-xs"
            leftSection={<IconSparkles size={12} stroke={1.5} />}
            data-testid="canvas-thread-ask"
            title={`Start a live session on this board with ${assignee.name}, who answers this comment`}
            onClick={() => onAsk(thread.id)}
          >
            {`Ask ${assignee.name}`}
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
      {ask?.phase === 'refused' ? (
        <p className="eva-cv-thread-error" role="alert" data-testid="canvas-thread-ask-error">
          {ask.message}
        </p>
      ) : null}
    </div>
  )
}

/** The popover's grip: pressing it drags the popover. */
type Grip = (e: React.PointerEvent) => void

/** Where each thread's popover was dragged to, for this session. */
const popoverOffsets = new OffsetMemory()

/** One pin at screen point `at`, wrapping `popover` content when it is the open one. */
function Pin({
  at,
  thread,
  open,
  children,
  onClick,
  onClose,
  onDrop,
}: {
  at: { x: number; y: number }
  thread: CanvasThread | null
  open: boolean
  children?: ReactNode | ((grip: Grip) => ReactNode)
  onClick: () => void
  onClose: () => void
  /** The pin was dragged and let go with its tip at this client point. */
  onDrop?: (client: { x: number; y: number }) => void
}) {
  const first = thread?.messages[0]
  const slot = useRef<HTMLDivElement>(null)
  const dropdown = useRef<HTMLDivElement>(null)
  const press = useRef<{
    x0: number
    y0: number
    grabDx: number
    grabDy: number
    moved: boolean
  } | null>(null)
  const suppressClick = useRef(false)
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const key = thread?.id ?? 'draft'
  const [offset, setOffset] = useState(() => popoverOffsets.get(key))

  const grip: Grip = (e) => {
    const el = dropdown.current
    if (!el || e.button !== 0) return
    const rect = el.getBoundingClientRect()
    const base = {
      x: rect.left - offset.dx,
      y: rect.top - offset.dy,
      w: rect.width,
      h: rect.height,
    }
    const bounds = { w: window.innerWidth, h: window.innerHeight }
    const x0 = e.clientX
    const y0 = e.clientY
    const from = offset
    const move = (m: PointerEvent): void => {
      const next = clampOffset(
        base,
        { dx: from.dx + m.clientX - x0, dy: from.dy + m.clientY - y0 },
        bounds,
      )
      popoverOffsets.set(key, next)
      setOffset(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const button = (
    <button
      type="button"
      className="eva-cv-pin"
      data-testid="canvas-pin"
      data-thread={key}
      data-open={open ? 'true' : undefined}
      data-resolved={thread?.resolved ? 'true' : undefined}
      data-dragging={drag ? 'true' : undefined}
      aria-label={first ? `Comment by ${first.name}: ${excerpt(first.text, 60)}` : 'New comment'}
      title={first ? excerpt(first.text, 80) : undefined}
      onPointerDown={(e) => {
        e.stopPropagation()
        const tip = slot.current?.getBoundingClientRect()
        if (!onDrop || !tip || e.button !== 0) return
        press.current = {
          x0: e.clientX,
          y0: e.clientY,
          grabDx: e.clientX - tip.left,
          grabDy: e.clientY - tip.top,
          moved: false,
        }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const p = press.current
        if (!p) return
        const dx = e.clientX - p.x0
        const dy = e.clientY - p.y0
        if (!p.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        p.moved = true
        setDrag({ dx, dy })
      }}
      onPointerUp={(e) => {
        const p = press.current
        press.current = null
        setDrag(null)
        if (!p?.moved) return
        suppressClick.current = true
        onDrop?.({ x: e.clientX - p.grabDx, y: e.clientY - p.grabDy })
      }}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        onClick()
      }}
    >
      {first ? (
        <Face name={first.name} color={first.color} />
      ) : (
        <IconMessageCircle size={14} stroke={1.5} />
      )}
    </button>
  )
  return (
    <div
      ref={slot}
      className="eva-cv-pin-slot"
      style={{ transform: `translate(${at.x + (drag?.dx ?? 0)}px, ${at.y + (drag?.dy ?? 0)}px)` }}
    >
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
          <EvaPopover.Dropdown
            ref={dropdown}
            className="eva-cv-thread-pop"
            style={{ transform: `translate(${offset.dx}px, ${offset.dy}px)` }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {typeof children === 'function' ? children(grip) : children}
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
  const flow = useReactFlow()
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
            onDrop={(client) => {
              // The tip lands on the card under the drop point, else on the board.
              const drop = flow.screenToFlowPosition(client)
              props.onMove(t.id, anchorAtPoint(drop, boxes))
            }}
          >
            {(grip) => (
              <ThreadBody
                thread={t}
                grip={grip}
                mentionables={props.mentionables}
                ask={props.asks[t.id]}
                onReply={props.onReply}
                onResolve={props.onResolve}
                onAsk={props.onAsk}
              />
            )}
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
              placeholder="Comment, @ for an agent"
              testid="canvas-thread-new"
              mentionables={props.mentionables}
              send={props.onStart}
            />
          </div>
        </Pin>
      ) : null}
    </div>
  )
}
