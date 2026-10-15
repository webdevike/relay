import { useEffect, useState } from 'react'
import { Button, Menu } from '@mantine/core'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { getThemePreset } from '@evaos/theme-core'
import { invoke } from '../ipc'
import { setThemeBase, useTheme } from '../theme/theme-store'
import { AppearanceControl } from '../theme/AppearanceControl'

function Swatches({ family, mode }: { family: string; mode: 'light' | 'dark' }) {
  const colors = getThemePreset(family, mode)?.colors
  return (
    <span className="eva-theme-swatches" aria-hidden="true">
      {(['primary.background', 'background', 'border', 'foreground'] as const).map((key) => (
        <span key={key} style={{ backgroundColor: colors?.[key] ?? 'var(--eva-border)' }} />
      ))}
    </span>
  )
}

export function ThemeSection() {
  const base = useTheme((s) => s.doc.base)
  const mode = useTheme((s) => s.resolved)
  const saving = useTheme((s) => s.baseSaving)
  const saveError = useTheme((s) => s.baseError)
  const [themes, setThemes] = useState<{ id: string; name: string }[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void invoke('theme.list', {})
      .then((result) => {
        if (!live) return
        if (result.ok) setThemes(result.value.themes)
        else setLoadError('Could not load theme families.')
      })
      .catch(() => {
        if (live) setLoadError('Could not load theme families.')
      })
    return () => {
      live = false
    }
  }, [])
  return (
    <>
      <div className="eva-theme-preset-row">
        <span className="eva-theme-preset-label">Start from</span>
        <Menu
          width={300}
          position="bottom-start"
          withinPortal
          classNames={{ dropdown: 'eva-menu-dropdown', item: 'eva-menu-item' }}
        >
          <Menu.Target>
            <Button
              variant="outline"
              size="sm"
              data-testid="theme-family-picker"
              aria-label="Theme family"
              aria-busy={saving}
              disabled={themes === null || saving || loadError !== null}
              title="Theme for both Light and Dark"
            >
              <span className="eva-theme-preset-content">
                <Swatches family={base} mode={mode} />
                {base}
                <IconChevronDown size={11} />
              </span>
            </Button>
          </Menu.Target>
          <Menu.Dropdown style={{ maxHeight: 460, overflowY: 'auto' }}>
            {(themes ?? []).map(({ id, name }, index) => (
              <div key={id}>
                {index === 1 ? (
                  <>
                    <Menu.Divider />
                    <Menu.Label>gpui-kit themes</Menu.Label>
                  </>
                ) : null}
                <Menu.Item
                  onClick={() => void setThemeBase(id)}
                  leftSection={<Swatches family={id} mode={mode} />}
                  rightSection={id === base ? <IconCheck size={14} aria-label="Selected" /> : null}
                >
                  {name}
                </Menu.Item>
              </div>
            ))}
          </Menu.Dropdown>
        </Menu>
      </div>
      {(loadError ?? saveError) ? (
        <p role="alert" className="eva-control-error">
          {loadError ?? saveError}
        </p>
      ) : null}
      <div className="eva-settings-card">
        <div className="eva-settings-row eva-settings-row-static">
          <div className="eva-settings-label">
            <span className="eva-settings-label-title">Appearance</span>
            <span className="eva-settings-label-help">
              Light, Dark or System. System follows your Mac.
            </span>
          </div>
          <div className="eva-settings-appearance">
            <AppearanceControl testid="appearance-settings" iconOnly={false} />
          </div>
        </div>
      </div>
    </>
  )
}
