import { ActionIcon } from '@mantine/core'
import { IconAdjustments, IconX } from '@tabler/icons-react'
import { removeChip, type DesignChip } from '../../browser/design/design-chips'
import { designActorOf } from '../../browser/design/design-runtime'

/**
 * Design Mode's selection as chips in the composer: element name and a screenshot thumbnail (his
 * drawing on it, when he drew), and one chip for his style edits. They go with the next message;
 * removing one drops it from the selection.
 */
export function DesignChips({ tabId, chips }: { tabId: string; chips: readonly DesignChip[] }) {
  return (
    <div className="eva-composer-chips" data-testid="composer-design-chips">
      {chips.map((chip) => (
        <div
          key={chip.id}
          className="eva-composer-chip"
          data-testid="composer-design-chip"
          data-kind={chip.kind}
        >
          {chip.png ? (
            <img src={`data:image/png;base64,${chip.png}`} alt="" draggable={false} />
          ) : (
            <IconAdjustments size={16} aria-hidden />
          )}
          <span className="eva-composer-chip-name" title={chip.label}>
            {chip.label}
            {chip.drawn ? ' (drawn)' : ''}
          </span>
          <ActionIcon
            size="var(--eva-kit-control-xs)"
            variant="subtle"
            className="eva-composer-chip-remove"
            aria-label={`Remove ${chip.label}`}
            data-testid="composer-design-chip-remove"
            onClick={() => removeChip(designActorOf(tabId), chip)}
          >
            <IconX size={12} />
          </ActionIcon>
        </div>
      ))}
    </div>
  )
}
