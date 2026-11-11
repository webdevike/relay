import { HoverCard } from '@mantine/core'
import type { ChatRoomMember } from '@evaos/contract'
import { agentOf, useAssistants } from '../assistants/assistants-store'
import { thinkingLabel } from '../chat/composer/ModelPicker'
import { portrait } from '../ui/portrait'
import { useModelCatalog, specOf } from './model-catalog'
import { useRooms } from './rooms-store'
import type { Room } from './types'
import '../assistants/assistants.css'
import './rooms.css'

/** A chat room's notch in its page header: the member stack hanging below the title bar. */
export function RoomNotch({ id }: { id: string }) {
  const room = useRooms((s) => s.rooms[id] ?? null)
  if (!room?.chat) return null
  return (
    <span className="eva-as-notch eva-room-notch" data-testid="room-notch">
      <MemberStack room={room} />
    </span>
  )
}

const PRESENCE_WORD = { thinking: 'thinking', reading: 'reading', typing: 'speaking' } as const

/** How much of a member's instructions the card shows. */
const SUMMARY_MAX = 140

/** A member's face: its assistant's portrait, else the first letter of a custom agent's name. */
export function MemberFace({ member, className }: { member: ChatRoomMember; className: string }) {
  const face = useAssistants((s) =>
    member.assistant === undefined
      ? null
      : (agentOf(s, member.assistant)?.avatar ?? member.assistant),
  )
  return (
    <span className={className} data-custom={face === null || undefined}>
      {face === null ? (
        (Array.from(member.name)[0] ?? '?').toUpperCase()
      ) : (
        <img src={portrait(face)} alt="" aria-hidden draggable={false} />
      )}
    </span>
  )
}

/**
 * A chat room's members as overlapping, slightly tilted rounded squares, no names. Hovering one
 * shows its card: name, what it is doing, role, exact model and thinking, a summary of its
 * instructions and what it has cost so far.
 */
export function MemberStack({ room }: { room: Room }) {
  const { models } = useModelCatalog()
  const members = room.chat?.setup.members ?? []
  return (
    <span className="eva-room-stack" data-testid="room-stack">
      {members.map((m, i) => {
        const presence = room.presence[m.id]
        const status = presence ? PRESENCE_WORD[presence.state] : 'idle'
        const model = models?.find((x) => specOf(x) === m.model)
        const summary =
          m.instructions && m.instructions.length > SUMMARY_MAX
            ? `${m.instructions.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
            : m.instructions
        return (
          <HoverCard
            key={m.id}
            width={280}
            position="bottom"
            shadow="md"
            withArrow={false}
            openDelay={120}
            closeDelay={120}
            withinPortal
          >
            <HoverCard.Target>
              <span
                className="eva-room-stack-member"
                data-tilt={i % 6}
                data-status={status}
                data-testid={`room-member-${m.id}`}
                aria-label={m.name}
              >
                <MemberFace member={m} className="eva-room-stack-face" />
              </span>
            </HoverCard.Target>
            <HoverCard.Dropdown className="eva-room-card" data-testid={`room-member-card-${m.id}`}>
              <div className="eva-room-card-head">
                <b>{m.name}</b>
                <span className="eva-room-card-kind">
                  {m.assistant === undefined ? 'Custom' : 'Assistant'}
                </span>
                <span className="eva-room-card-fill" />
                <span className="eva-room-card-status" data-status={status}>
                  {status}
                </span>
              </div>
              <div>
                <span className="eva-room-card-key">Role</span> {m.role || 'No role yet'}
              </div>
              <div>
                <span className="eva-room-card-key">Model</span> {model?.name ?? m.model} ·{' '}
                {thinkingLabel(m.thinking)}{' '}
                <span className="eva-room-model-id" data-testid={`room-member-model-${m.id}`}>
                  {m.model}
                </span>
              </div>
              {summary ? (
                <div>
                  <span className="eva-room-card-key">Instructions</span> {summary}
                </div>
              ) : null}
              {/* S2 hook: the room engine reports spend per member; nothing has run before it. */}
              <div>
                <span className="eva-room-card-key">Cost so far</span> $0.00
              </div>
            </HoverCard.Dropdown>
          </HoverCard>
        )
      })}
    </span>
  )
}
