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
import { activityEvents, activityInvoke } from './activity'
import { studioEvents, studioInvoke } from './studio'
import { draftsInvoke } from './drafts'
import { linearInvoke } from './linear'
import { linksEvents, linksInvoke } from './links'
import { reviewsEvents, reviewsInvoke } from './reviews'
import { roomsEvents, roomsInvoke } from './rooms'
import { filesEvents, filesInvoke } from './files'
import { filesPresenceEvents, filesPresenceInvoke } from './files-presence'
import { terminalEvents, terminalInvoke } from './terminal'
import { agentEvents, agentInvoke } from './agent'
import {
  connectionsEvents,
  connectionsInvoke,
  deepLinkEvents,
  deepLinkInvoke,
} from './agent-access'
import { updateEvents, updateInvoke } from './update'
import { setupEvents, setupInvoke } from './setup'
import { contextEvents, contextInvoke } from './context'
export * from './experiments'
export * from './canvas'
export * from './canvas-live'
export * from './usage'
export * from './assistants'
export * from './boards'
export * from './reactions'
export * from './artifacts'
export * from './activity'
export * from './studio'
export * from './drafts'
export * from './linear'
export * from './links'
export * from './reviews'
export * from './rooms'
export * from './rooms-roster'
export * from './rooms-mentions'
export * from './files'
export * from './files-presence'
export * from './terminal'
export * from './agent'
export * from './agent-access'
export * from './build'
export * from './update'
export * from './context'
export * from './setup'

export * from './result'
export { AppInfoSchema, type AppInfo, AppAboutSchema, type AppAbout } from './app'
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
  ...linksInvoke,
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
  ...activityInvoke,
  ...studioInvoke,
  ...draftsInvoke,
  ...roomsInvoke,
  ...filesInvoke,
  ...filesPresenceInvoke,
  ...terminalInvoke,
  ...agentInvoke,
  ...connectionsInvoke,
  ...deepLinkInvoke,
  ...updateInvoke,
  ...contextInvoke,
  ...setupInvoke,
}
export const eventContract = {
  ...linksEvents,
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
  ...activityEvents,
  ...studioEvents,
  ...roomsEvents,
  ...filesEvents,
  ...filesPresenceEvents,
  ...terminalEvents,
  ...agentEvents,
  ...connectionsEvents,
  ...deepLinkEvents,
  ...updateEvents,
  ...contextEvents,
  ...reviewsEvents,
  ...setupEvents,
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
