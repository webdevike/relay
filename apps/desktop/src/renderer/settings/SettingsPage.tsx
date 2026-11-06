import { useEffect } from 'react'
import type { Place } from '@evaos/shell-core'
import { AboutSection } from './AboutSection'
import { ChangelogSection } from './ChangelogSection'
import { ChatSection } from './ChatSection'
import { ConnectionsSection } from './ConnectionsSection'
import { LinksSection } from './LinksSection'
import { NotificationsSection } from './NotificationsSection'
import { SetupSection } from '../setup/SetupSection'
import { ThemeSection } from './ThemeSection'
import { startSettings } from './settings-store'
import './settings.css'

const SECTIONS = {
  Theme: { Body: ThemeSection, desc: 'Colors, fonts and shape for the whole app.' },
  Chat: { Body: ChatSection, desc: "What conversations show besides Eva's replies." },
  Links: { Body: LinksSection, desc: 'Where clicked links open, by site.' },
  Notifications: {
    Body: NotificationsSection,
    desc: 'Desktop notifications on this Mac: what shows, and which assistants stay quiet.',
  },
  Connections: {
    Body: ConnectionsSection,
    desc: 'The services Relay reads from or signs in to. A key you save here stays in Relay: nobody, agents included, can read it back.',
  },
  Setup: { Body: SetupSection, desc: 'Check your tools, AI sign-in, Relay Host and iPhone again.' },
  About: {
    Body: AboutSection,
    desc: 'This build, the host it talks to, and credits for the art Relay ships.',
  },
  Changelog: { Body: ChangelogSection, desc: 'Every build and host install, newest first.' },
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
        <h1 className="eva-settings-title" data-page-title>
          {name}
        </h1>
        <p className="eva-settings-desc">{desc}</p>
        <Body />
      </div>
    </div>
  )
}
