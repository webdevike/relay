// The ticket's status row as a picker, and the two ways a pick reaches Linear: through the host's
// gate (`StatusPicker` in TicketSidebar) or, without host sync, through Reviews' own Linear writes
// (`LinearStatus`, today's path). Both draw the same menu and the same confirm for Done/Canceled.
import { useState, type ReactNode } from 'react'
import { Button, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAlertSquareFilled,
  IconAntennaBars3,
  IconAntennaBars4,
  IconAntennaBars5,
  IconCheck,
  IconChevronDown,
  IconLineDashed,
  type Icon,
} from '@tabler/icons-react'
import type { LinearState, LinearTicket } from '@evaos/contract'
import { TERMINAL_TICKET_STATE_TYPES, TicketStateType } from '@relay/protocol'
import { invoke } from '../ipc'
import { EvaMenu, EvaModal } from '../overlay'
import { fail } from '../reviews/review-ui'

const PRIORITY_ICON: Record<string, Icon> = {
  Urgent: IconAlertSquareFilled,
  High: IconAntennaBars5,
  Medium: IconAntennaBars4,
  Low: IconAntennaBars3,
}

/** Linear's priority names by level (0 none, 1 urgent .. 4 low). */
export const PRIORITY_LABEL = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const

/** Linear's priority glyph: bars by level, a filled square for Urgent, a dash for none. */
export function PriorityIcon({ label }: { label: string }) {
  const Glyph = PRIORITY_ICON[label] ?? IconLineDashed
  return (
    <Glyph size={14} stroke={1.75} className="eva-rv-lprio" data-priority={label} aria-hidden />
  )
}

/** A workflow state of Linear's type `type` closes the ticket (Done, Canceled): it asks first. */
export function isTerminalState(type: string): boolean {
  const t = TicketStateType.safeParse(type)
  return t.success && TERMINAL_TICKET_STATE_TYPES[t.data]
}

interface StateLike {
  id: string
  name: string
  color: string
}

/** The status row: the current state, and a menu of the team's states (read when it opens). */
export function StatusMenu<S extends StateLike>({
  state,
  moving,
  states,
  opened,
  onOpen,
  onPick,
  isCurrent,
  write,
}: {
  state: { name: string; color: string }
  /** The state it is moving to while the write runs, else null. */
  moving: string | null
  states: readonly S[] | null
  opened: boolean
  onOpen: (open: boolean) => void
  onPick: (s: S) => void
  isCurrent: (s: S) => boolean
  /** Which path the pick takes (`gate` or `legacy`), for tests and the inspector. */
  write: 'gate' | 'legacy'
}) {
  return (
    <EvaMenu opened={opened} onChange={onOpen} position="bottom-start" width={220}>
      <EvaMenu.Target>
        <UnstyledButton
          className="eva-tk-prow"
          aria-label={`Status: ${state.name}. Change status`}
          data-testid="ticket-status"
          data-write={write}
        >
          <i className="eva-tk-dot" style={{ background: state.color }} aria-hidden />
          {moving ?? state.name}
          {moving ? <Loader size={10} /> : <IconChevronDown size={12} className="eva-tk-dim" />}
        </UnstyledButton>
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="ticket-status-menu">
        {states === null ? (
          <div className="eva-tk-menu-loading">
            <Loader size={14} />
          </div>
        ) : (
          states.map((s) => (
            <EvaMenu.Item
              key={s.id}
              leftSection={<i className="eva-tk-dot" style={{ background: s.color }} />}
              rightSection={isCurrent(s) ? <IconCheck size={14} /> : null}
              onClick={() => onPick(s)}
              data-testid={`ticket-state-${s.name}`}
            >
              {s.name}
            </EvaMenu.Item>
          ))
        )}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/** "Move ENG-12 to Done?": what the move does, then Cancel or Move. */
export function StatusConfirm({
  opened,
  title,
  onCancel,
  onConfirm,
  children,
}: {
  opened: boolean
  title: string
  onCancel: () => void
  onConfirm: () => void
  children: ReactNode
}) {
  return (
    <EvaModal opened={opened} onClose={onCancel} title={title} testid="ticket-status-confirm">
      <Stack gap="md">
        {children}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} data-testid="ticket-status-confirm-ok">
            Move
          </Button>
        </Group>
      </Stack>
    </EvaModal>
  )
}

/**
 * The status picker on the legacy path (no host sync), as Reviews' Linear panel had it: the team's
 * workflow states (read when it opens) and the pick moves the ticket in Linear through Reviews' own
 * write; a move to Done or Canceled asks first. Where states cannot be read (a thin client) it
 * stays a plain label.
 */
export function LinearStatus({
  ticket,
  onChanged,
}: {
  ticket: LinearTicket
  onChanged: () => void
}) {
  const [opened, setOpened] = useState(false)
  const [states, setStates] = useState<LinearState[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [moving, setMoving] = useState<string | null>(null)
  const [asking, setAsking] = useState<LinearState | null>(null)

  const open = async (next: boolean): Promise<void> => {
    setOpened(next)
    if (!next || states !== null) return
    const r = await invoke('reviews.linearStates', { issueId: ticket.id })
    if (r.ok) setStates(r.value)
    else {
      setOpened(false)
      setUnavailable(true)
      fail("Couldn't read the statuses", r.error.message)
    }
  }

  const move = async (s: LinearState): Promise<void> => {
    setAsking(null)
    setMoving(s.name)
    const r = await invoke('reviews.linearSetState', { issueId: ticket.id, stateId: s.id })
    setMoving(null)
    if (!r.ok)
      return fail(
        r.error.code === 'dry-run' ? 'Not changed' : "Couldn't change it",
        r.error.message,
      )
    notifications.show({ message: `${ticket.key} moved to ${r.value.name}.`, color: 'green' })
    onChanged()
  }

  const pick = (s: LinearState): void => {
    if (s.name === ticket.state.name) return
    if (isTerminalState(s.type)) setAsking(s)
    else void move(s)
  }

  if (unavailable)
    return (
      <div className="eva-tk-prow" data-testid="ticket-status">
        <i className="eva-tk-dot" style={{ background: ticket.state.color }} aria-hidden />
        {ticket.state.name}
      </div>
    )
  return (
    <>
      <StatusMenu
        state={ticket.state}
        moving={moving}
        states={states}
        opened={opened}
        onOpen={(o) => void open(o)}
        onPick={pick}
        isCurrent={(s) => s.name === ticket.state.name}
        write="legacy"
      />
      <StatusConfirm
        opened={asking !== null}
        title={`Move ${ticket.key} to ${asking?.name ?? ''}?`}
        onCancel={() => setAsking(null)}
        onConfirm={() => asking && void move(asking)}
      >
        <Text size="sm">
          This changes its status in Linear, as you. Everyone on the ticket sees it.
        </Text>
      </StatusConfirm>
    </>
  )
}
