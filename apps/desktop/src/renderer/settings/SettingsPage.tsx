import { useEffect } from 'react'
import type { Place } from '@evaos/shell-core'
import { AboutSection } from './AboutSection'
import { ChatSection } from './ChatSection'
import { ThemeSection } from './ThemeSection'
import { startSettings } from './settings-store'
import './settings.css'

const SECTIONS = {
  Theme: { Body: ThemeSection, desc: 'Colors, fonts and shape for the whole app.' },
  Chat: { Body: ChatSection, desc: "What conversations show besides Eva's replies." },
  About: { Body: AboutSection, desc: 'Credits for the art EvaOS ships.' },
} as const

export function SettingsPage({ place }: { place: Place }) {
  useEffect(() => {
    void startSettings()
  }, [])
  const name = (
    place.settingsSection in SECTIONS ? place.settingsSection : 'Theme'
  ) as keyof typeof SECTIONS
  const { Body, desc } = SECTIONS[name]
  if (name === 'Theme') {
    return (
      <div className="eva-settings eva-settings-theme" data-testid="settings-theme">
        <ThemeSection />
      </div>
    )
  }
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
