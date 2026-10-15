import { useEffect, useId, useState } from 'react'
import { Select } from '@mantine/core'
import { invoke } from '../ipc'
import { setThemeBase, useTheme } from '../theme/theme-store'
import { AppearanceControl } from '../theme/AppearanceControl'

export function ThemeSection() {
  const pickerId = useId()
  const helpId = `${pickerId}-help`
  const base = useTheme((s) => s.doc.base)
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
      <div className="eva-settings-card">
        <div className="eva-settings-row eva-settings-row-static eva-settings-theme-row">
          <div className="eva-settings-label">
            <label className="eva-settings-label-title" htmlFor={pickerId}>
              Theme family
            </label>
            <span className="eva-settings-label-help" id={helpId}>
              Applies to both Light and Dark. Your color edits stay in place.
            </span>
          </div>
          <Select
            id={pickerId}
            data-testid="theme-family-picker"
            className="eva-settings-theme-picker"
            classNames={{
              dropdown: 'eva-settings-theme-dropdown',
              option: 'eva-settings-theme-option',
            }}
            aria-describedby={helpId}
            aria-busy={saving}
            data={(themes ?? [{ id: base, name: base }]).map(({ id, name }) => ({
              value: id,
              label: name,
            }))}
            value={base}
            placeholder={base}
            disabled={themes === null || saving || loadError !== null}
            allowDeselect={false}
            error={loadError ?? saveError}
            errorProps={{ role: 'alert' }}
            onChange={(value) => {
              if (value !== null) void setThemeBase(value)
            }}
          />
        </div>
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
