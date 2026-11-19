import { Tooltip } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import type { Trouble } from './agent-signin'

/**
 * A small warning mark whose tooltip says what is wrong with an agent's sign-in or last turn
 * (`troubleOf`). Presentational, so the design system's AssistantCard can draw it too.
 */
export function TroubleMark({
  trouble,
  testId,
  className,
}: {
  trouble: Trouble
  testId?: string | undefined
  className?: string
}) {
  return (
    <Tooltip
      multiline
      w={280}
      openDelay={200}
      label={
        <>
          <strong>{trouble.title}</strong>
          <br />
          {trouble.text}
        </>
      }
    >
      <span
        className={className ? `eva-signin-mark ${className}` : 'eva-signin-mark'}
        data-tone={trouble.tone}
        role="img"
        aria-label={`${trouble.title}. ${trouble.text}`}
        data-testid={testId}
      >
        <IconAlertTriangle size={14} stroke={1.75} aria-hidden />
      </span>
    </Tooltip>
  )
}
