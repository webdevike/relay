import { useState } from 'react'
import { Box, Combobox, ComboboxPopover, Group, InputBase, Text } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import { useOccludeBrowser } from '../overlay/overlay-store'
import type { ThemeConfig } from '@relay/widget-runtime/theme'
import { useColorScheme } from '../theme/theme-config'

// Texo's TexoThemePicker (packages/ui/src/texo-theme-picker.tsx).

export interface ThemePickerOption {
  config: ThemeConfig
  label: string
  value: string
}

function ThemeSwatches({ config }: { config: ThemeConfig }) {
  const scheme = useColorScheme()
  const colors = [
    config.primaryPalette[6],
    config.semantic[scheme].surface,
    config.semantic[scheme].border,
    config.semantic[scheme].text,
  ]

  return (
    <Group gap={3} wrap="nowrap">
      {colors.map((color, index) => (
        <Box
          key={`${color}-${index}`}
          bg={color}
          h={12}
          w={12}
          style={{
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-sm)',
          }}
        />
      ))}
    </Group>
  )
}

export function ThemePicker({
  onChange,
  options,
  value,
}: {
  onChange: (value: string) => void
  options: ThemePickerOption[]
  value: string
}) {
  const selected = options.find((option) => option.value === value) ?? options[0]!
  const [opened, setOpened] = useState(false)
  // The browser view is a native layer above the page; it hides while the list is open.
  useOccludeBrowser(opened)

  return (
    <ComboboxPopover
      allowDeselect={false}
      checkIconPosition="right"
      classNames={{ option: 'eva-theme-picker-option' }}
      comboboxProps={{
        dropdownPadding: 0,
        offset: { crossAxis: 12, mainAxis: 8 },
        position: 'bottom-start',
        transitionProps: { duration: 150, transition: 'pop-top-left' },
        width: 'calc(min(var(--eva-theme-tools-width), 100vw) - 2 * var(--mantine-spacing-sm))',
      }}
      onDropdownOpen={() => setOpened(true)}
      onDropdownClose={() => setOpened(false)}
      data={options.map((option) => ({ label: option.label, value: option.value }))}
      maxDropdownHeight={360}
      nothingFoundMessage="No themes found"
      onChange={(nextValue) => nextValue && onChange(nextValue)}
      renderOption={({ option, checked }) => {
        const theme = options.find((item) => item.value === option.value)

        return (
          <Group gap="sm" justify="space-between" wrap="nowrap" w="100%">
            <Group gap="sm" wrap="nowrap">
              {theme && <ThemeSwatches config={theme.config} />}
              <Text>{option.label}</Text>
            </Group>
            {checked && (
              <IconCheck
                aria-hidden
                color="var(--mantine-color-dimmed)"
                opacity={0.65}
                size={15}
                stroke={1.75}
              />
            )}
          </Group>
        )
      }}
      searchable
      selectFirstOptionOnDropdownOpen
      withCheckIcon={false}
      value={value}
    >
      <ComboboxPopover.Target>
        <InputBase
          component="button"
          aria-label="Theme preset"
          data-testid="theme-preset-picker"
          pointer
          rightSection={<Combobox.Chevron />}
          rightSectionPointerEvents="none"
          w="100%"
          styles={{
            input: {
              border: 0,
              borderRadius: 0,
              boxShadow: 'none',
              height: '100%',
              paddingInlineStart: 'var(--mantine-spacing-sm)',
            },
            root: { height: '100%' },
            wrapper: { height: '100%' },
          }}
        >
          <Group gap="xs" wrap="nowrap">
            <ThemeSwatches config={selected.config} />
            <Text fw={500} size="sm" truncate>
              {selected.label}
            </Text>
          </Group>
        </InputBase>
      </ComboboxPopover.Target>
    </ComboboxPopover>
  )
}
