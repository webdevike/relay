export type AppChord =
  | 'new-tab'
  | 'close-tab'
  | 'focus-address'
  | 'search'
  | 'eregon'
  | 'new-todo'
  | 'toggle-panel'
  | 'prev-tab'
  | 'next-tab'
  | 'devtools'

export interface ChordSpec {
  key: string
  meta: true
  shift?: boolean
  alt?: boolean
}

export const APP_CHORDS: Record<AppChord, ChordSpec> = {
  'new-tab': { key: 't', meta: true },
  'close-tab': { key: 'w', meta: true },
  'focus-address': { key: 'l', meta: true },
  search: { key: 'k', meta: true },
  eregon: { key: 'j', meta: true },
  'new-todo': { key: 'n', meta: true },
  'toggle-panel': { key: 'b', meta: true, shift: true },
  'prev-tab': { key: '[', meta: true },
  'next-tab': { key: ']', meta: true },
  devtools: { key: 'i', meta: true, alt: true },
}

/** The subset of Electron's `Input` this needs. */
export interface InputLike {
  type: string
  key: string
  meta?: boolean
  control?: boolean
  shift?: boolean
  alt?: boolean
  isAutoRepeat?: boolean
}

/** The app chord an input event is, or null. Only keyDown matches; auto-repeat is ignored. */
export function matchesAppChord(input: InputLike): AppChord | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null
  if (!input.meta || input.control) return null
  const key = input.key.toLowerCase()
  for (const [name, spec] of Object.entries(APP_CHORDS) as Array<[AppChord, ChordSpec]>) {
    if (
      spec.key === key &&
      !!spec.shift === !!input.shift &&
      !!spec.alt === !!input.alt
    ) {
      return name
    }
  }
  return null
}
