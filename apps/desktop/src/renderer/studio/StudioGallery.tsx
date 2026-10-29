import { useState } from 'react'
import { UnstyledButton } from '@mantine/core'
import { IconMovie, IconPhotoOff, IconPlayerPlayFilled } from '@tabler/icons-react'
import type { StudioAsset, StudioJob } from '@evaos/contract'
import { mediaUrl } from '../chat/widgets/media-url'
import { durationLabel } from './studio-assets'

/** One finished output, square-cropped; a video shows its length. */
export function StudioTile({
  asset,
  label,
  onOpen,
  testid,
}: {
  asset: StudioAsset
  label: string
  onOpen: () => void
  testid: string
}) {
  const [failed, setFailed] = useState(false)
  return (
    <UnstyledButton
      className="eva-studio-tile"
      aria-label={label}
      title={label}
      data-testid={testid}
      onClick={onOpen}
    >
      {failed ? (
        <span className="eva-studio-tile-empty">
          {asset.kind === 'video' ? (
            <IconMovie size={20} stroke={1.5} />
          ) : (
            <IconPhotoOff size={20} stroke={1.5} />
          )}
        </span>
      ) : (
        <img src={mediaUrl(asset.thumb)} alt="" loading="lazy" onError={() => setFailed(true)} />
      )}
      {asset.kind === 'video' ? (
        <span className="eva-studio-tile-tag">
          <IconPlayerPlayFilled size={10} />
          {asset.durationMs !== undefined ? durationLabel(asset.durationMs) : null}
        </span>
      ) : null}
    </UnstyledButton>
  )
}

export interface StudioGalleryProps {
  /** Finished jobs, newest first. */
  jobs: readonly StudioJob[]
  onOpen: (job: StudioJob, index: number) => void
}

/** Every finished output as a grid of square thumbnails, newest first. */
export function StudioGallery({ jobs, onOpen }: StudioGalleryProps) {
  const tiles = jobs.flatMap((job) => job.outputs.map((asset, index) => ({ job, asset, index })))
  if (tiles.length === 0) {
    return (
      <p className="eva-studio-empty" data-testid="studio-empty">
        Nothing made yet. Write a prompt and press Generate.
      </p>
    )
  }
  return (
    <div className="eva-studio-grid" data-testid="studio-gallery">
      {tiles.map(({ job, asset, index }) => (
        <StudioTile
          key={asset.id}
          asset={asset}
          label={job.spec.prompt}
          testid="studio-gallery-item"
          onOpen={() => onOpen(job, index)}
        />
      ))}
    </div>
  )
}
