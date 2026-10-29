import { useState } from 'react'
import { ActionIcon, Button, Group, Tooltip } from '@mantine/core'
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconPhotoUp,
  IconTrash,
  IconWand,
} from '@tabler/icons-react'
import type { StudioJob } from '@evaos/contract'
import { mediaUrl } from '../chat/widgets/media-url'
import { EvaMenu, EvaModal } from '../overlay'
import type { StudioSlot } from './studio-form'

const USES: Array<{ slot: StudioSlot; image: string; video: string }> = [
  { slot: 'start', image: 'As start frame', video: 'Last frame as start' },
  { slot: 'mid', image: 'As mid frame', video: 'Last frame as mid' },
  { slot: 'end', image: 'As end frame', video: 'Last frame as end' },
  { slot: 'ref', image: 'As reference image', video: 'Last frame as reference' },
]

export interface StudioViewerProps {
  job: StudioJob | null
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  onRemix: (job: StudioJob) => void
  /** Puts the output (a video: its last frame) into a composer slot. */
  onUse: (job: StudioJob, index: number, slot: StudioSlot) => void
  onDownload: (job: StudioJob, index: number) => void
  onDelete: (job: StudioJob) => void
}

/** A finished job's output full screen (an image, or a video that plays), with what to do next. */
export function StudioViewer({
  job,
  index,
  onIndex,
  onClose,
  onRemix,
  onUse,
  onDownload,
  onDelete,
}: StudioViewerProps) {
  const [menu, setMenu] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const asset = job?.outputs[index] ?? null
  const last = (job?.outputs.length ?? 1) - 1
  const close = (): void => {
    setConfirming(false)
    onClose()
  }
  return (
    <EvaModal
      opened={job !== null && asset !== null}
      onClose={close}
      fullScreen
      testid="studio-viewer"
      title={
        <span className="eva-studio-viewer-title" title={job?.spec.prompt}>
          {job?.spec.prompt}
        </span>
      }
      actions={
        job && asset ? (
          confirming ? (
            <Group gap="xs" wrap="nowrap" data-testid="studio-delete-confirm">
              <span className="eva-studio-faint">Delete this job and its files?</span>
              <Button size="xs" variant="default" onClick={() => setConfirming(false)}>
                Keep
              </Button>
              <Button
                size="xs"
                color="red"
                data-testid="studio-delete-yes"
                onClick={() => {
                  setConfirming(false)
                  onDelete(job)
                }}
              >
                Delete
              </Button>
            </Group>
          ) : (
            <Group gap="xs" wrap="nowrap">
              {last > 0 ? (
                <>
                  <Tooltip label="Previous" openDelay={400}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Previous"
                      disabled={index === 0}
                      onClick={() => onIndex(Math.max(0, index - 1))}
                    >
                      <IconChevronLeft size={16} stroke={1.5} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Next" openDelay={400}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Next"
                      disabled={index >= last}
                      onClick={() => onIndex(Math.min(last, index + 1))}
                    >
                      <IconChevronRight size={16} stroke={1.5} />
                    </ActionIcon>
                  </Tooltip>
                </>
              ) : null}
              <Button
                size="xs"
                leftSection={<IconWand size={14} stroke={1.5} />}
                data-testid="studio-remix"
                onClick={() => onRemix(job)}
              >
                Remix
              </Button>
              <EvaMenu opened={menu} onChange={setMenu} position="bottom-end" width={220}>
                <EvaMenu.Target>
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconPhotoUp size={14} stroke={1.5} />}
                    data-testid="studio-use"
                  >
                    {asset.kind === 'video' ? 'Use last frame' : 'Use as frame'}
                  </Button>
                </EvaMenu.Target>
                <EvaMenu.Dropdown>
                  {USES.map((u) => (
                    <EvaMenu.Item
                      key={u.slot}
                      data-testid={`studio-use-${u.slot}`}
                      onClick={() => onUse(job, index, u.slot)}
                    >
                      {asset.kind === 'video' ? u.video : u.image}
                    </EvaMenu.Item>
                  ))}
                </EvaMenu.Dropdown>
              </EvaMenu>
              <Tooltip label="Download" openDelay={400}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Download"
                  data-testid="studio-download"
                  onClick={() => onDownload(job, index)}
                >
                  <IconDownload size={16} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Delete" openDelay={400}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Delete"
                  data-testid="studio-delete"
                  onClick={() => setConfirming(true)}
                >
                  <IconTrash size={16} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            </Group>
          )
        ) : null
      }
    >
      <div className="eva-studio-stage">
        {asset ? (
          asset.kind === 'video' ? (
            <video
              key={asset.id}
              className="eva-studio-stage-media"
              src={mediaUrl(asset.path)}
              poster={mediaUrl(asset.thumb)}
              controls
              autoPlay
              data-testid="studio-viewer-video"
            />
          ) : (
            <img
              key={asset.id}
              className="eva-studio-stage-media"
              src={mediaUrl(asset.path)}
              alt={job?.spec.prompt ?? ''}
              data-testid="studio-viewer-image"
            />
          )
        ) : null}
      </div>
    </EvaModal>
  )
}
