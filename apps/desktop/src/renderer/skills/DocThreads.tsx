/**
 * The Skills editor's comment overlays, BlockNote style: the "Add comment..." field under text
 * just selected, the open thread under its highlight (messages, the assistant working, its
 * suggested change with Accept and Reject, a reply field, Resolve) and, for a suggestion whose
 * thread is closed, a slim Accept / Reject bar under the change itself. Threads and suggestions
 * live in the skill's Y.Doc; Isaac's comments go to his assistant through the Relay host, which
 * answers in the thread and may suggest a change, typed live at its caret.
 */
import { useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import { IconCheck, IconArrowBackUp } from '@tabler/icons-react'
import type { Editor } from '@tiptap/react'
import type * as Y from 'yjs'
import type { SkillUser } from '@evaos/contract'
import {
  acceptSuggestion,
  docThreadsOf,
  openDocThread,
  rejectSuggestion,
  snapDocThreads,
  snapSuggestions,
  suggestionsOf,
  type DocThreadSnap,
  type SuggestionSnap,
  type TextAnchor,
} from '@relay/canvas-live/doc-threads'
import type { Mentionable } from '@relay/canvas-live/mentions'
import { newThreadId, postInThread, setResolved, type ThreadMsg } from '@relay/canvas-live/threads'
import { useAssistants } from '../assistants/assistants-store'
import { awaitingAnswer } from '../canvas/comment-model'
import { agentsOf } from '../chat/composer/at-menu'
import { AgentFace, Composer, Face, ThreadMessages, avatarAgent } from '../comments/ThreadParts'
import { TypingDots } from '../ui/TypingDots'
import { pmPos, pmRange } from './doc-comments'

/** Origin of Isaac's own writes to threads and suggestions. */
const ORIGIN = 'skills:comments'
const CARD_WIDTH = 320
const GAP = 8

/** Re-renders on every editor transaction and every change to the threads or suggestions. */
function useLive(editor: Editor, doc: Y.Doc): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const threads = docThreadsOf(doc)
    const suggestions = suggestionsOf(doc)
    editor.on('transaction', bump)
    threads.observeDeep(bump)
    suggestions.observe(bump)
    window.addEventListener('resize', bump)
    return () => {
      editor.off('transaction', bump)
      threads.unobserveDeep(bump)
      suggestions.unobserve(bump)
      window.removeEventListener('resize', bump)
    }
  }, [editor, doc])
  return tick
}

/** Where a card goes in the sheet: under the line holding `pos`, its left edge at `left`. */
function placeAt(editor: Editor, start: number, end: number): { top: number; left: number } | null {
  if (editor.isDestroyed) return null
  const sheet = editor.view.dom.closest('.eva-skills-sheet')
  if (!sheet) return null
  try {
    const box = sheet.getBoundingClientRect()
    const a = editor.view.coordsAtPos(start)
    const b = editor.view.coordsAtPos(end)
    const left = Math.max(0, Math.min(a.left - box.left, box.width - CARD_WIDTH))
    return { top: b.bottom - box.top + GAP, left }
  } catch {
    return null
  }
}

function message(user: SkillUser, text: string): ThreadMsg {
  const now = Date.now()
  return {
    id: `m-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: 'human',
    name: user.name,
    color: user.color,
    text,
    ts: now,
  }
}

/** Accept and Reject for one suggestion: the change stays, or the text it replaced comes back. */
function Review({ doc, suggestion }: { doc: Y.Doc; suggestion: SuggestionSnap }) {
  return (
    <div className="eva-doc-review-actions">
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        leftSection={<IconArrowBackUp size={14} stroke={1.75} />}
        data-testid="skill-suggestion-reject"
        onClick={() => rejectSuggestion(doc, suggestion.id, ORIGIN)}
      >
        Reject
      </Button>
      <Button
        size="compact-xs"
        leftSection={<IconCheck size={14} stroke={1.75} />}
        data-testid="skill-suggestion-accept"
        onClick={() => acceptSuggestion(doc, suggestion.id, ORIGIN)}
      >
        Accept
      </Button>
    </div>
  )
}

/** Who made a suggestion: the assistant's portrait when it is one, else its initial. */
function Author({ by }: { by: SuggestionSnap['by'] }) {
  const id = avatarAgent(by.avatar)
  return id === null ? (
    <Face name={by.name} color={by.color} />
  ) : (
    <AgentFace id={id} name={by.name} />
  )
}

function ThreadCard({
  doc,
  thread,
  suggestion,
  user,
  assigneeName,
  mentionables,
}: {
  doc: Y.Doc
  thread: DocThreadSnap
  suggestion: SuggestionSnap | null
  user: SkillUser
  assigneeName: string | null
  mentionables: readonly Mentionable[]
}) {
  const threads = docThreadsOf(doc)
  const waiting = assigneeName !== null && awaitingAnswer(thread)
  return (
    <div className="eva-doc-thread" data-testid="skill-thread" data-thread={thread.id}>
      <div className="eva-doc-thread-head">
        {thread.assignee && assigneeName ? (
          <span className="eva-doc-thread-for" data-testid="skill-thread-assignee">
            <AgentFace id={thread.assignee} name={assigneeName} />
            {`For ${assigneeName}`}
          </span>
        ) : (
          <span className="eva-doc-thread-for">Comment</span>
        )}
        <Tooltip label={thread.resolved ? 'Reopen' : 'Resolve'} openDelay={400}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={thread.resolved ? 'Reopen' : 'Resolve'}
            data-testid="skill-thread-resolve"
            onClick={() =>
              doc.transact(() => setResolved(threads, thread.id, !thread.resolved), ORIGIN)
            }
          >
            <IconCheck size={14} stroke={1.75} />
          </ActionIcon>
        </Tooltip>
      </div>
      <ThreadMessages messages={thread.messages} />
      {waiting ? (
        <div className="eva-cv-thread-status" role="status" data-testid="skill-thread-working">
          <TypingDots size="inline" label={`${assigneeName} is on it`} />
          {`${assigneeName} is on it`}
        </div>
      ) : null}
      {suggestion ? (
        <div className="eva-doc-review" data-testid="skill-thread-suggestion">
          <Author by={suggestion.by} />
          <span className="eva-doc-review-label">{`${suggestion.by.name} suggested a change`}</span>
          <Review doc={doc} suggestion={suggestion} />
        </div>
      ) : null}
      <Composer
        key={thread.id}
        label="Reply"
        placeholder={`Reply or ask ${assigneeName ?? 'your assistant'}, @ for another`}
        testid="skill-thread-reply"
        mentionables={mentionables}
        send={async (text) => {
          doc.transact(() => postInThread(threads, thread.id, message(user, text)), ORIGIN)
        }}
      />
    </div>
  )
}

export interface DocThreadsProps {
  editor: Editor
  doc: Y.Doc
  user: SkillUser
  /** Text just picked for a new comment (the toolbar's Comment), or null. */
  draft: TextAnchor | null
  /** The draft became thread `thread` (opened in its place). */
  onDraftDone: (thread: string) => void
  openId: string | null
  /** Escape in a card: the draft is dropped, the open thread closes. */
  onClose: () => void
}

export function DocThreads({
  editor,
  doc,
  user,
  draft,
  onDraftDone,
  openId,
  onClose,
}: DocThreadsProps) {
  useLive(editor, doc)
  const agents = useAssistants((s) => s.data?.agents)
  const mentionables = useMemo(() => agentsOf(agents ?? []), [agents])
  const titleOf = (id: string | undefined): string | null =>
    id === undefined ? null : (agents?.find((a) => a.id === id)?.title ?? id)
  const threads = snapDocThreads(docThreadsOf(doc))
  const suggestions = snapSuggestions(doc)
  const open = openId === null ? undefined : threads.find((t) => t.id === openId)
  const state = editor.state

  const cards: { key: string; at: { top: number; left: number }; body: ReactNode }[] = []
  if (draft) {
    const range = pmRange(state, draft.from, draft.to)
    const at = range && placeAt(editor, range.from, range.to)
    if (at)
      cards.push({
        key: 'draft',
        at,
        body: (
          <div className="eva-doc-thread" data-testid="skill-comment-draft">
            <Composer
              label="Comment"
              placeholder="Add comment..."
              testid="skill-comment"
              mentionables={mentionables}
              send={async (text) => {
                const id = newThreadId()
                const ok = openDocThread(docThreadsOf(doc), id, draft, message(user, text))
                if (!ok) throw new Error('Could not add the comment')
                onDraftDone(id)
              }}
            />
          </div>
        ),
      })
  }
  if (open) {
    const range = open.anchor ? pmRange(state, open.anchor.from, open.anchor.to) : null
    const at = range ? placeAt(editor, range.from, range.to) : { top: GAP, left: 0 }
    if (at)
      cards.push({
        key: `thread:${open.id}`,
        at,
        body: (
          <ThreadCard
            doc={doc}
            thread={open}
            suggestion={suggestions.find((s) => s.thread === open.id) ?? null}
            user={user}
            assigneeName={titleOf(open.assignee)}
            mentionables={mentionables}
          />
        ),
      })
  }
  // A suggestion whose thread is not open gets its own bar under the change.
  for (const s of suggestions) {
    if (open && s.thread === open.id) continue
    const last = s.hunks.at(-1)
    const end = last ? pmPos(state, last.to) : null
    const start = s.hunks[0] ? pmPos(state, s.hunks[0].from) : null
    const at = end === null || start === null ? null : placeAt(editor, Math.min(start, end), end)
    if (at)
      cards.push({
        key: `suggestion:${s.id}`,
        at,
        body: (
          <div className="eva-doc-review eva-doc-review-bar" data-testid="skill-suggestion">
            <Author by={s.by} />
            <span className="eva-doc-review-label">{`${s.by.name} suggested a change`}</span>
            <Review doc={doc} suggestion={s} />
          </div>
        ),
      })
  }

  return (
    <>
      {cards.map((c) => (
        <Floating key={c.key} at={c.at} onClose={onClose}>
          {c.body}
        </Floating>
      ))}
    </>
  )
}

/** A card pinned at `at` in the sheet. Escape closes it, unless the `@` menu is open in its field. */
function Floating({
  at,
  onClose,
  children,
}: {
  at: { top: number; left: number }
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      className="eva-doc-float"
      style={{ top: at.top, left: at.left, width: CARD_WIDTH }}
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape' || ref.current?.querySelector('[role="listbox"]')) return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      {children}
    </div>
  )
}
