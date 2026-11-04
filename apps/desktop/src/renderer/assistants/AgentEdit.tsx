import { useState, type ReactNode } from 'react'
import { ActionIcon } from '@mantine/core'
import { IconFileText, IconMoodSmile, IconPencil } from '@tabler/icons-react'
import type { Portrait } from '@relay/portrait-motion'
import { chatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { openAvatarEditor } from '../chat/local-rows'
import { openAgentFiles } from '../files/files-store'
import { EvaMenu } from '../overlay'
import { agentTitle } from '../eva/names-store'
import { revealTool } from '../tiling/tiling-store'
import { agentOf, assistantsStore } from './assistants-store'
import './assistants.css'

/** What the header's edit menu needs of the chat it sits in. */
export interface AgentEditTarget {
  paneId: string
}

/** What the instructions item shows dimmed under its label: the two files it opens. */
export const INSTRUCTION_FILES_HINT = 'prime.md, thread.md'

/**
 * An assistant's portrait in its chat header that turns editable on hover: a small pencil appears
 * on it, and clicking opens a menu. "Edit avatar" drops the live avatar editor into the thread;
 * "Edit instructions" opens the Markdown files that define the assistant (its prime.md in front,
 * its thread.md beside it) in the Files tab, where they edit and save like any file.
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
  const editInstructions = (): void => {
    // The Files panel follows the front chat; the instructions open in its panel.
    const file = chatStore.getState().panes[frontChatPaneOf()]?.file || null
    revealTool('files')
    void openAgentFiles(id, name, file).catch((e: unknown) =>
      console.warn(
        `Could not open ${name}'s instructions: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
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
            onClick={editInstructions}
            data-testid="agent-edit-instructions"
          >
            <span className="eva-as-edit-label">Edit instructions</span>
            <span className="eva-as-edit-hint" data-testid="agent-edit-instructions-hint">
              {INSTRUCTION_FILES_HINT}
            </span>
          </EvaMenu.Item>
        </EvaMenu.Dropdown>
      </EvaMenu>
    </span>
  )
}
