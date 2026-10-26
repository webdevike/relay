import { ActionIcon, Avatar, Tooltip } from '@mantine/core'
import { IconMoodSmile, IconPin } from '@tabler/icons-react'
import { useState } from 'react'
import { Markdown } from '../chat/markdown/Markdown'
import { EvaPopover } from '../overlay'
import { ROOM_JUDGE, ROOM_SYSTEM } from '@evaos/contract'
import { mentionMarkdown } from './mentions'
import { ISAAC_PERSON, JUDGE_PERSON, SYSTEM_PERSON } from './roster'
import { toggleReaction } from './rooms-store'
import { ISAAC, type RoomAgent, type RoomMessage } from './types'

export const EMOJI = ['👍', '👀', '🔥', '💯', '😂', '🤔', '✅', '❌', '🎉', '🙏', '❤️', '🚀']

/** Who a message is from: an agent, Isaac, or a placeholder for an id the room does not know. */
export interface Author {
  name: string
  title: string
  /** The persona behind the person; empty for Isaac. */
  role: string
  color: string
  avatar: string
}

export function authorOf(agents: readonly RoomAgent[], id: string): Author {
  if (id === ISAAC) return ISAAC_PERSON
  if (id === ROOM_JUDGE) return JUDGE_PERSON
  if (id === ROOM_SYSTEM) return SYSTEM_PERSON
  return (
    agents.find((x) => x.id === id) ?? { name: id, title: '', role: '', color: 'gray', avatar: '' }
  )
}

/** "Mara" of "Mara Voss"; what the room calls people in running text. */
export const firstName = (author: Author): string => author.name.split(' ')[0] ?? author.name

export function AuthorAvatar({ author, size }: { author: Author; size: 'sm' | 'md' }) {
  return (
    <Avatar
      size={size}
      radius="xl"
      color={author.color}
      src={author.avatar || null}
      alt=""
      className="eva-room-avatar"
    >
      {(Array.from(author.name)[0] ?? '?').toUpperCase()}
    </Avatar>
  )
}

const timeLabel = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** "Theo", "Theo and Jonah", "Theo, Jonah and you". */
function namesLabel(agents: readonly RoomAgent[], by: readonly string[]): string {
  const names = by.map((id) => (id === ISAAC ? 'you' : firstName(authorOf(agents, id))))
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface RoomMessageRowProps {
  roomId: string
  msg: RoomMessage
  agents: readonly RoomAgent[]
  /** A later message of the same author within the group window: no avatar or name header. */
  continuation: boolean
}

export function RoomMessageRow({ roomId, msg, agents, continuation }: RoomMessageRowProps) {
  const author = authorOf(agents, msg.author)
  const [picker, setPicker] = useState(false)
  const summary = msg.kind === 'summary'
  const react = (emoji: string): void => {
    void toggleReaction(roomId, msg.id, emoji)
    setPicker(false)
  }
  return (
    <div
      className="eva-room-row"
      data-continuation={continuation ? 'true' : undefined}
      data-summary={summary ? 'true' : undefined}
      data-open={picker ? 'true' : undefined}
      data-testid={`room-msg-${msg.id}`}
    >
      <div className="eva-room-row-gutter">
        {continuation ? (
          <span className="eva-room-row-time eva-room-row-time-hover">{timeLabel(msg.ts)}</span>
        ) : (
          <AuthorAvatar author={author} size="md" />
        )}
      </div>
      <div className="eva-room-row-main">
        {continuation ? null : (
          <div className="eva-room-row-head">
            <span className="eva-room-row-name">{author.name}</span>
            {author.title ? <span className="eva-room-row-title">{author.title}</span> : null}
            {author.role ? <span className="eva-room-row-role">{author.role}</span> : null}
            <span className="eva-room-row-time">{timeLabel(msg.ts)}</span>
          </div>
        )}
        {summary ? (
          <div className="eva-room-summary">
            <div className="eva-room-summary-head">
              <IconPin size={14} stroke={1.5} aria-hidden />
              Pinned decision
            </div>
            <Markdown text={mentionMarkdown(msg.text, agents)} />
          </div>
        ) : (
          <Markdown text={mentionMarkdown(msg.text, agents)} />
        )}
        {msg.reactions.length > 0 ? (
          <div className="eva-room-reactions">
            {msg.reactions.map((r) => (
              <Tooltip key={r.emoji} label={namesLabel(agents, r.by)} openDelay={300}>
                <button
                  type="button"
                  className="eva-room-reaction"
                  data-mine={r.by.includes(ISAAC) ? 'true' : undefined}
                  aria-pressed={r.by.includes(ISAAC)}
                  onClick={() => react(r.emoji)}
                >
                  <span>{r.emoji}</span>
                  <span className="eva-room-reaction-count">{r.by.length}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </div>
      <div className="eva-room-row-actions">
        <EvaPopover opened={picker} onChange={setPicker} position="bottom-end">
          <Tooltip label="Add reaction" openDelay={300} disabled={picker}>
            <EvaPopover.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Add reaction"
                onClick={() => setPicker((o) => !o)}
              >
                <IconMoodSmile size={16} stroke={1.5} />
              </ActionIcon>
            </EvaPopover.Target>
          </Tooltip>
          <EvaPopover.Dropdown>
            <div className="eva-room-emoji-grid" role="group" aria-label="Pick a reaction">
              {EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="eva-room-emoji"
                  aria-label={`React with ${e}`}
                  onClick={() => react(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          </EvaPopover.Dropdown>
        </EvaPopover>
      </div>
    </div>
  )
}
