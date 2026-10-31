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
import { canvasLiveEvents, canvasLiveInvoke } from './canvas-live'
import { usageEvents, usageInvoke } from './usage'
import { assistantsEvents, assistantsInvoke } from './assistants'
import { boardsEvents, boardsInvoke } from './boards'
import { reactionsEvents, reactionsInvoke } from './reactions'
import { artifactsEvents, artifactsInvoke } from './artifacts'
import { studioEvents, studioInvoke } from './studio'
import { draftsInvoke } from './drafts'
import { linearInvoke } from './linear'
import { reviewsEvents, reviewsInvoke } from './reviews'
import { roomsEvents, roomsInvoke } from './rooms'
import { filesEvents, filesInvoke } from './files'
import { agentEvents, agentInvoke } from './agent'
import { updateEvents, updateInvoke } from './update'
import { contextEvents, contextInvoke } from './context'
export * from './experiments'
export * from './canvas'
export * from './canvas-live'
export * from './usage'
export * from './assistants'
export * from './boards'
export * from './reactions'
export * from './artifacts'
export * from './studio'
export * from './drafts'
export * from './linear'
export * from './reviews'
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
  ...reviewsInvoke,
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
  ...canvasLiveInvoke,
  ...usageInvoke,
  ...assistantsInvoke,
  ...boardsInvoke,
  ...reactionsInvoke,
  ...artifactsInvoke,
  ...studioInvoke,
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
  ...canvasLiveEvents,
  ...usageEvents,
  ...assistantsEvents,
  ...boardsEvents,
  ...reactionsEvents,
  ...artifactsEvents,
  ...studioEvents,
  ...roomsEvents,
  ...filesEvents,
  ...agentEvents,
  ...updateEvents,
  ...contextEvents,
  ...reviewsEvents,
}

export type InvokeChannel = keyof typeof invokeContract
export type EventChannel = keyof typeof eventContract

export type InvokeInput<K extends InvokeChannel> = z.input<(typeof invokeContract)[K]['input']>
/** What a main-process handler gets: the input after the contract parsed it (defaults and transforms applied). */
export type InvokeParsed<K extends InvokeChannel> = z.output<(typeof invokeContract)[K]['input']>
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
  type ChatOwner,
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
