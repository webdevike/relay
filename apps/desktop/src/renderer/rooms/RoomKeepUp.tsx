// Keeping Isaac in the know in a chat room: the "Where we are" strip under the notch, the
// catch-up pill while he reads back, and the "Since you left" block where he stopped. Their
// content is derived in decision-view.ts; here they are drawn, and their lines jump to messages.
import { useState } from 'react'
import { UnstyledButton } from '@mantine/core'
import {
  IconArrowDown,
  IconChartBar,
  IconChevronDown,
  IconChevronUp,
  IconCompass,
  IconGavel,
  IconHandFinger,
  IconHistory,
  IconListDetails,
  IconScale,
  IconX,
} from '@tabler/icons-react'
import {
  catchUp,
  catchUpParts,
  whereWeAre,
  type CatchUpIcon,
  type CatchUpItem,
} from './decision-view'
import type { Room } from './types'
import './decisions.css'

const ICON: Record<CatchUpIcon, typeof IconGavel> = {
  list: IconListDetails,
  poll: IconChartBar,
  scale: IconScale,
  you: IconHandFinger,
  gavel: IconGavel,
}

/** Scrolls the room's feed to message `id` and flashes it. */
export function jumpToMessage(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-testid="room-msg-${CSS.escape(id)}"]`)
  if (!el) return
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
  el.classList.remove('eva-dec-flash')
  void el.offsetWidth
  el.classList.add('eva-dec-flash')
}

/** Under the notch: the question on the table, where the room leans, and what waits on Isaac. */
export function WhereStrip({ room }: { room: Room }) {
  const w = whereWeAre(room)
  if (!w) return null
  const lean = w.lean
  return (
    <div className="eva-dec-where" data-testid="room-where">
      <IconCompass size={14} stroke={1.5} aria-hidden />
      <span className="eva-dec-where-q">{w.question}</span>
      <span className="eva-dec-where-lean">
        {lean.kind === 'decided' ? (
          <>
            Decided <b>{lean.text}</b>
          </>
        ) : lean.kind === 'leaning' ? (
          <>
            Leaning <b>{lean.text}</b> · {lean.count}
          </>
        ) : lean.kind === 'split' ? (
          'Split vote'
        ) : lean.kind === 'voting' ? (
          'Voting'
        ) : (
          'Opening positions'
        )}
      </span>
      <span className="eva-dec-where-fill" />
      {w.you ? (
        <UnstyledButton
          className="eva-dec-you"
          data-testid="room-where-you"
          title={w.you.kind === 'question' ? 'Jump to the question' : 'Jump to the decision'}
          onClick={() => jumpToMessage(w.you!.target)}
        >
          <IconHandFinger size={14} stroke={1.5} aria-hidden />
          {w.you.kind === 'question'
            ? `${w.you.count} question${w.you.count === 1 ? '' : 's'} for you`
            : 'Your call on the decision'}
        </UnstyledButton>
      ) : null}
    </div>
  )
}

function Summary({ items, onJump }: { items: CatchUpItem[]; onJump: (id: string) => void }) {
  return (
    <div className="eva-dec-sum">
      {items.map((x) => {
        const Icon = ICON[x.icon]
        return (
          <UnstyledButton
            key={`${x.icon}-${x.target}`}
            className="eva-dec-sum-item"
            data-you={x.you || undefined}
            onClick={() => onJump(x.target)}
          >
            <Icon size={14} stroke={1.5} aria-hidden />
            <span>{x.text}</span>
          </UnstyledButton>
        )
      })}
    </div>
  )
}

/**
 * While Isaac reads back and members post: "3 new · 1 decision · 1 question for you". It opens a
 * summary whose lines jump to their message; the arrow jumps to the latest.
 */
export function CatchUpPill({
  room,
  from,
  onLatest,
}: {
  room: Room
  /** The index of the first message he has not seen. */
  from: number
  onLatest: () => void
}) {
  const [open, setOpen] = useState(false)
  const c = catchUp(room, from)
  if (c.fresh === 0) return null
  const parts = catchUpParts(c)
  return (
    <div className="eva-dec-catch" data-testid="room-catchup">
      {open ? (
        <div className="eva-dec-panel" data-testid="room-catchup-panel">
          <Summary
            items={c.items}
            onJump={(id) => {
              setOpen(false)
              jumpToMessage(id)
            }}
          />
        </div>
      ) : null}
      <div className="eva-dec-pill">
        <UnstyledButton
          className="eva-dec-pill-main"
          data-testid="room-catchup-pill"
          aria-expanded={open}
          title={open ? 'Hide summary' : 'Catch up'}
          onClick={() => setOpen((o) => !o)}
        >
          <span>
            {parts.plain}
            {parts.you ? (
              <>
                {' · '}
                <span className="eva-dec-pill-you">{parts.you}</span>
              </>
            ) : null}
          </span>
          {open ? (
            <IconChevronDown size={14} stroke={1.5} aria-hidden />
          ) : (
            <IconChevronUp size={14} stroke={1.5} aria-hidden />
          )}
        </UnstyledButton>
        <UnstyledButton
          className="eva-dec-icon"
          aria-label="Jump to latest"
          title="Jump to latest"
          data-testid="room-catchup-latest"
          onClick={() => {
            setOpen(false)
            onLatest()
          }}
        >
          <IconArrowDown size={14} stroke={1.5} />
        </UnstyledButton>
      </div>
    </div>
  )
}

/** Where Isaac stopped reading: what members said and decided since, until he dismisses it. */
export function SinceBlock({
  room,
  from,
  onDismiss,
}: {
  room: Room
  from: number
  onDismiss: () => void
}) {
  const c = catchUp(room, from)
  return (
    <div className="eva-dec-since" data-testid="room-since">
      <div className="eva-dec-since-head">
        <IconHistory size={14} stroke={1.5} aria-hidden />
        <span className="eva-dec-since-title">Since you left · {c.fresh} new</span>
        <UnstyledButton
          className="eva-dec-icon"
          aria-label="Dismiss"
          title="Dismiss"
          data-testid="room-since-dismiss"
          onClick={onDismiss}
        >
          <IconX size={14} stroke={1.5} />
        </UnstyledButton>
      </div>
      <Summary items={c.items} onJump={jumpToMessage} />
    </div>
  )
}
