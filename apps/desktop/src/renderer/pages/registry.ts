import type { ComponentType } from 'react'
import type { Place } from '@evaos/shell-core'
import { createElement } from 'react'
import { AgentPage } from '../assistants/AgentPage'
import { AssistantsHome } from '../assistants/AssistantsHome'
import { CanvasPage } from '../canvas/CanvasPage'
import { DashboardPage } from '../dashboard/DashboardPage'
import { pageMeta } from './page-meta'
import { HabitsPage } from '../habits/HabitsPage'
import { MeetingPage } from '../meetings/MeetingPage'
import { MeetingsHome } from '../meetings/MeetingsHome'
import { JobsPage } from '../jobs/JobsPage'
import { RoomsPage } from '../rooms/RoomsPage'
import { WorkspacePage } from '../workspace/WorkspacePage'
import { SettingsPage } from '../settings/SettingsPage'
import { TestBenchPage } from '../test-bench/TestBenchPage'

export type PageRegistryKind = 'page' | 'settings' | 'workspace' | 'meeting' | 'canvas' | 'agent'

const PAGE_BY_SLUG: Record<string, ComponentType<{ place: Place }>> = {
  assistants: AssistantsHome,
  dashboard: DashboardPage,
  jobs: JobsPage,
  'test-bench': TestBenchPage,
  habits: HabitsPage,
  meetings: MeetingsHome,
  rooms: RoomsPage,
}

/** Dispatches the implemented top-level pages. */
export function PageBySlug({ place }: { place: Place }) {
  const Page = PAGE_BY_SLUG[pageMeta(place).slug]
  return createElement(Page, { place })
}

/** Detail pages and settings share the place-driven router. */
export const pageRegistry: Record<PageRegistryKind, ComponentType<{ place: Place }>> = {
  page: PageBySlug,
  settings: SettingsPage,
  workspace: WorkspacePage,
  meeting: MeetingPage,
  canvas: CanvasPage,
  agent: AgentPage,
}
