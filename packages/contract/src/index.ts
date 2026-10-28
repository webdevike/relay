import type { z } from 'zod'
import { appEvents, appInvoke } from './app'
import { shellInvoke } from './shell'
import { evaEvents, evaInvoke } from './eva'
import { jobsInvoke } from './jobs'
import { habitsInvoke } from './habits'
import { meetingsInvoke } from './meetings'
import { chatEvents, chatInvoke } from './chat'
import { browserEvents, browserInvoke } from './browser'
import { experimentsEvents, experimentsInvoke } from './experiments'
import { canvasEvents, canvasInvoke } from './canvas'
import { usageEvents, usageInvoke } from './usage'
import { assistantsEvents, assistantsInvoke } from './assistants'
import { boardsEvents, boardsInvoke } from './boards'
import { reactionsEvents, reactionsInvoke } from './reactions'
import { artifactsEvents, artifactsInvoke } from './artifacts'
import { draftsInvoke } from './drafts'
import { linearInvoke } from './linear'
import { roomsEvents, roomsInvoke } from './rooms'
import { filesEvents, filesInvoke } from './files'
import { agentEvents, agentInvoke } from './agent'
import { updateEvents, updateInvoke } from './update'
import { contextEvents, contextInvoke } from './context'
export * from './experiments'
export * from './canvas'
export * from './usage'
export * from './assistants'
export * from './boards'
export * from './reactions'
export * from './artifacts'
export * from './drafts'
export * from './linear'
export * from './rooms'
export * from './rooms-roster'
export * from './rooms-mentions'
export * from './files'
export * from './agent'
export * from './update'
export * from './context'

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
export {
  type TabState,
  type TabsSnapshot,
  type SwitchApp,
  SwitchAppSchema,
  SwitchAppIdSchema,
} from './browser'

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
  ...experimentsInvoke,
  ...canvasInvoke,
  ...usageInvoke,
  ...assistantsInvoke,
  ...boardsInvoke,
  ...reactionsInvoke,
  ...artifactsInvoke,
  ...draftsInvoke,
  ...roomsInvoke,
  ...filesInvoke,
  ...agentInvoke,
  ...updateInvoke,
  ...contextInvoke,
}
export const eventContract = {
  ...appEvents,
  ...chatEvents,
  ...browserEvents,
  ...evaEvents,
  ...experimentsEvents,
  ...canvasEvents,
  ...usageEvents,
  ...assistantsEvents,
  ...boardsEvents,
  ...reactionsEvents,
  ...artifactsEvents,
  ...roomsEvents,
  ...filesEvents,
  ...agentEvents,
  ...updateEvents,
  ...contextEvents,
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
