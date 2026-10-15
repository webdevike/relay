import { AppearanceControl } from '../theme/AppearanceControl'

export function ThemeSection() {
  return (
    <>
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
      <div className="eva-settings-card eva-settings-card-pad">
        <h2 className="eva-settings-card-title">Theme editor</h2>
        <p className="eva-settings-desc">
          Editing colors, fonts and shape arrives in a later update.
        </p>
      </div>
    </>
  )
}
