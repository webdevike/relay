import { Avatar } from '@mantine/core'
import type { CanvasAgent } from '@evaos/chat-core/canvas-live'
import { hostUrl, useLiveRooms } from './live-store'

/** The agent at a canvas: its avatar from the Relay host, else its initial on its own color. */
export function AgentAvatar({ agent, size }: { agent: CanvasAgent; size: number }) {
  const src = useLiveRooms((s) => hostUrl(s.data, agent.avatar))
  return (
    <Avatar
      size={size}
      radius="xl"
      color={agent.color}
      variant="filled"
      src={src}
      alt=""
      // Mantine sizes initials at ~40% of the disc; keep them readable on small avatars.
      styles={{ placeholder: { fontSize: Math.max(11, Math.round(size * 0.5)) } }}
    >
      {(Array.from(agent.name)[0] ?? '?').toUpperCase()}
    </Avatar>
  )
}
