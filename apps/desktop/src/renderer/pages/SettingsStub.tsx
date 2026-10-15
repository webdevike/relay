import type { Place } from '@evaos/shell-core'
import './pages.css'

/** 02-12 replaces this in the registry with the real Settings pages. */
export function SettingsStub({ place }: { place: Place }) {
  return (
    <div className="eva-page" data-testid={`settings-${place.settingsSection.toLowerCase()}`}>
      <div className="eva-page-col">
        <h1 className="eva-page-title">{place.settingsSection}</h1>
      </div>
    </div>
  )
}
