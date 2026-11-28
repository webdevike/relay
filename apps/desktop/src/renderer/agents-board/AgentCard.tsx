import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Tooltip } from '@mantine/core'
import { IconLoader2 } from '@tabler/icons-react'
import { PointerSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core'
import type { AgentCard } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { ListPill } from '../ui/list'
import { cardPlace, waitingPlace } from '../tickets/ticket-place'
import { CardChips, CardKeyRow, PILL_TONE, StatusCircle } from './CardChips'
import { WaitChip } from './WaitChip'
import { useAgentsBoard } from './agents-store'
import { footLabel, waitingOf } from './board-view'

/** The drag sensor's start distance: a press that moves less is a click. */
const DRAG_DISTANCE = 5

/**
 * The board's drag sensor: a card is picked up once the pressed pointer moves DRAG_DISTANCE. Once a
 * drag has started, dnd-kit swallows the click its release fires, so a drop never opens the card.
 */
export function useCardSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE } }))
}

/**
 * The agent's stage pill (`Asking you`, `Stuck`, `QA bounced`, `Pre-review`, `Waiting on Noah`),
 * spinning while it runs, with why it sits in its column on hover; as the board always had it.
 */
function StagePill({ card }: { card: AgentCard }) {
  const running = card.column === 'working'
  return (
    <Tooltip label={card.reason} openDelay={400} multiline maw={320} disabled={!card.reason}>
      <span className="eva-ab-stage" data-testid="agents-card-pill">
        <ListPill
          tone={PILL_TONE[card.pill.tone]}
          icon={
            running ? <IconLoader2 size={12} className="eva-list-spin" aria-hidden /> : undefined
          }
        >
          {card.pill.label}
        </ListPill>
      </span>
    </Tooltip>
  )
}

/**
 * What a card looks like, also under the pointer while it is dragged. The waiting chip opens the
 * comment (or the PR it is on) and a PR chip that PR's page; a card without a page opens itself.
 * Agent work keeps its stage pill; a synced Linear issue with none shows its state in the circle.
 */
export function CardFace({
  card,
  now,
  onOpen,
}: {
  card: AgentCard
  now: number
  onOpen: () => void
}) {
  const handled = useAgentsBoard((s) => s.handled)
  const waiting = waitingOf(card, handled)
  const foot = footLabel(card, now)
  const openAt = (place: Place | null): void => (place ? openPlace(place) : onOpen())
  return (
    <>
      <CardKeyRow card={card} />
      <div className="eva-ab-r2">
        <StatusCircle card={card} />
        <span className="eva-ab-cardtitle">{card.title}</span>
      </div>
      {waiting ? (
        <div className="eva-ab-chips">
          <WaitChip
            waiting={waiting}
            now={now}
            onOpen={() => openAt(waitingPlace(card, waiting))}
          />
        </div>
      ) : null}
      <CardChips
        card={card}
        lead={card.kind === 'ticket' ? null : <StagePill card={card} />}
        onOpenPr={(pr) => openAt(cardPlace(card, { pr }))}
      />
      {foot ? <div className="eva-ab-foot">{foot}</div> : null}
    </>
  )
}

/**
 * One board card (after Linear's): key, parent and whose it is; status circle and title; the
 * waiting chip; priority, project, PRs, sub-issues, labels and session; when it was created.
 * Picked up by a press that moves (a card that can't move says why instead); a click opens it.
 */
export function AgentCardView({
  card,
  now,
  active,
  onOpen,
}: {
  card: AgentCard
  now: number
  active: boolean
  onOpen: () => void
}) {
  const blocked = card.dragBlock !== null
  const drag = useDraggable({ id: card.id, data: { card }, disabled: blocked })
  // A press that moves on a card that can't move: say why, until the pointer leaves.
  const [why, setWhy] = useState(false)
  const press = useRef<{ x: number; y: number } | null>(null)
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    onOpen()
  }
  const onMove = (e: PointerEvent): void => {
    const p = press.current
    if (!blocked || p === null) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) >= DRAG_DISTANCE) setWhy(true)
  }
  return (
    <Tooltip label={card.dragBlock ?? ''} opened={why && blocked} multiline maw={280}>
      <div
        ref={drag.setNodeRef}
        {...drag.attributes}
        role="button"
        tabIndex={0}
        aria-roledescription={blocked ? undefined : 'draggable card'}
        // Can't be dragged, but still opens: not a disabled control.
        aria-disabled={undefined}
        className="eva-ab-card"
        data-active={active || undefined}
        data-dragging={drag.isDragging || undefined}
        data-drag-block={blocked || undefined}
        data-testid={`agents-card-${card.key ?? card.id}`}
        onClick={() => onOpen()}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          press.current = { x: e.clientX, y: e.clientY }
          drag.listeners?.onPointerDown?.(e)
        }}
        onPointerMove={onMove}
        onPointerUp={() => {
          press.current = null
        }}
        onPointerLeave={() => {
          press.current = null
          setWhy(false)
        }}
      >
        <CardFace card={card} now={now} onOpen={onOpen} />
      </div>
    </Tooltip>
  )
}
