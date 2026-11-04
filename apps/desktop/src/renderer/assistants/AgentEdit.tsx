import { useState, type ReactNode } from 'react'
import { ActionIcon } from '@mantine/core'
import { IconFileText, IconMoodSmile, IconPencil } from '@tabler/icons-react'
import type { Portrait } from '@relay/portrait-motion'
import { openAvatarEditor } from '../chat/local-rows'
import { EvaMenu } from '../overlay'
import { agentTitle } from '../eva/names-store'
import { agentOf, assistantsStore } from './assistants-store'
import './assistants.css'

/** What the header's edit menu needs of the chat it sits in. */
export interface AgentEditTarget {
  paneId: string
  /** Sends `text` as the user's next message in this chat. */
  reply(text: string): void
}

/** What the assistant is asked when the user wants to change its instructions. */
export const EDIT_INSTRUCTIONS_MESSAGE = "I'd like to change your instructions"

/**
 * An assistant's portrait in its chat header that turns editable on hover: a small pencil appears
 * on it, and clicking opens a menu. "Edit avatar" drops the live avatar editor into the thread;
 * "Edit instructions" asks the assistant, as the user's next message, to open its instructions
 * with them. Configuring it reads as asking it, not as filling a settings form.
 */
export function AgentEdit({
  id,
  target,
  children,
}: {
  id: string
  target: AgentEditTarget
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const name = agentTitle(id) ?? id
  const editAvatar = (): void => {
    const face = agentOf(assistantsStore.getState(), id)?.avatar
    const current: Portrait = face ?? { style: 'notionists', seed: id }
    openAvatarEditor(target.paneId, id, current)
  }
  return (
    <span className="eva-as-edit" data-open={open || undefined} data-testid="agent-edit">
      {children}
      <EvaMenu opened={open} onChange={setOpen} position="bottom-start" width={200}>
        <EvaMenu.Target>
          <ActionIcon
            variant="default"
            size="xs"
            radius="xl"
            className="eva-as-edit-pencil"
            aria-label={`Edit ${name}`}
            data-testid="agent-edit-pencil"
          >
            <IconPencil size={12} stroke={1.75} />
          </ActionIcon>
        </EvaMenu.Target>
        <EvaMenu.Dropdown>
          <EvaMenu.Item
            leftSection={<IconMoodSmile size={16} stroke={1.5} />}
            onClick={editAvatar}
            data-testid="agent-edit-avatar"
          >
            Edit avatar
          </EvaMenu.Item>
          <EvaMenu.Item
            leftSection={<IconFileText size={16} stroke={1.5} />}
            onClick={() => target.reply(EDIT_INSTRUCTIONS_MESSAGE)}
            data-testid="agent-edit-instructions"
          >
            Edit instructions
          </EvaMenu.Item>
        </EvaMenu.Dropdown>
      </EvaMenu>
    </span>
  )
}
