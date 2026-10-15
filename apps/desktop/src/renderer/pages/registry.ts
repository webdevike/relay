import type { ComponentType } from 'react'
import type { Place } from '@evaos/shell-core'
import { PlaceholderPage } from './PlaceholderPage'
import { SettingsStub } from './SettingsStub'

export type PageRegistryKind = 'page' | 'settings' | 'workspace' | 'board' | 'meeting'

/** Later plans and phases register over these entries. */
export const pageRegistry: Record<PageRegistryKind, ComponentType<{ place: Place }>> = {
  page: PlaceholderPage,
  settings: SettingsStub,
  workspace: PlaceholderPage,
  board: PlaceholderPage,
  meeting: PlaceholderPage,
}
