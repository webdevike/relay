import type { ComponentType } from 'react'
import type { Place } from '@evaos/shell-core'
import { createElement } from 'react'
import { DashboardPage } from '../dashboard/DashboardPage'
import { pageMeta } from './page-meta'
import { PlaceholderPage } from './PlaceholderPage'
import { HabitsPage } from '../habits/HabitsPage'
import { JobsPage } from '../jobs/JobsPage'
import { WorkspacePage } from '../workspace/WorkspacePage'
import { SettingsPage } from '../settings/SettingsPage'

export type PageRegistryKind = 'page' | 'settings' | 'workspace' | 'board' | 'meeting'

const PAGE_BY_SLUG: Record<string, ComponentType<{ place: Place }>> = {
  dashboard: DashboardPage,
  jobs: JobsPage,
  habits: HabitsPage,
}

/** Dispatches kind 'page' by slug; later plans add habits and meetings to the map. */
export function PageBySlug({ place }: { place: Place }) {
  const Page = PAGE_BY_SLUG[pageMeta(place).slug] ?? PlaceholderPage
  return createElement(Page, { place })
}

/** Later plans and phases register over these entries. */
export const pageRegistry: Record<PageRegistryKind, ComponentType<{ place: Place }>> = {
  page: PageBySlug,
  settings: SettingsPage,
  workspace: WorkspacePage,
  board: PlaceholderPage,
  meeting: PlaceholderPage,
}
