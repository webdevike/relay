/** Place model, ported from the Rust app's tabs.rs so layout.json stays interchangeable. */

export type FixedPage =
  | 'dashboard'
  | 'assistants'
  | 'chat'
  | 'skills'
  | 'jobs'
  | 'test-bench'
  | 'habits'
  | 'meetings'
  | 'canvas'
  | 'rooms'
  | 'studio'
  | 'reviews'
  | 'settings'
  | 'setup'
/**
 * `agent:<id>` is a registry agent's thread (native Page::Agent), `board:<slug>` a Relay host
 * dashboard (native Page::Board); both saved like native tabs.rs. `review:<kind>:<id>` is one
 * Reviews item (a pull request, Linear issue or Slack thread) as its own place, so it opens in
 * its own tab or pane; the app defines the id (`review:pr:owner/repo#12`).
 */
export type PageKey =
  FixedPage | `workspace:${string}` | `agent:${string}` | `board:${string}` | `review:${string}`

export const SETTINGS_SECTIONS = [
  'Theme',
  'Chat',
  'Links',
  'Notifications',
  'Connections',
  'Setup',
  'About',
  'Changelog',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export interface Place {
  page: PageKey
  /** 'draft', a session path, or null on pages other than chat. */
  chat: string | null
  settingsSection: SettingsSection
  meeting: string | null
  /** The board's slug on the Canvas page; null opens the newest. */
  canvas: string | null
}

const FIXED_PAGES: readonly string[] = [
  'dashboard',
  'assistants',
  'chat',
  'skills',
  'jobs',
  'test-bench',
  'habits',
  'meetings',
  'canvas',
  'rooms',
  'studio',
  'reviews',
  'settings',
  'setup',
]

export function pageKey(page: PageKey): string {
  return page
}

export function pageFromKey(key: string): PageKey | null {
  if (key.startsWith('workspace:')) return key as PageKey
  if (key.startsWith('agent:') && key.length > 'agent:'.length) return key as PageKey
  if (key.startsWith('board:') && key.length > 'board:'.length) return key as PageKey
  if (key.startsWith('review:') && key.length > 'review:'.length) return key as PageKey
  return FIXED_PAGES.includes(key) ? (key as PageKey) : null
}

export function placeOf(page: PageKey, extra: Partial<Omit<Place, 'page'>> = {}): Place {
  return {
    page,
    chat: page === 'chat' ? 'draft' : null,
    settingsSection: 'Theme',
    meeting: null,
    canvas: null,
    ...extra,
  }
}

/** Places match by what they show; two draft chats are two new chats. */
export function samePlace(a: Place, b: Place): boolean {
  if (a.page !== b.page) return false
  if (a.page === 'chat') {
    if (a.chat === 'draft' || b.chat === 'draft') return false
    return a.chat === b.chat
  }
  if (a.page === 'settings') return a.settingsSection === b.settingsSection
  if (a.page === 'meetings') return a.meeting === b.meeting
  if (a.page === 'canvas') return a.canvas === b.canvas
  return true
}

/** Strict structural equality (drafts equal drafts), used to decide whether a navigation moved. */
export function placeEquals(a: Place, b: Place): boolean {
  return (
    a.page === b.page &&
    a.chat === b.chat &&
    a.settingsSection === b.settingsSection &&
    a.meeting === b.meeting &&
    a.canvas === b.canvas
  )
}

export function placeKey(place: Place): string {
  switch (place.page) {
    case 'chat':
      return `chat:${place.chat ?? 'draft'}`
    case 'settings':
      return `settings:${place.settingsSection}`
    case 'meetings':
      return place.meeting === null ? 'page:meetings' : `meeting:${place.meeting}`
    case 'canvas':
      return place.canvas === null ? 'page:canvas' : `canvas:${place.canvas}`
    default:
      return place.page.includes(':') ? place.page : `page:${place.page}`
  }
}

export interface PlaceJson {
  page: string
  chat: string | null
  settings_section: SettingsSection
  meeting: string | null
  canvas: string | null
}

export function placeToJson(place: Place): PlaceJson {
  return {
    page: pageKey(place.page),
    chat: place.page === 'chat' ? (place.chat ?? 'draft') : null,
    settings_section: place.settingsSection,
    meeting: place.meeting,
    canvas: place.page === 'canvas' ? place.canvas : null,
  }
}

export function placeFromJson(value: unknown): Place | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.page !== 'string') return null
  const page = pageFromKey(v.page)
  if (page === null) return null
  const chat =
    page === 'chat' ? (typeof v.chat === 'string' && v.chat !== 'draft' ? v.chat : 'draft') : null
  const section = SETTINGS_SECTIONS.find((s) => s === v.settings_section) ?? 'Theme'
  return {
    page,
    chat,
    settingsSection: section,
    meeting: typeof v.meeting === 'string' ? v.meeting : null,
    canvas: page === 'canvas' && typeof v.canvas === 'string' ? v.canvas : null,
  }
}
