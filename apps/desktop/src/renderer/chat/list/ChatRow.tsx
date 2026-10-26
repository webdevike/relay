import { ActionIcon, NavLink, UnstyledButton } from '@mantine/core'
import {
  IconAlarm,
  IconCheck,
  IconClock,
  IconGitFork,
  IconGitPullRequest,
  IconListCheck,
  IconPin,
  IconRestore,
  IconSparkles,
} from '@tabler/icons-react'
import { useDraggable } from '@dnd-kit/core'
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import type { ChatRow as Row } from '@evaos/contract'
import { DISMISS_PRIORITY, useDismissable } from '../../hotkeys/dismiss'
import { EvaMenu, EvaPopover } from '../../overlay'
import { age, bright, lookStatus, modelName, needsYou, pill, runStart, workLabel } from './look'
import { ProjectBadge } from './ProjectBadge'
import { SnoozeItems } from './RowMenu'
import { STATUS_NAME, StatusIcon } from './StatusIcon'
import { TicketCard, ticketOf } from './TicketCard'
import { LinearMark } from '../widgets/blocks/table'

/** Hover card delay, as native look_card. */
const CARD_DELAY_MS = 400

export interface ChatRowProps {
  row: Row
  /** The workspace the chat lists under: drawn on line 1 when not nested, and in the hover card. */
  category: string
  /** Inside its workspace folder: the title takes line 1. Pinned, snoozed and settled rows are not. */
  nested: boolean
  /** Archived or fast-settled: the quick action reads Unsettle. */
  settled: boolean
  /** The clock the status pill and age read; ChatList ticks it. */
  now: number
  active: boolean
  /** Fades the background for 300 ms after a title, status or return change. */
  changed?: boolean
  /** Click or Enter; Cmd opens a new tab. */
  onOpen: (row: Row, e: MouseEvent | KeyboardEvent) => void
  /** Opens the chat menu at a viewport point (right-click or Shift+F10). */
  onMenu?: (row: Row, x: number, y: number) => void
  onSnooze?: (row: Row, untilMs: number | null) => void
  onSettle?: (row: Row, settled: boolean) => void
  /** The title is an inline input; `renamePending` while its commit is in flight. */
  renaming?: boolean
  renamePending?: boolean
  onCommitRename?: (row: Row, name: string) => void
  onCancelRename?: () => void
  /** A failed action's message, shown under the row. */
  error?: string | null
  /** The folder the row sits in, for dragging; undefined for unfoldered rows. */
  group?: string
  noDrag?: boolean
}

function RenameInput({
  row,
  pending,
  onCommit,
  onCancel,
}: {
  row: Row
  pending: boolean
  onCommit: (row: Row, name: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  // Enter and Escape unmount the input, which blurs it: only the first outcome counts.
  const done = useRef(false)
  useEffect(() => {
    // The menu that opened this may hand focus back to its anchor as it closes.
    const focus = (): void => {
      ref.current?.focus()
      ref.current?.select()
    }
    focus()
    const t = setTimeout(focus, 120)
    return () => clearTimeout(t)
  }, [])
  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(row, ref.current?.value ?? '')
    else onCancel()
  }
  // The global Esc ladder runs in the capture phase and would otherwise leave the sub-page.
  useDismissable(DISMISS_PRIORITY.overlay, () => finish(false))
  return (
    <input
      ref={ref}
      className="eva-cl-rename"
      data-testid="chat-rename-input"
      aria-label="Chat name"
      defaultValue={row.title}
      readOnly={pending}
      maxLength={200}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}

/** The hover card's lines (native look_card): title, workspace, work and model. */
function Card({ row, category }: { row: Row; category: string }) {
  const label = workLabel(row.work)
  const pr = row.work?.pr ?? null
  const WorkIcon = row.work?.branch != null ? IconGitFork : IconListCheck
  const work =
    label !== null && pr !== null ? `${label} · #${pr}` : (label ?? (pr !== null ? `#${pr}` : null))
  const line = (icon: ReactNode, text: string): ReactNode => (
    <div className="eva-cl-card-line">
      <span className="eva-cl-card-icon">{icon}</span>
      <span className="eva-cl-card-text">{text}</span>
    </div>
  )
  return (
    <div className="eva-cl-card" data-testid="chat-card">
      <div className="eva-cl-card-title">{row.title}</div>
      <div className="eva-cl-card-lines">
        {line(<ProjectBadge name={category} size="sm" />, category)}
        {work !== null ? line(<WorkIcon size={12} stroke={1.75} />, work) : null}
        {row.model !== null
          ? line(<IconSparkles size={12} stroke={1.75} />, modelName(row.model))
          : null}
      </div>
    </div>
  )
}

/** What the right of line 1 shows when not hovered: the status pill, the Woke chip, or the age. */
function When({ row, now }: { row: Row; now: number }) {
  const status = lookStatus(row)
  if (status !== null) {
    return (
      <span className="eva-cl-pill" data-status={status}>
        <StatusIcon status={status} />
        {pill(status, runStart(row), now)}
      </span>
    )
  }
  return <span className="eva-cl-age">{age(row.returnedMs, now)}</span>
}

const stop = (e: SyntheticEvent): void => e.stopPropagation()

/**
 * A hovered row's quick actions in place of its age (native look_actions): a clock opening the
 * Snooze presets (Unsnooze when snoozed; none while it waits on Isaac) and Settle or Unsettle.
 * Neither opens the chat.
 */
function QuickActions({
  row,
  settled,
  onSnooze,
  onSettle,
  onSnoozeOpen,
}: {
  row: Row
  settled: boolean
  onSnooze?: (row: Row, untilMs: number | null) => void
  onSettle?: (row: Row, settled: boolean) => void
  onSnoozeOpen: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const snoozable = onSnooze && (row.snoozedUntilMs !== null || !needsYou(row))
  const toggle = (o: boolean): void => {
    setOpen(o)
    onSnoozeOpen(o)
  }
  return (
    // Menu items portal out but still bubble through React: keep clicks and keys off the row.
    <span
      className="eva-cl-quick"
      onClick={stop}
      onKeyDown={stop}
      onPointerDown={stop}
      onContextMenu={stop}
    >
      {snoozable ? (
        <EvaMenu opened={open} onChange={toggle} position="bottom-end" width={260}>
          <EvaMenu.Target>
            <ActionIcon
              variant="subtle"
              size={24}
              className="eva-cl-quick-btn"
              data-testid={`chat-snooze-${row.id}`}
              aria-label={row.snoozedUntilMs !== null ? 'Unsnooze' : 'Snooze'}
              title={row.snoozedUntilMs !== null ? 'Unsnooze' : 'Snooze'}
              onClick={() => toggle(!open)}
            >
              <IconClock size={12} stroke={1.75} />
            </ActionIcon>
          </EvaMenu.Target>
          <EvaMenu.Dropdown data-testid="chat-snooze-menu">
            <SnoozeItems
              row={row}
              onSnooze={(r, until) => {
                toggle(false)
                onSnooze(r, until)
              }}
            />
          </EvaMenu.Dropdown>
        </EvaMenu>
      ) : null}
      {onSettle ? (
        <UnstyledButton
          className="eva-cl-quick-settle"
          data-testid={`chat-settle-${row.id}`}
          onClick={() => onSettle(row, !settled)}
        >
          {settled ? (
            <IconRestore size={12} stroke={1.75} aria-hidden />
          ) : (
            <IconCheck size={12} stroke={1.75} aria-hidden />
          )}
          {settled ? 'Unsettle' : 'Settle'}
        </UnstyledButton>
      ) : null}
    </span>
  )
}

function ChatRowImpl({
  row,
  category,
  nested,
  settled,
  now,
  active,
  changed,
  onOpen,
  onMenu,
  onSnooze,
  onSettle,
  renaming,
  renamePending,
  onCommitRename,
  onCancelRename,
  error,
  group,
  noDrag,
}: ChatRowProps) {
  const drag = useDraggable({
    id: `chat:${row.id}`,
    data: { type: 'chat', id: row.id, group },
    disabled: noDrag === true || renaming === true,
    // A row opens its chat: a link that can also be picked up.
    attributes: { role: 'link' },
  })
  const [card, setCard] = useState(false)
  /** Which card the hover opens: the chat's, or its Linear ticket's from the badge. */
  const [ticketHover, setTicketHover] = useState(false)
  const ticket = ticketOf(row)
  const [snoozing, setSnoozing] = useState(false)
  const cardTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(cardTimer.current), [])
  const errorEl = error ? (
    <div role="alert" className="eva-cl-row-error" data-testid="chat-row-error">
      {error}
    </div>
  ) : null

  const status = lookStatus(row)
  const woke = row.wokeMs !== null

  if (renaming) {
    return (
      <div className="eva-cl-rowwrap">
        <div className="eva-cl-row-edit" data-testid={`chat-row-${row.id}`} data-renaming="true">
          <RenameInput
            row={row}
            pending={renamePending === true}
            onCommit={(r, n) => onCommitRename?.(r, n)}
            onCancel={() => onCancelRename?.()}
          />
        </div>
        {errorEl}
      </div>
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault()
      // Mantine's menu closes on any keydown outside it, including this very event as it bubbles
      // to the document: open on the next task.
      const r = e.currentTarget.getBoundingClientRect()
      setTimeout(() => onMenu?.(row, r.left, r.bottom), 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onOpen(row, e)
    }
  }
  const showCard = (): void => {
    window.clearTimeout(cardTimer.current)
    cardTimer.current = window.setTimeout(() => setCard(true), CARD_DELAY_MS)
  }
  const hideCard = (): void => {
    window.clearTimeout(cardTimer.current)
    setCard(false)
    setTicketHover(false)
  }

  const title = (
    <span className="eva-cl-title" data-bright={bright(row) ? 'true' : undefined}>
      {row.title}
    </span>
  )
  const label = workLabel(row.work)
  const pr = row.work?.pr ?? null
  const WorkIcon = row.work?.branch != null ? IconGitFork : IconListCheck
  const line3 =
    label !== null || pr !== null ? (
      <span className="eva-cl-line3">
        {label !== null ? <WorkIcon size={12} stroke={1.75} aria-hidden /> : null}
        <span className="eva-cl-work">{label}</span>
        {pr !== null ? (
          <>
            <IconGitPullRequest size={12} stroke={1.75} aria-hidden />
            <span className="eva-cl-pr">{`#${pr}`}</span>
          </>
        ) : null}
      </span>
    ) : null
  const more =
    nested && line3 === null ? undefined : (
      <>
        {nested ? null : <span className="eva-cl-line2">{title}</span>}
        {line3}
      </>
    )

  return (
    <div
      className="eva-cl-rowwrap"
      data-dragging={drag.isDragging ? 'true' : undefined}
      style={
        drag.transform
          ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` }
          : undefined
      }
    >
      {/* A hover card, not a disclosure: withRoles off keeps aria-expanded off the row. */}
      <EvaPopover
        opened={card && !drag.isDragging && !snoozing}
        onChange={(o) => {
          if (!o) hideCard()
        }}
        position="right-start"
        width={280}
        withRoles={false}
      >
        <EvaPopover.Target>
          <NavLink
            component="div"
            ref={drag.setNodeRef}
            {...drag.attributes}
            // dnd-kit marks undraggable rows aria-disabled; they still open and have a menu.
            aria-disabled={undefined}
            tabIndex={0}
            aria-current={active ? 'page' : undefined}
            aria-label={`${row.title}${status !== null ? `, ${STATUS_NAME[status]}` : ''}`}
            active={active}
            className="eva-cl-row"
            classNames={{
              body: 'eva-cl-row-body',
              label: 'eva-cl-row-label',
              description: 'eva-cl-row-more',
            }}
            data-testid={`chat-row-${row.id}`}
            data-changed={changed ? 'true' : undefined}
            data-nested={nested ? 'true' : undefined}
            data-snoozing={snoozing ? 'true' : undefined}
            onClick={(e: MouseEvent) => {
              hideCard()
              onOpen(row, e)
            }}
            onMouseEnter={showCard}
            onMouseLeave={hideCard}
            onContextMenu={(e: MouseEvent) => {
              if (!onMenu) return
              e.preventDefault()
              hideCard()
              onMenu(row, e.clientX, e.clientY)
            }}
            {...drag.listeners}
            onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
              hideCard()
              drag.listeners?.onPointerDown?.(e)
            }}
            onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
              drag.listeners?.onKeyDown?.(e)
              onKeyDown(e)
            }}
            label={
              <span className="eva-cl-line1">
                {nested ? (
                  title
                ) : (
                  <>
                    <ProjectBadge name={category} size="sm" />
                    <span className="eva-cl-category">{category}</span>
                  </>
                )}
                {ticket !== null ? (
                  <span
                    className="eva-cl-ticket"
                    data-testid="chat-row-ticket"
                    aria-label={`Linear ticket ${ticket}`}
                    onMouseEnter={() => {
                      setCard(false)
                      setTicketHover(true)
                      showCard()
                    }}
                    onMouseLeave={() => {
                      setCard(false)
                      setTicketHover(false)
                      showCard()
                    }}
                  >
                    <LinearMark size={10} />
                  </span>
                ) : null}
                {row.pinned ? (
                  <IconPin size={12} stroke={1.75} className="eva-cl-flag" aria-label="Pinned" />
                ) : null}
                {row.snoozedUntilMs !== null ? (
                  <IconAlarm size={12} stroke={1.75} className="eva-cl-flag" aria-label="Snoozed" />
                ) : null}
                <span className="eva-cl-when">
                  {status === null && woke ? (
                    <span className="eva-cl-woke">
                      <IconAlarm size={12} stroke={1.75} aria-hidden />
                      Woke
                    </span>
                  ) : (
                    <When row={row} now={now} />
                  )}
                </span>
                <QuickActions
                  row={row}
                  settled={settled}
                  onSnooze={onSnooze}
                  onSettle={onSettle}
                  onSnoozeOpen={(o) => {
                    setSnoozing(o)
                    if (o) hideCard()
                  }}
                />
              </span>
            }
            description={more}
          />
        </EvaPopover.Target>
        <EvaPopover.Dropdown onMouseEnter={hideCard}>
          {ticketHover && ticket !== null ? (
            <TicketCard ticket={ticket} />
          ) : (
            <Card row={row} category={category} />
          )}
        </EvaPopover.Dropdown>
      </EvaPopover>
      {errorEl}
    </div>
  )
}

export const ChatRow = memo(ChatRowImpl)
