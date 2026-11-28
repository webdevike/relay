// A comment's "..." menu: the actions `commentActions` allows for it (ownership, root, write mode).
import { Fragment, useState, type ReactNode } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconCircleCheck,
  IconCircleDashed,
  IconDots,
  IconLink,
  IconMarkdown,
  IconPencil,
  IconSquarePlus,
  IconTrash,
} from '@tabler/icons-react'
import { EvaMenu } from '../overlay'
import type { CommentAction } from './activity-model'

const ITEMS: Record<CommentAction, { label: string; icon: ReactNode; group: number }> = {
  edit: { label: 'Edit', icon: <IconPencil size={15} stroke={1.5} />, group: 0 },
  resolve: { label: 'Resolve thread', icon: <IconCircleCheck size={15} stroke={1.5} />, group: 1 },
  unresolve: {
    label: 'Unresolve thread',
    icon: <IconCircleDashed size={15} stroke={1.5} />,
    group: 1,
  },
  copyLink: { label: 'Copy link to comment', icon: <IconLink size={15} stroke={1.5} />, group: 2 },
  copyMarkdown: {
    label: 'Copy content as Markdown',
    icon: <IconMarkdown size={15} stroke={1.5} />,
    group: 2,
  },
  newIssue: {
    label: 'New issue from comment...',
    icon: <IconSquarePlus size={15} stroke={1.5} />,
    group: 3,
  },
  delete: { label: 'Delete...', icon: <IconTrash size={15} stroke={1.5} />, group: 4 },
}

export function CommentMenu({
  actions,
  onAction,
}: {
  actions: readonly CommentAction[]
  onAction: (a: CommentAction) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <EvaMenu opened={open} onChange={setOpen} position="bottom-end" width={240}>
      <EvaMenu.Target>
        <Tooltip label="Comment actions" openDelay={300}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size={22}
            aria-label="Comment actions"
            data-testid="comment-menu"
          >
            <IconDots size={15} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        {actions.map((a, i) => (
          <Fragment key={a}>
            {i > 0 && ITEMS[actions[i - 1]!].group !== ITEMS[a].group ? <EvaMenu.Divider /> : null}
            <EvaMenu.Item
              leftSection={ITEMS[a].icon}
              onClick={() => onAction(a)}
              data-testid={`comment-action-${a}`}
            >
              {ITEMS[a].label}
            </EvaMenu.Item>
          </Fragment>
        ))}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}
