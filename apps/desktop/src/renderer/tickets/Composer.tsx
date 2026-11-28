// The Linear comment box (ticket page, Reviews' Linear detail): @ lists the ticket's people and
// Relay's assistants; mentioning an assistant makes the message a private ask in Relay, never
// posted. Mentions of people become profile links (`linearBody`), the only mention Linear
// understands; bodies show them as `@Name` pills (`linearDisplay`). Cmd+Enter sends.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Badge, Button, Textarea } from '@mantine/core'
import { IconLock } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { invoke } from '../ipc'
import { EvaModal } from '../overlay'
import { fail } from '../reviews/review-ui'
import { PersonAvatar } from '../agents-board/CardChips'
import { mentionQuery, privacyOf, type Person } from './activity-model'
import { useMentionAssistants } from './mention-assistants'
import type { MutationView } from './use-mutation'

export type { Person } from './activity-model'

/**
 * The body Linear gets: each `@Name` of a person on the ticket becomes a link to their profile,
 * which Linear renders and notifies as a mention (plain `@handle` text is neither). Longer names
 * go first so `@Ann Lee` is not read as `@Ann`. A person without a known profile stays text.
 */
export function linearBody(text: string, people: readonly Person[]): string {
  let out = text
  for (const p of [...people].filter((x) => x.url).sort((a, b) => b.name.length - a.name.length)) {
    const at = new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g')
    out = out.replace(at, p.url)
  }
  return out
}

/** A Linear profile link (`https://linear.app/<workspace>/profiles/<handle>`): how Linear writes a mention. */
const PROFILE = /(?<!\]\()<?https:\/\/linear\.app\/[\w-]+\/profiles\/([\w.-]+)>?/g

/**
 * What a Linear body shows: each profile link as `@<Name>` in Linear's mention style (the
 * `mention:` pill the app's Markdown renders), the name from the people on the ticket, else the
 * handle. The body itself keeps the links, so a quote or reply still mentions the person.
 */
export function linearDisplay(text: string, people: readonly Person[]): string {
  return text.replace(PROFILE, (_, handle: string) => {
    const p = people.find((x) => x.handle.toLowerCase() === handle.toLowerCase())
    const name = (p?.name ?? handle).replace(/[[\]]/g, '')
    return `[@${name}](mention:linear)`
  })
}

/** `> ` before every line: a quote in markdown. */
export function quoteOf(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}\n\n`
}

/** The text selected inside `el`, or null when the selection is elsewhere or empty. */
export function selectionIn(el: HTMLElement | null): string | null {
  const sel = window.getSelection()
  if (!el || !sel || sel.isCollapsed || !sel.anchorNode) return null
  if (!el.contains(sel.anchorNode)) return null
  return sel.toString().trim() || null
}

/** The `@` list: assistants first (tagged), then the people, matching what follows the `@`. */
function mentionOptions(
  assistants: readonly Person[],
  people: readonly Person[],
  query: string | null,
): Person[] {
  if (query === null) return []
  const q = query.toLowerCase()
  return [...assistants, ...people]
    .filter((p) => p.handle.toLowerCase().startsWith(q) || p.name.toLowerCase().startsWith(q))
    .slice(0, 6)
}

/** The line under the box: where the message goes. */
function Destination({
  privacy,
  target,
}: {
  privacy: 'public' | 'private' | 'mixed'
  target: string
}) {
  if (privacy === 'public')
    return <span className="eva-rv-dim eva-rv-small">{`Cmd+Enter · ${target}`}</span>
  return (
    <span className="eva-rv-dim eva-rv-small" data-private data-testid="composer-private">
      <IconLock size={11} /> Only you
      {privacy === 'mixed'
        ? '. This stays private in Relay. Write a separate comment for people.'
        : ''}
    </span>
  )
}

function MentionList({ options, onPick }: { options: Person[]; onPick: (p: Person) => void }) {
  return (
    <div className="eva-rv-mentions" role="listbox" data-testid="review-mention-list">
      {options.map((p) => (
        <button
          key={`${p.assistant ? 'a' : 'p'}-${p.handle}`}
          type="button"
          role="option"
          aria-selected={false}
          className="eva-rv-mention-opt"
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(p)
          }}
        >
          {p.assistant ? (
            <IconLock size={12} />
          ) : (
            <PersonAvatar person={{ name: p.name, avatarUrl: p.avatarUrl ?? null }} size={16} />
          )}
          <span>{p.name}</span>
          {p.assistant ? (
            <Badge size="xs" variant="light" color="gray">
              assistant
            </Badge>
          ) : (
            <span className="eva-rv-dim">@{p.handle}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export interface ComposerProps {
  value: string
  onChange: (v: string) => void
  /** The ticket's people (not Isaac): whom @ offers besides the assistants. */
  people: readonly Person[]
  placeholder: string
  /** Where a non-private send goes, for the hint line. */
  target: string
  busy: boolean
  onSend: () => void
  onCancel?: () => void
  autoFocus?: boolean
  /** The send button's label for a message that is posted (default Reply with onCancel, else Comment). */
  sendLabel?: string
  testid: string
}

export function Composer(props: ComposerProps) {
  const { value, onChange, people, busy, onSend, onCancel } = props
  const box = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const assistants = useMentionAssistants()
  const privacy = privacyOf(value, people, assistants)
  const options = mentionOptions(assistants, people, query)

  const track = (text: string, caret: number): void => setQuery(mentionQuery(text.slice(0, caret)))
  // After a mention is picked, the caret goes right after it before the next key lands.
  const caretAt = useRef<number | null>(null)
  const pick = (p: Person): void => {
    const caret = box.current?.selectionStart ?? value.length
    // The editor shows `@Name`; linearBody turns it into the profile link Linear mentions with.
    const before = value.slice(0, caret).replace(/@([\w.-]*)$/, `@${p.url ? p.name : p.handle} `)
    onChange(before + value.slice(caret))
    setQuery(null)
    caretAt.current = before.length
  }
  useLayoutEffect(() => {
    const at = caretAt.current
    if (at === null || !box.current) return
    caretAt.current = null
    box.current.focus()
    box.current.setSelectionRange(at, at)
  }, [value])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (options.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault()
      pick(options[0]!)
    } else if (e.key === 'Escape' && query !== null) {
      e.stopPropagation()
      setQuery(null)
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSend()
    }
  }

  const label =
    privacy === 'public' ? (props.sendLabel ?? (onCancel ? 'Reply' : 'Comment')) : 'Ask privately'
  return (
    <div className="eva-rv-replybox">
      <Textarea
        ref={box}
        autosize
        minRows={2}
        maxRows={10}
        autoFocus={props.autoFocus}
        value={value}
        placeholder={props.placeholder}
        onChange={(e) => {
          onChange(e.currentTarget.value)
          track(e.currentTarget.value, e.currentTarget.selectionStart)
        }}
        onKeyDown={onKeyDown}
        data-private={privacy !== 'public' || undefined}
        data-testid={props.testid}
      />
      {options.length > 0 ? <MentionList options={options} onPick={pick} /> : null}
      <div className="eva-rv-composer-foot">
        <Destination privacy={privacy} target={props.target} />
        <span className="eva-rv-spacer" />
        {onCancel ? (
          <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="subtle"
          disabled={!value.trim() || busy}
          onClick={onSend}
          data-testid={`${props.testid}-send`}
        >
          {label}
        </Button>
      </div>
    </div>
  )
}

/**
 * The confirm before anything is written: the exact text, where it goes, and the one action.
 * `danger` (delete) makes the action red here, at the confirm, and nowhere before.
 */
export function ConfirmPost({
  opened,
  title,
  text,
  note,
  confirmLabel,
  busy,
  danger,
  onConfirm,
  onCancel,
}: {
  opened: boolean
  title: string
  /** The exact text written (undefined while closing). */
  text: string | undefined
  note: ReactNode
  confirmLabel: string
  busy: boolean
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <EvaModal opened={opened} onClose={onCancel} title={title} size={480}>
      <div className="eva-rv-confirm-text" data-testid="review-confirm-text">
        {text}
      </div>
      <div className="eva-rv-dim eva-rv-small" data-testid="review-confirm-note">
        {note}
      </div>
      <div className="eva-rv-modal-actions">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          loading={busy}
          color={danger ? 'red' : undefined}
          onClick={onConfirm}
          data-testid="review-confirm-post"
        >
          {confirmLabel}
        </Button>
      </div>
    </EvaModal>
  )
}

/**
 * How a write ended when it needs Isaac: refused or failed (nothing written; Retry, Dismiss), or
 * unknown ("Checking whether it posted": Check again asks about the same write, never a repost).
 */
export function MutationNotice({
  view,
  onRetry,
  onDismiss,
}: {
  view: MutationView
  onRetry: () => void
  onDismiss: () => void
}) {
  if (view.kind !== 'refused' && view.kind !== 'failed' && view.kind !== 'unknown') return null
  return (
    <div
      className="eva-tk-notice"
      role="status"
      data-kind={view.kind}
      data-testid="mutation-notice"
    >
      <span className={view.kind === 'unknown' ? 'eva-rv-dim' : 'eva-rv-error'}>
        {view.message}
      </span>
      <span className="eva-rv-spacer" />
      <Button size="compact-xs" variant="subtle" onClick={onRetry} data-testid="mutation-retry">
        {view.kind === 'unknown' ? 'Check again' : 'Retry'}
      </Button>
      <Button size="compact-xs" variant="subtle" color="gray" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}

/**
 * The legacy write (no host gate): `reviews.linearComment` from this desktop, after Isaac
 * confirmed the exact text. True when Linear took it.
 */
export async function postLegacyComment(input: {
  issueId: string
  parentId: string | null
  body: string
}): Promise<boolean> {
  const r = await invoke('reviews.linearComment', input)
  if (!r.ok) {
    fail(r.error.code === 'dry-run' ? 'Not posted' : "Couldn't post it", r.error.message)
    return false
  }
  notifications.show({ message: 'Posted on Linear.', color: 'green' })
  return true
}
