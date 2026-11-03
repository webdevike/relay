import { SegmentedControl, Tooltip } from '@mantine/core'
import { IconMoon, IconSun } from '@tabler/icons-react'
import type { ColorScheme } from '@relay/widget-runtime/theme'
import { setColorScheme, useColorScheme } from './theme-config'
import './appearance.css'

const ITEMS: { value: ColorScheme; label: string; Icon: typeof IconSun }[] = [
  { value: 'light', label: 'Light', Icon: IconSun },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
]

export interface AppearanceControlProps {
  iconOnly?: boolean
  testid?: string
}

/** The theme config's color scheme, as Texo's header toggle sets it. */
export function AppearanceControl({
  iconOnly = false,
  testid = 'appearance',
}: AppearanceControlProps) {
  const value = useColorScheme()
  const data = ITEMS.map(({ value: v, label, Icon }) => {
    const inner = (
      <span
        className="eva-appearance-seg"
        data-testid={`appearance-${v}`}
        data-active={v === value ? 'true' : undefined}
        aria-label={iconOnly ? label : undefined}
      >
        <Icon size={14} aria-hidden />
        {iconOnly ? null : <span>{label}</span>}
      </span>
    )
    return {
      value: v,
      label: iconOnly ? (
        <Tooltip label={label} withinPortal>
          {inner}
        </Tooltip>
      ) : (
        inner
      ),
    }
  })
  return (
    <SegmentedControl
      data-testid={testid}
      fullWidth
      aria-label="Appearance"
      role="radiogroup"
      data={data}
      value={value}
      onChange={(v) => setColorScheme(v as ColorScheme)}
    />
  )
}
