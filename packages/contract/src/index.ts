import type { z } from 'zod'
import { appEvents, appInvoke } from './app'
import { shellInvoke } from './shell'
import { evaEvents, evaInvoke } from './eva'
import { jobsInvoke } from './jobs'
import { habitsInvoke } from './habits'
import { meetingsInvoke } from './meetings'
import { chatEvents, chatInvoke } from './chat'
import { browserEvents, browserInvoke } from './browser'
import { testBenchEvents, testBenchInvoke } from './test-bench'
import { canvasEvents, canvasInvoke } from './canvas'
import { usageEvents, usageInvoke } from './usage'
import { assistantsEvents, assistantsInvoke } from './assistants'
import { boardsEvents, boardsInvoke } from './boards'
import { linearInvoke } from './linear'
export * from './test-bench'
export * from './canvas'
export * from './usage'
export * from './assistants'
export * from './boards'
export * from './linear'

export * from './result'
export { AppInfoSchema, type AppInfo } from './app'
export {
  type SavedTabs,
  type SavedTheme,
  type ChatSettings,
  SavedTabsSchema,
  SavedThemeSchema,
  ChatSettingsSchema,
} from './shell'
export { type TabState, type TabsSnapshot } from './browser'

export const invokeContract = {
  ...linearInvoke,
  ...appInvoke,
  ...shellInvoke,
  ...evaInvoke,
  ...jobsInvoke,
  ...habitsInvoke,
  ...meetingsInvoke,
  ...chatInvoke,
  ...browserInvoke,
  ...testBenchInvoke,
  ...canvasInvoke,
  ...usageInvoke,
  ...assistantsInvoke,
  ...boardsInvoke,
}
export const eventContract = {
  ...appEvents,
  ...chatEvents,
  ...browserEvents,
  ...evaEvents,
  ...testBenchEvents,
  ...canvasEvents,
  ...usageEvents,
  ...assistantsEvents,
  ...boardsEvents,
}

export type InvokeChannel = keyof typeof invokeContract
export type EventChannel = keyof typeof eventContract

export type InvokeInput<K extends InvokeChannel> = z.input<(typeof invokeContract)[K]['input']>
export type InvokeOutput<K extends InvokeChannel> = z.output<(typeof invokeContract)[K]['output']>
export type EventPayload<K extends EventChannel> = z.output<(typeof eventContract)[K]>

export const INVOKE_CHANNELS: readonly string[] = Object.keys(invokeContract)
export const EVENT_CHANNELS: readonly string[] = Object.keys(eventContract)
export {
  BatchSchema,
  OpSchema,
  type Batch,
  type Op,
  type ChatList,
  type ChatRow,
  type ChatAgent,
  ChatAgentSchema,
  type ChatPrefs,
  type DialogResponse,
  type LaunchState,
  type LaunchPatch,
  type Extras,
} from './chat'
export {
  type WorkspaceSummary,
  type OpenTodoDto,
  type DashboardPayload,
  type WorkspaceDetail,
} from './eva'
export { type JobSummaryDto, type JobSettingsDto } from './jobs'
export { GateStatusSchema, type GateStatus } from './habits'
export { type Proposal, type MeetingSummary } from './meetings'
