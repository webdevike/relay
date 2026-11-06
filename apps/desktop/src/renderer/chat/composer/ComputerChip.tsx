import { ActionIcon } from '@mantine/core'
import { IconDeviceDesktop, IconX } from '@tabler/icons-react'
import { Picker } from './Picker'
import { MODE_WORD, type ComputerMode } from './at-menu'

const MODES: ComputerMode[] = ['headless', 'live', 'walk']

/**
 * The Computer chip leading the composer's first line: one unit, so Backspace at the start of the
 * text or the x removes all of it. Clicking it opens the mode list (background, live, walk).
 */
export function ComputerChip({
  mode,
  onMode,
  onRemove,
}: {
  mode: ComputerMode
  onMode: (mode: ComputerMode) => void
  onRemove: () => void
}) {
  return (
    <div className="eva-composer-computer" data-testid="computer-chip" data-mode={mode}>
      <Picker
        label="Computer mode"
        testid="computer-chip-mode"
        disabled={false}
        icon={<IconDeviceDesktop size={14} />}
        groups={[
          {
            options: MODES.map((m) => ({
              value: m,
              label:
                m === 'headless'
                  ? 'Background'
                  : MODE_WORD[m][0]!.toUpperCase() + MODE_WORD[m].slice(1),
              active: m === mode,
              testid: `computer-chip-${m}`,
            })),
          },
        ]}
        onPick={(v) => onMode(v as ComputerMode)}
      >
        Computer{mode === 'headless' ? '' : ` ${MODE_WORD[mode]}`}
      </Picker>
      <ActionIcon
        size="var(--eva-kit-control-xs)"
        variant="subtle"
        aria-label="Remove Computer"
        data-testid="computer-chip-remove"
        onClick={onRemove}
      >
        <IconX size={12} />
      </ActionIcon>
    </div>
  )
}
