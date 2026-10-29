import type { StudioAsset } from '@evaos/contract'
import { EvaModal } from '../overlay'
import { StudioTile } from './StudioGallery'

export interface StudioPickerProps {
  opened: boolean
  /** What the pick is for ("Start frame", "Reference 1"). */
  title: string
  images: readonly StudioAsset[]
  onClose: () => void
  onPick: (asset: StudioAsset) => void
}

/** A grid of the gallery's images and uploads to put into a slot. */
export function StudioPicker({ opened, title, images, onClose, onPick }: StudioPickerProps) {
  return (
    <EvaModal opened={opened} onClose={onClose} size={640} title={title} testid="studio-picker">
      {images.length === 0 ? (
        <p className="eva-studio-empty">No images yet. Upload one, or make one first.</p>
      ) : (
        <div className="eva-studio-grid eva-studio-grid-pick">
          {images.map((asset) => (
            <StudioTile
              key={asset.id}
              asset={asset}
              label={asset.origin === 'upload' ? 'Upload' : 'Output'}
              testid="studio-pick-item"
              onOpen={() => onPick(asset)}
            />
          ))}
        </div>
      )}
    </EvaModal>
  )
}
