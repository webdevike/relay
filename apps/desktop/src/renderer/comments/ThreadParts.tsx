/**
 * The parts of a comment thread shared by the Canvas page's pins and the Skills editor's text
 * comments: faces, the message list and the reply field with its `@` agent menu.
 */
import { Button, Textarea } from '@mantine/core'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ThreadMsg } from '@relay/canvas-live/threads'
import {
  activeMention,
  insertMention,
  suggest,
  type Mentionable,
} from '@relay/canvas-live/mentions'
import { agentOf, useAssistants } from '../assistants/assistants-store'
import { ago } from '../canvas/comment-model'
import { portrait } from '../ui/portrait'
import './comments.css'

/** An initial on a disc of `color`. */
export function Face({ name, color }: { name: string; color: string }) {
  return (
    <span className="eva-cv-face" style={{ background: color }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** An assistant's face (its registry portrait), else its initial. */
export function AgentFace({ id, name }: { id: string; name: string }) {
  const face = useAssistants((s) => agentOf(s, id)?.avatar ?? null)
  return face === null ? (
    <Face name={name} color="var(--mantine-color-gray-6)" />
  ) : (
    <img className="eva-cv-face" src={portrait(face)} alt="" aria-hidden draggable={false} />
  )
}

/** The registry assistant behind a host avatar URL (`/canvas/avatar/<id>`), else null. */
export function avatarAgent(avatar: string | undefined): string | null {
  const id = avatar === undefined ? null : /^\/canvas\/avatar\/([^/?#]+)$/.exec(avatar)?.[1]
  return id ? decodeURIComponent(id) : null
}

/** A message's author: an assistant's portrait when the message carries its avatar, else the initial in the author's color. */
function MessageFace({ msg }: { msg: ThreadMsg }) {
  const id = avatarAgent(msg.avatar)
  const face = useAssistants((s) => (id === null ? null : (agentOf(s, id)?.avatar ?? null)))
  return face === null ? (
    <Face name={msg.name} color={msg.color} />
  ) : (
    <img className="eva-cv-face" src={portrait(face)} alt="" aria-hidden draggable={false} />
  )
}

/** A thread's messages, oldest first: face, name, age and text. */
export function ThreadMessages({ messages }: { messages: readonly ThreadMsg[] }) {
  return (
    <ol className="eva-cv-thread-messages">
      {messages.map((m) => (
        <li key={m.id} className="eva-cv-thread-message" data-kind={m.kind}>
          <MessageFace msg={m} />
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
  )
}

/**
 * The reply (or first comment) field: Enter sends, Shift+Enter breaks the line, Escape is the
 * popover's. Typing `@` lists the agents a comment can be for (Arrow keys and Enter or Tab pick,
 * Escape closes the menu only); the `@name` stays in the text, and routes the thread.
 */
export function Composer({
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
