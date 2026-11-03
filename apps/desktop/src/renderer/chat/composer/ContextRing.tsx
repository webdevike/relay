import { Tooltip } from '@mantine/core'
import { contextPercent } from '@evaos/chat-core/launch'

const SIZE = 20
const STROKE = 2
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function contextLabel(tokens: number | null, window: number | null): string {
  const r = contextPercent(tokens, window)
  if (r.kind === 'unavailable') return 'Unavailable'
  if (r.kind === 'tokens') return `Context ${r.value.toLocaleString('en-US')} tokens used`
  return `Context ${Math.round(r.value)}% used`
}

/** Arc color: accent below 80%, warning from 80%, danger from 95%. Tokens only reading is accent. */
function arcColor(value: number): string {
  if (value >= 95) return 'var(--eva-c-danger-background)'
  if (value >= 80) return 'var(--eva-c-warning-background)'
  return 'var(--eva-c-primary-background)'
}

/** A 20px progress ring of how much of the model's context window the session uses. */
export function ContextRing({ tokens, window }: { tokens: number | null; window: number | null }) {
  const reading = contextPercent(tokens, window)
  const label = contextLabel(tokens, window)
  const fraction = reading.kind === 'percent' ? Math.min(Math.max(reading.value / 100, 0), 1) : 0
  return (
    <Tooltip label={label} withinPortal>
      <span
        className="eva-context-ring"
        data-testid="composer-context"
        data-kind={reading.kind}
        role="img"
        aria-label={label}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--eva-c-border)"
            strokeWidth={STROKE}
          />
          {reading.kind === 'percent' ? (
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={arcColor(reading.value)}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          ) : reading.kind === 'tokens' ? (
            <circle cx={SIZE / 2} cy={SIZE / 2} r={2} fill="var(--eva-c-primary-background)" />
          ) : null}
        </svg>
      </span>
    </Tooltip>
  )
}
