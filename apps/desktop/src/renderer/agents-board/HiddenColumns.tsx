import { useState } from 'react'
import { UnstyledButton } from '@mantine/core'
import { useDroppable } from '@dnd-kit/core'
import { IconChevronDown, IconChevronRight, IconEye } from '@tabler/icons-react'
import type { AgentCard, AgentColumn } from '@evaos/contract'
import { EvaPopover } from '../overlay'
import { COLUMN_ICON } from './CardChips'
import { showColumn } from './agents-store'
import { COLUMN_TITLE } from './board-view'

/** Drop target ids: a column (shown or hidden) is `col:<column>`. */
export const dropId = (col: AgentColumn): string => `col:${col}`

function HiddenRow({
  column,
  cards,
  onOpen,
}: {
  column: AgentColumn
  cards: readonly AgentCard[]
  onOpen: (card: AgentCard) => void
}) {
  const [open, setOpen] = useState(false)
  const drop = useDroppable({ id: dropId(column), data: { column } })
  const Glyph = COLUMN_ICON[column]
  return (
    <EvaPopover opened={open} onChange={setOpen} position="bottom-end" width={280}>
      <EvaPopover.Target>
        <div
          ref={drop.setNodeRef}
          className="eva-ab-hrow"
          data-column={column}
          data-over={drop.isOver || undefined}
          data-testid={`agents-hidden-${column}`}
        >
          <UnstyledButton
            className="eva-ab-hopen"
            aria-expanded={open}
            aria-label={`${COLUMN_TITLE[column]}: ${cards.length} cards`}
            onClick={() => setOpen((o) => !o)}
          >
            <Glyph size={16} stroke={1.75} className="eva-ab-colicon" aria-hidden />
            <span className="eva-ab-colname">{COLUMN_TITLE[column]}</span>
          </UnstyledButton>
          <UnstyledButton
            className="eva-ab-hshow"
            onClick={() => showColumn(column)}
            data-testid={`agents-show-${column}`}
          >
            <IconEye size={13} stroke={1.75} aria-hidden />
            Show column
          </UnstyledButton>
          <span className="eva-ab-count">{cards.length}</span>
        </div>
      </EvaPopover.Target>
      <EvaPopover.Dropdown className="eva-ab-hpop" data-testid={`agents-hidden-pop-${column}`}>
        {cards.length === 0 ? (
          <div className="eva-ab-hempty">No cards</div>
        ) : (
          cards.map((c) => (
            <UnstyledButton
              key={c.id}
              className="eva-ab-hcard"
              onClick={() => {
                setOpen(false)
                onOpen(c)
              }}
              data-testid={`agents-hidden-card-${c.key ?? c.id}`}
            >
              <span className="eva-ab-key">{c.key ?? 'Session'}</span>
              <span className="eva-ab-hcard-t">{c.title}</span>
            </UnstyledButton>
          ))
        )}
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}

/**
 * The right-hand "Hidden columns" group: each hidden column with its count, a Show column
 * button, a popover of its cards, and a drop target, so a card can still move there.
 */
export function HiddenColumns({
  columns,
  cards,
  onOpen,
}: {
  columns: readonly AgentColumn[]
  cards: Record<AgentColumn, AgentCard[]>
  onOpen: (card: AgentCard) => void
}) {
  const [open, setOpen] = useState(true)
  if (columns.length === 0) return null
  const Chevron = open ? IconChevronDown : IconChevronRight
  return (
    <aside className="eva-ab-hidden" data-testid="agents-hidden">
      <UnstyledButton className="eva-ab-hghead" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron size={14} stroke={1.75} aria-hidden />
        Hidden columns
      </UnstyledButton>
      {open
        ? columns.map((col) => (
            <HiddenRow key={col} column={col} cards={cards[col]} onOpen={onOpen} />
          ))
        : null}
    </aside>
  )
}
