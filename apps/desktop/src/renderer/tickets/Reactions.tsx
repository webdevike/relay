// A comment's reactions: emoji and count, who on hover, a click sets Isaac's own (desired state on
// the wire, so a repeat is a no-op). Linear names emoji (`+1`, `tada`); they show via slack-emoji.
import { useState } from 'react'
import { ActionIcon, Tooltip, UnstyledButton } from '@mantine/core'
import { IconMoodPlus } from '@tabler/icons-react'
import type { TicketComment } from '@relay/protocol'
import { reactionEmoji } from '@relay/slack-emoji'
import { EvaPopover } from '../overlay'

/** What the add-reaction picker offers, as Linear names them. */
const PICKER = ['+1', 'heart', 'tada', 'smile', 'eyes', 'rocket', 'white_check_mark', 'pray']

export function Reactions({
  reactions,
  meId,
  canReact,
  onSet,
}: {
  reactions: TicketComment['reactions']
  meId: string | null
  /** Writes are open (the gate): chips toggle and the picker shows. */
  canReact: boolean
  /** Sets Isaac's reaction `emoji` to `on`. */
  onSet: (emoji: string, on: boolean) => void
}) {
  const [picking, setPicking] = useState(false)
  if (reactions.length === 0 && !canReact) return null
  return (
    <div className="eva-tk-reactions" data-testid="comment-reactions">
      {reactions.map((r) => {
        const mine = meId !== null && r.users.some((u) => u.id === meId)
        return (
          <Tooltip key={r.emoji} label={r.users.map((u) => u.name).join(', ')} openDelay={300}>
            <UnstyledButton
              className="eva-tk-reaction"
              data-mine={mine || undefined}
              disabled={!canReact}
              aria-pressed={mine}
              aria-label={`${reactionEmoji(r.emoji)} ${r.users.length}`}
              onClick={() => onSet(r.emoji, !mine)}
              data-testid="comment-reaction"
            >
              <span>{reactionEmoji(r.emoji)}</span>
              <span>{r.users.length}</span>
            </UnstyledButton>
          </Tooltip>
        )
      })}
      {canReact ? (
        <EvaPopover opened={picking} onChange={setPicking} position="bottom-start">
          <EvaPopover.Target>
            <Tooltip label="Add reaction" openDelay={300}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size={22}
                aria-label="Add reaction"
                data-testid="comment-react-add"
              >
                <IconMoodPlus size={14} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </EvaPopover.Target>
          <EvaPopover.Dropdown>
            <div className="eva-tk-picker">
              {PICKER.map((e) => (
                <UnstyledButton
                  key={e}
                  className="eva-tk-pick"
                  aria-label={`React ${reactionEmoji(e)}`}
                  onClick={() => {
                    setPicking(false)
                    const mine = reactions.some(
                      (r) => r.emoji === e && r.users.some((u) => u.id === meId),
                    )
                    onSet(e, !mine)
                  }}
                >
                  {reactionEmoji(e)}
                </UnstyledButton>
              ))}
            </div>
          </EvaPopover.Dropdown>
        </EvaPopover>
      ) : null}
    </div>
  )
}
