import type { Ref } from 'react'
import { Tooltip } from '@mantine/core'
import { AgentPortrait } from '../../assistants/AgentPortrait'
import { agentOf, useAssistants } from '../../assistants/assistants-store'

/**
 * Isaac's reaction on a bubble, a small disc on its bottom-right corner (iMessage's tapback). With
 * `onOpen` it is the way to change it: the bar opens on click, Enter or Space.
 */
export function ReactionBadge({
  emoji,
  testId,
  onOpen,
  expanded = false,
  ref,
}: {
  emoji: string
  testId: string
  onOpen?: () => void
  expanded?: boolean
  ref?: Ref<HTMLButtonElement>
}) {
  if (!onOpen) {
    return (
      <span
        className="eva-reaction-badge"
        data-testid={testId}
        role="img"
        aria-label={`Reacted ${emoji}`}
      >
        {emoji}
      </span>
    )
  }
  return (
    <button
      ref={ref}
      type="button"
      className="eva-reaction-badge"
      data-testid={testId}
      aria-label={`Reacted ${emoji}. Change reaction`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      {emoji}
    </button>
  )
}

/**
 * Assistant `agent`'s reaction on one of Isaac's bubbles, beside his: its emoji and the agent's
 * tiny portrait (the emoji alone for an agent the registry does not list). Read only.
 */
export function AgentReactionBadge({
  agent,
  emoji,
  testId,
}: {
  agent: string
  emoji: string
  testId: string
}) {
  const title = useAssistants((s) => agentOf(s, agent)?.title ?? null)
  const label = `${title ?? agent} reacted ${emoji}`
  return (
    <Tooltip label={label} openDelay={300}>
      <span
        className="eva-reaction-badge"
        data-agent={agent}
        data-testid={testId}
        role="img"
        aria-label={label}
      >
        {title !== null ? <AgentPortrait id={agent} className="eva-reaction-portrait" /> : null}
        {emoji}
      </span>
    </Tooltip>
  )
}
