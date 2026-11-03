import { useState } from 'react'
import { Badge, Button, Divider, Group, Stack, Text } from '@mantine/core'
import { IconExternalLink } from '@tabler/icons-react'
import type { TicketSpec, TicketsSpec, Tone } from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import { Pager, WidgetTitle, useToneColor } from './parts'

/** The state pill's tone from Linear's workflow-state type (widgets.rs state_tone). */
export function stateTone(stateType: TicketSpec['stateType']): Tone | undefined {
  switch (stateType) {
    case undefined:
      return undefined
    case 'started':
      return 'warn'
    case 'completed':
      return 'ok'
    case 'triage':
      return 'danger'
    case 'unstarted':
      return 'accent'
    default:
      return 'muted'
  }
}

/** A paged carousel, one ticket per page; the pager sits in the header over a hairline. */
export function TicketsWidget({ spec }: { spec: TicketsSpec }) {
  const [page, setPage] = useState(0)
  const toneColor = useToneColor()
  const count = spec.tickets.length
  const index = Math.min(page, count - 1)
  const ticket = spec.tickets[index]!
  const meta = [ticket.assignee, ticket.updated].filter((s) => s !== undefined).join(' · ')
  return (
    <Stack gap="sm" data-testid="widget-tickets">
      <Group justify="space-between" wrap="wrap" gap="sm">
        {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : <span />}
        <Pager index={index} count={count} onChange={setPage} label="Ticket" />
      </Group>
      <Divider />
      <Stack gap={6} data-testid="ticket-page">
        <Group gap="xs" wrap="wrap">
          <Text size="xs" c="dimmed">
            {ticket.id}
          </Text>
          {ticket.state !== undefined ? (
            <Badge
              size="sm"
              variant="light"
              radius="sm"
              tt="none"
              color={toneColor(stateTone(ticket.stateType))}
            >
              {ticket.state}
            </Badge>
          ) : null}
          {ticket.priority !== undefined ? (
            <Text size="xs" c="dimmed">
              {ticket.priority} priority
            </Text>
          ) : null}
        </Group>
        <Text fw={500}>{ticket.title}</Text>
        <Text size="sm" c="var(--eva-text-dim)">
          {ticket.summary}
        </Text>
        {meta !== '' || ticket.url !== undefined ? (
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="xs" c="dimmed">
              {meta}
            </Text>
            {ticket.url !== undefined ? (
              <Button
                size="compact-xs"
                variant="subtle"
                rightSection={<IconExternalLink size={12} stroke={1.75} />}
                onClick={() => openLink(ticket.url!)}
              >
                Open in Linear
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Stack>
  )
}
