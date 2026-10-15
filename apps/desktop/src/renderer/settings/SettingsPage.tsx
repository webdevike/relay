import { useEffect } from 'react'
import type { Place } from '@evaos/shell-core'
import { ChatSection } from './ChatSection'
import { NotificationsSection } from './NotificationsSection'
import { ThemeSection } from './ThemeSection'
import { startSettings } from './settings-store'
import './settings.css'

const SECTIONS = {
  Theme: { Body: ThemeSection, desc: 'Colors, fonts and shape for the whole app.' },
  Chat: { Body: ChatSection, desc: "What conversations show besides Eva's replies." },
  Notifications: { Body: NotificationsSection, desc: 'How the inbox tells you about new items.' },
} as const

export function SettingsPage({ place }: { place: Place }) {
  useEffect(() => {
    void startSettings()
  }, [])
  const name = (
    place.settingsSection in SECTIONS ? place.settingsSection : 'Theme'
  ) as keyof typeof SECTIONS
  const { Body, desc } = SECTIONS[name]
  return (
    <div className="eva-settings" data-testid={`settings-${name.toLowerCase()}`}>
      <div className="eva-settings-col">
        <h1 className="eva-settings-title">{name}</h1>
        <p className="eva-settings-desc">{desc}</p>
        <Body />
      </div>
    </div>
  )
}
