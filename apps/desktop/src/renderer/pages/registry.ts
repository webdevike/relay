import type { ComponentType } from 'react'
import type { Place } from '@evaos/shell-core'
import { createElement } from 'react'
import { AgentPage } from '../assistants/AgentPage'
import { AssistantsHome } from '../assistants/AssistantsHome'
import { AgentsBoardPage } from '../agents-board/AgentsBoardPage'
import { BoardPage } from '../boards/BoardPage'
import { CanvasPage } from '../canvas/CanvasPage'
import { DashboardPage } from '../dashboard/DashboardPage'
import { pageMeta } from './page-meta'
import { HabitsPage } from '../habits/HabitsPage'
import { MeetingPage } from '../meetings/MeetingPage'
import { MeetingsHome } from '../meetings/MeetingsHome'
import { JobsPage } from '../jobs/JobsPage'
import { NewRoomPage } from '../rooms/NewRoomPage'
import { RoomPage } from '../rooms/RoomPage'
import { WorkspacePage } from '../workspace/WorkspacePage'
import { SettingsPage } from '../settings/SettingsPage'
import { StudioPage } from '../studio/StudioPage'
import { ReviewPage } from '../reviews/ReviewPage'
import { ReviewsPage } from '../reviews/ReviewsPage'
import { SkillsPage } from '../skills/SkillsPage'
import { TestBenchPage } from '../test-bench/TestBenchPage'
import { SetupPage } from '../setup/SetupPage'
import { FeedPage } from '../feed/FeedPage'

export type PageRegistryKind =
  'page' | 'settings' | 'workspace' | 'meeting' | 'canvas' | 'agent' | 'board' | 'review' | 'room'

const PAGE_BY_SLUG: Record<string, ComponentType<{ place: Place }>> = {
  assistants: AssistantsHome,
  agents: AgentsBoardPage,
  dashboard: DashboardPage,
  jobs: JobsPage,
  skills: SkillsPage,
  'test-bench': TestBenchPage,
  habits: HabitsPage,
  meetings: MeetingsHome,
  rooms: NewRoomPage,
  studio: StudioPage,
  feed: FeedPage,
  reviews: ReviewsPage,
  setup: SetupPage,
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
  board: BoardPage,
  review: ReviewPage,
  room: RoomPage,
}
