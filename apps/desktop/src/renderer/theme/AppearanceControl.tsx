import { SegmentedControl, Tooltip } from '@mantine/core'
import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react'
import type { Appearance } from '@evaos/theme-core'
import { setAppearance, useAppearance } from './theme-store'
import './appearance.css'

const ITEMS: { value: Appearance; label: string; Icon: typeof IconSun }[] = [
  { value: 'light', label: 'Light', Icon: IconSun },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
  { value: 'system', label: 'System', Icon: IconDeviceDesktop },
]

export interface AppearanceControlProps {
  iconOnly?: boolean
  /** Root testid; Settings passes appearance-settings. */
  testid?: string
}

export function AppearanceControl({
  iconOnly = false,
  testid = 'appearance',
}: AppearanceControlProps) {
  const value = useAppearance()
  const data = ITEMS.map(({ value: v, label, Icon }) => {
    const inner = (
      <span
        className="eva-appearance-seg"
        data-testid={`appearance-${v}`}
        data-active={v === value ? 'true' : undefined}
        aria-label={iconOnly ? label : undefined}
      >
        <Icon size={14} aria-hidden />
        {iconOnly ? null : <span className="eva-appearance-label">{label}</span>}
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
      className="eva-appearance"
      data-testid={testid}
      fullWidth
      aria-label="Appearance"
      role="radiogroup"
      data={data}
      value={value}
      onChange={(v) => setAppearance(v as Appearance)}
    />
  )
}
