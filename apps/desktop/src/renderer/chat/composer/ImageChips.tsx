import { ActionIcon } from '@mantine/core'
import { IconX } from '@tabler/icons-react'

export interface Chip {
  id: string
  previewUrl: string
}

/** 48px thumbnails of the images attached to the next prompt, each with a remove button. */
export function ImageChips({
  chips,
  onRemove,
}: {
  chips: readonly Chip[]
  onRemove: (id: string) => void
}) {
  if (chips.length === 0) return null
  return (
    <div className="eva-composer-chips" data-testid="composer-chips">
      {chips.map((chip, i) => (
        <div key={chip.id} className="eva-composer-chip" data-testid="composer-chip">
          <img src={chip.previewUrl} alt={`Pasted image ${i + 1}`} draggable={false} />
          <ActionIcon
            size={20}
            radius="xl"
            variant="filled"
            className="eva-composer-chip-remove"
            aria-label={`Remove image ${i + 1}`}
            onClick={() => onRemove(chip.id)}
          >
            <IconX size={12} />
          </ActionIcon>
        </div>
      ))}
    </div>
  )
}
