import type { ComponentType } from 'react'
import type { Place } from '@evaos/shell-core'
import { PlaceholderPage } from './PlaceholderPage'
import { SettingsPage } from '../settings/SettingsPage'

export type PageRegistryKind = 'page' | 'settings' | 'workspace' | 'board' | 'meeting'

/** Later plans and phases register over these entries. */
export const pageRegistry: Record<PageRegistryKind, ComponentType<{ place: Place }>> = {
  page: PlaceholderPage,
  settings: SettingsPage,
  workspace: PlaceholderPage,
  board: PlaceholderPage,
  meeting: PlaceholderPage,
}
