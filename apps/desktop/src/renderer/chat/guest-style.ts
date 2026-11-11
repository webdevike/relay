import type { CSSProperties } from 'react'
import type { GuestAgent } from '@evaos/chat-core/guest-entry'
import { agentOf, useAssistants } from '../assistants/assistants-store'

/** The guest's color as `--eva-guest-c`: the one its row carries, else its portrait's accent. */
export function useGuestStyle(agent: GuestAgent): CSSProperties {
  const accent = useAssistants((s) => agentOf(s, agent.id)?.avatar.colors?.accent)
  const color = agent.color ?? accent
  return (color === undefined ? {} : { '--eva-guest-c': color }) as CSSProperties
}
