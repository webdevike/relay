// One Linear comment: author, age, the body as Markdown (images at their `w=` width, mentions as
// pills, `:shortcodes:` as emoji), quote/reply on hover, the "..." menu, reactions, inline edit.
import { useRef, useState } from 'react'
import { ActionIcon, Button, Textarea, Tooltip } from '@mantine/core'
import { IconArrowBackUp, IconQuote } from '@tabler/icons-react'
import type { TicketComment } from '@relay/protocol'
import { emojify } from '@relay/slack-emoji'
import { Markdown } from '../chat/markdown/Markdown'
import { PersonAvatar } from '../agents-board/CardChips'
import { agoPhrase } from '../reviews/review-model'
import type { CommentAction, Person } from './activity-model'
import { linearDisplay, selectionIn } from './Composer'
import { CommentMenu } from './CommentMenu'
import { Reactions } from './Reactions'

/** A Linear body (description or comment) as the app's Markdown. */
export function CommentMarkdown({ text, people }: { text: string; people: readonly Person[] }) {
  return <Markdown text={emojify(linearDisplay(text, people))} />
}

function EditBox({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: string
  busy: boolean
  onSave: (body: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const save = (): void => {
    if (text.trim() && text !== initial) onSave(text.trim())
  }
  return (
    <div className="eva-tk-edit">
      <Textarea
        autosize
        autoFocus
        minRows={2}
        maxRows={12}
        value={text}
        aria-label="Edit comment"
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
        data-testid="comment-edit-box"
      />
      <div className="eva-rv-composer-foot">
        <span className="eva-rv-spacer" />
        <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="subtle"
          loading={busy}
          disabled={!text.trim() || text === initial}
          onClick={save}
          data-testid="comment-edit-save"
        >
          Save
        </Button>
      </div>
    </div>
  )
}

export interface CommentBlockProps {
  c: TicketComment
  now: number
  /** Everyone on the ticket, Isaac too: whom a profile link names. */
  people: readonly Person[]
  meId: string | null
  actions: readonly CommentAction[]
  onAction: (a: CommentAction) => void
  /** Roots only: open the reply box under the thread. */
  onReply?: () => void
  onQuote: (text: string) => void
  canReact: boolean
  onReact: (emoji: string, on: boolean) => void
  editing: boolean
  editBusy: boolean
  onSaveEdit: (body: string) => void
  onCancelEdit: () => void
  /** Scrolled to from `#comment-<id>`: flashes once. */
  flash: boolean
  anchor: (el: HTMLDivElement | null) => void
}

export function CommentBlock(p: CommentBlockProps) {
  const { c } = p
  const body = useRef<HTMLDivElement>(null)
  const name = c.author?.name ?? 'Someone'
  return (
    <div
      ref={p.anchor}
      id={`comment-${c.id}`}
      className="eva-rv-lcomment eva-tk-comment"
      data-flash={p.flash || undefined}
      data-testid="ticket-comment"
      data-comment-id={c.id}
    >
      <div className="eva-rv-comment-head">
        <PersonAvatar person={{ name, avatarUrl: c.author?.avatarUrl ?? null }} size={20} />
        <b>{name}</b>
        <span className="eva-rv-dim">{agoPhrase(c.at, p.now)}</span>
        {c.editedAt !== null ? <span className="eva-rv-dim">(edited)</span> : null}
        <span className="eva-rv-spacer" />
        <span className="eva-rv-lcomment-actions">
          <Tooltip label="Quote the selected text (or the whole comment)" openDelay={300}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={22}
              aria-label="Quote"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => p.onQuote(selectionIn(body.current) ?? c.body)}
            >
              <IconQuote size={14} />
            </ActionIcon>
          </Tooltip>
          {p.onReply ? (
            <Tooltip label="Reply in this thread" openDelay={300}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={22}
                aria-label="Reply"
                onClick={p.onReply}
              >
                <IconArrowBackUp size={14} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </span>
        <CommentMenu actions={p.actions} onAction={p.onAction} />
      </div>
      {c.quotedText ? <blockquote className="eva-tk-quoted">{c.quotedText}</blockquote> : null}
      {p.editing ? (
        <EditBox
          initial={c.body}
          busy={p.editBusy}
          onSave={p.onSaveEdit}
          onCancel={p.onCancelEdit}
        />
      ) : (
        <div ref={body} className="eva-rv-lcomment-body" data-testid="ticket-comment-body">
          <CommentMarkdown text={c.body} people={p.people} />
        </div>
      )}
      <div className="eva-rv-lcomment-body">
        <Reactions reactions={c.reactions} meId={p.meId} canReact={p.canReact} onSet={p.onReact} />
      </div>
    </div>
  )
}
