import { Group, Stack, Text } from '@mantine/core'
import { IconArrowDownRight, IconArrowUpRight } from '@tabler/icons-react'
import type { StatSpec } from '@evaos/chat-core/widget'

type Direction = NonNullable<StatSpec['delta']>['direction']

const DELTA: Record<Direction, { color: string; sign: string }> = {
  up: { color: 'var(--mantine-color-green-text)', sign: '+' },
  down: { color: 'var(--mantine-color-red-text)', sign: '\u2212' },
  flat: { color: 'var(--mantine-color-dimmed)', sign: '' },
}

/** The delta as written when it carries a sign, else signed by its direction. */
export function signedDelta(value: string, direction: Direction): string {
  return /^[+\-\u2212]/.test(value) ? value : `${DELTA[direction].sign}${value}`
}

export function StatWidget({ spec }: { spec: StatSpec }) {
  const delta = spec.delta
  return (
    <Stack gap={2} data-testid="widget-stat">
      <Text size="xs" c="dimmed">
        {spec.label}
      </Text>
      <Group gap="xs" align="baseline" wrap="wrap">
        <Text fw={600} fz="xl" lh={1.25}>
          {spec.value}
        </Text>
        {delta !== undefined ? (
          <Group
            gap={3}
            wrap="nowrap"
            data-testid="stat-delta"
            data-direction={delta.direction}
            style={{ color: DELTA[delta.direction].color }}
          >
            {delta.direction === 'up' ? <IconArrowUpRight size={14} stroke={2} /> : null}
            {delta.direction === 'down' ? <IconArrowDownRight size={14} stroke={2} /> : null}
            <Text size="xs" fw={500} c="inherit">
              {signedDelta(delta.value, delta.direction)}
            </Text>
          </Group>
        ) : null}
      </Group>
    </Stack>
  )
}
