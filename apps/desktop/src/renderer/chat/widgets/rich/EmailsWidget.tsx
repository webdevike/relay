import { useState } from 'react'
import { Group, Stack, Text, UnstyledButton } from '@mantine/core'
import type { EmailsSpec } from '@evaos/chat-core/widget'
import { LinkIcon, WidgetTitle } from './parts'

/**
 * An inbox list (widgets.rs emails): flat rows on hairlines with an unread dot and bold sender,
 * the time at the right, the subject, and a 2-line snippet that a click expands. A row with a
 * `url` carries an open icon.
 */
export function EmailsWidget({ spec }: { spec: EmailsSpec }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const toggle = (i: number): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(i)) next.add(i)
      return next
    })
  return (
    <Stack gap="xs" data-testid="widget-emails">
      {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : null}
      <div>
        {spec.emails.map((email, i) => {
          const open = expanded.has(i)
          return (
            <UnstyledButton
              key={i}
              className="eva-w-email"
              data-testid="email-row"
              data-expanded={open}
              aria-expanded={email.snippet !== undefined ? open : undefined}
              onClick={() => toggle(i)}
            >
              <Group gap="xs" wrap="nowrap">
                {email.unread ? <span className="eva-w-unread" aria-label="Unread" /> : null}
                <Text size="sm" fw={email.unread ? 700 : 600} truncate style={{ flex: 1 }}>
                  {email.from}
                </Text>
                {email.date !== undefined ? (
                  <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
                    {email.date}
                  </Text>
                ) : null}
                {email.url !== undefined ? <LinkIcon url={email.url} label="Open email" /> : null}
              </Group>
              <Text size="sm" truncate={!open}>
                {email.subject}
              </Text>
              {email.snippet !== undefined ? (
                <Text size="xs" c="dimmed" lineClamp={open ? undefined : 2}>
                  {email.snippet}
                </Text>
              ) : null}
            </UnstyledButton>
          )
        })}
      </div>
    </Stack>
  )
}
