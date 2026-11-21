import { ActionIcon, Tooltip } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { keyLabel } from '@evaos/shell-core'
import { saveMedia, type MediaTarget } from './media-actions'

/** A viewer's quiet Download button (top right, before Close): Save Image As… or Save Video As…. */
export function ViewerDownload({ target, testid }: { target: MediaTarget | null; testid: string }) {
  const label = target?.kind === 'video' ? 'Save video' : 'Save image'
  return (
    <Tooltip label={keyLabel(`${label} (⌘S)`)} openDelay={400}>
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label={label}
        data-testid={testid}
        disabled={target === null}
        onClick={() => {
          if (target !== null) void saveMedia(target)
        }}
      >
        <IconDownload size={16} stroke={1.5} />
      </ActionIcon>
    </Tooltip>
  )
}
