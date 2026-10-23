import type { ReactNode } from 'react'
import { Button, CheckIcon, Combobox, Group, Text, useCombobox } from '@mantine/core'
import { useOccludeBrowser } from '../../overlay/overlay-store'
import { DISMISS_PRIORITY, useDismissable } from '../../hotkeys/dismiss'

export interface PickerOption {
  value: string
  label: string
  active: boolean
  testid: string
}

export interface PickerGroup {
  label?: string
  options: PickerOption[]
}

/**
 * A composer toolbar picker drawn with stock Mantine: a compact subtle Button opening the same
 * Combobox dropdown Mantine's Select uses, with a check on the active option of each group.
 */
export function Picker({
  label,
  testid,
  disabled,
  icon,
  children,
  groups,
  empty,
  onPick,
}: {
  /** Accessible name of the button and the listbox. */
  label: string
  testid: string
  disabled: boolean
  icon?: ReactNode
  /** What the button shows. */
  children: ReactNode
  groups: PickerGroup[]
  empty?: string
  onPick: (value: string) => void
}) {
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  })
  const opened = combobox.dropdownOpened && !disabled
  // The browser view is a native layer above the page; it hides while the list is open.
  useOccludeBrowser(opened)
  useDismissable(DISMISS_PRIORITY.overlay, () => combobox.closeDropdown(), opened)
  const count = groups.reduce((n, g) => n + g.options.length, 0)
  return (
    <Combobox
      store={combobox}
      position="top-start"
      width="max-content"
      withinPortal
      zIndex={300}
      onOptionSubmit={(value) => {
        combobox.closeDropdown()
        onPick(value)
      }}
    >
      <Combobox.Target targetType="button">
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          fw={400}
          data-testid={testid}
          aria-label={label}
          aria-disabled={disabled}
          disabled={disabled}
          leftSection={icon}
          rightSection={<Combobox.Chevron size="xs" />}
          onClick={() => combobox.toggleDropdown()}
        >
          {children}
        </Button>
      </Combobox.Target>
      <Combobox.Dropdown miw={180} maw="min(320px, calc(100vw - 32px))">
        <Combobox.Options aria-label={label} mah={360} style={{ overflowY: 'auto' }}>
          {count === 0 && empty ? <Combobox.Empty>{empty}</Combobox.Empty> : null}
          {groups.map((group, i) => {
            const options = group.options.map((o) => (
              <Combobox.Option
                key={o.value}
                value={o.value}
                active={o.active}
                aria-selected={o.active}
                data-testid={o.testid}
              >
                <Group gap="xs" wrap="nowrap">
                  {o.active ? <CheckIcon size={12} /> : <span style={{ width: 12 }} />}
                  <Text size="sm" truncate>
                    {o.label}
                  </Text>
                </Group>
              </Combobox.Option>
            ))
            return group.label ? (
              <Combobox.Group key={group.label} label={group.label}>
                {options}
              </Combobox.Group>
            ) : (
              <div key={i}>{options}</div>
            )
          })}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  )
}
