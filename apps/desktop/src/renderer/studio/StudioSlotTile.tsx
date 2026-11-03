import { useRef, useState, type DragEvent } from 'react'
import { ActionIcon, Loader, Tooltip, UnstyledButton } from '@mantine/core'
import { IconLayoutGrid, IconPlus, IconUpload, IconX } from '@tabler/icons-react'
import type { StudioAsset } from '@evaos/contract'
import { mediaUrl } from '../chat/widgets/media-url'
import { EvaMenu } from '../overlay'

export interface StudioSlotTileProps {
  label: string
  asset: StudioAsset | null
  /** An upload is on its way into this slot. */
  busy: boolean
  testid: string
  onFile: (file: File) => void
  onPick: () => void
  onClear: () => void
}

/**
 * One keyframe or reference slot: empty, "Add" offers Upload from device or Pick from gallery (an
 * image dropped on it uploads too); filled, its thumbnail with a remove button.
 */
export function StudioSlotTile({
  label,
  asset,
  busy,
  testid,
  onFile,
  onPick,
  onClear,
}: StudioSlotTileProps) {
  const [menu, setMenu] = useState(false)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }
  return (
    <div
      className="eva-studio-slot"
      data-testid={testid}
      data-over={over ? 'true' : undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        data-testid={`${testid}-file`}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (file) onFile(file)
        }}
      />
      {asset ? (
        <div className="eva-studio-slot-filled">
          <img className="eva-studio-slot-img" src={mediaUrl(asset.thumb)} alt={label} />
          <Tooltip label={`Remove ${label.toLowerCase()}`} openDelay={400}>
            <ActionIcon
              className="eva-studio-slot-remove"
              size="sm"
              variant="default"
              aria-label={`Remove ${label.toLowerCase()}`}
              onClick={onClear}
            >
              <IconX size={12} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
        </div>
      ) : (
        <EvaMenu opened={menu} onChange={setMenu} position="bottom-start" width={200}>
          <EvaMenu.Target>
            <UnstyledButton
              className="eva-studio-slot-add"
              aria-label={`Add ${label.toLowerCase()}`}
            >
              {busy ? <Loader size="xs" /> : <IconPlus size={16} stroke={1.5} />}
            </UnstyledButton>
          </EvaMenu.Target>
          <EvaMenu.Dropdown>
            <EvaMenu.Item
              leftSection={<IconUpload size={14} stroke={1.5} />}
              onClick={() => input.current?.click()}
            >
              Upload from device
            </EvaMenu.Item>
            <EvaMenu.Item leftSection={<IconLayoutGrid size={14} stroke={1.5} />} onClick={onPick}>
              Pick from gallery
            </EvaMenu.Item>
          </EvaMenu.Dropdown>
        </EvaMenu>
      )}
      <span className="eva-studio-slot-label">{label}</span>
    </div>
  )
}
