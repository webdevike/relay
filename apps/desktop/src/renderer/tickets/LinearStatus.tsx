import { useState } from 'react'
import { Loader, UnstyledButton } from '@mantine/core'
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
import { invoke } from '../ipc'
import { EvaMenu } from '../overlay'
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

/**
 * The ticket's status as a picker on the legacy Reviews path (no host sync): the team's workflow
 * states (read when it opens), the pick moves the ticket in Linear. Where states cannot be read (a
 * thin client) it stays a plain label.
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

  const pick = async (s: LinearState): Promise<void> => {
    if (s.name === ticket.state.name) return
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

  const label = (
    <>
      <span className="eva-rv-ldot" style={{ background: ticket.state.color }} />
      {moving ?? ticket.state.name}
      {moving ? <Loader size={10} /> : null}
    </>
  )
  if (unavailable)
    return (
      <span className="eva-rv-lprop" data-testid="linear-status">
        {label}
      </span>
    )
  return (
    <EvaMenu opened={opened} onChange={(o) => void open(o)} position="bottom-start" width={220}>
      <EvaMenu.Target>
        <UnstyledButton
          className="eva-rv-lprop eva-rv-lstatus"
          aria-label={`Status: ${ticket.state.name}. Change status`}
          data-testid="linear-status"
        >
          {label}
          <IconChevronDown size={12} className="eva-rv-dim" aria-hidden />
        </UnstyledButton>
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="linear-status-menu">
        {states === null ? (
          <div className="eva-rv-lstates-loading">
            <Loader size={14} />
          </div>
        ) : (
          states.map((s) => (
            <EvaMenu.Item
              key={s.id}
              leftSection={<span className="eva-rv-ldot" style={{ background: s.color }} />}
              rightSection={s.name === ticket.state.name ? <IconCheck size={14} /> : null}
              onClick={() => void pick(s)}
              data-testid={`linear-state-${s.name}`}
            >
              {s.name}
            </EvaMenu.Item>
          ))
        )}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}
