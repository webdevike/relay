import { agentPresenceInvoke } from './agent-presence'
import type { z } from 'zod'
import { appEvents, appInvoke } from './app'
import { shellInvoke } from './shell'
import { evaEvents, evaInvoke } from './eva'
import { jobsInvoke } from './jobs'
import { skillsInvoke } from './skills'
import { feedInvoke } from './feed'
import { habitsInvoke } from './habits'
import { meetingsEvents, meetingsInvoke } from './meetings'
import { chatEvents, chatInvoke } from './chat'
import { browserEvents, browserInvoke } from './browser'
import { experimentsEvents, experimentsInvoke } from './experiments'
import { canvasEvents, canvasInvoke } from './canvas'
import { canvasLiveEvents, canvasLiveInvoke } from './canvas-live'
import { usageEvents, usageInvoke } from './usage'
import { statsEvents, statsInvoke } from './stats'
import { assistantsEvents, assistantsInvoke } from './assistants'
import { boardsEvents, boardsInvoke } from './boards'
import { reactionsEvents, reactionsInvoke } from './reactions'
import { renderInvoke } from './render'
import { asksEvents, asksInvoke } from './asks'
import { signinInvoke } from './signin'
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
import { agentsBoardEvents, agentsBoardInvoke } from './agents-board'
import { computerEvents, computerInvoke } from './computer'
import { notificationsEvents, notificationsInvoke } from './notifications'
export * from './experiments'
export * from './canvas'
export * from './canvas-live'
export * from './usage'
export * from './stats'
export * from './assistants'
export * from './boards'
export * from './reactions'
export * from './render'
export * from './asks'
export * from './signin'
export * from './artifacts'
export * from './activity'
export * from './studio'
export * from './drafts'
export * from './linear'
export * from './links'
export * from './reviews'
export * from './rooms'
export * from './rooms-chat'
export * from './rooms-decisions'
export * from './rooms-mentions'
export * from './rooms-agent'
export * from './files'
export * from './files-presence'
export * from './terminal'
export * from './agent'
export * from './agent-access'
export * from './build'
export * from './update'
export * from './context'
export * from './agents-board'
export * from './setup'
export * from './notifications'
export * from './skills'
export * from './computer'

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
  type AnnotateMark,
  SwitchAppSchema,
  SwitchAppIdSchema,
  NOTE_MARK_COLOR,
} from './browser'
export * from './agent-presence'

export const invokeContract = {
  ...linearInvoke,
  ...linksInvoke,
  ...reviewsInvoke,
  ...appInvoke,
  ...shellInvoke,
  ...evaInvoke,
  ...jobsInvoke,
  ...skillsInvoke,
  ...feedInvoke,
  ...habitsInvoke,
  ...meetingsInvoke,
  ...chatInvoke,
  ...browserInvoke,
  ...experimentsInvoke,
  ...canvasInvoke,
  ...canvasLiveInvoke,
  ...usageInvoke,
  ...statsInvoke,
  ...assistantsInvoke,
  ...boardsInvoke,
  ...reactionsInvoke,
  ...renderInvoke,
  ...asksInvoke,
  ...signinInvoke,
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
  ...agentsBoardInvoke,
  ...setupInvoke,
  ...notificationsInvoke,
  ...computerInvoke,
  ...agentPresenceInvoke,
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
  ...statsEvents,
  ...assistantsEvents,
  ...boardsEvents,
  ...reactionsEvents,
  ...asksEvents,
  ...artifactsEvents,
  ...activityEvents,
  ...studioEvents,
  ...meetingsEvents,
  ...roomsEvents,
  ...filesEvents,
  ...filesPresenceEvents,
  ...terminalEvents,
  ...agentEvents,
  ...connectionsEvents,
  ...deepLinkEvents,
  ...updateEvents,
  ...contextEvents,
  ...agentsBoardEvents,
  ...reviewsEvents,
  ...setupEvents,
  ...notificationsEvents,
  ...computerEvents,
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
export { FeedItemSchema, type FeedItemDto, type FeedAction } from './feed'
export { GateStatusSchema, type GateStatus } from './habits'
export {
  type Proposal,
  type MeetingSummary,
  type Recording,
  type RecordingView,
  type LiveLine,
  type MeetingAstra,
  type MeetingsChange,
} from './meetings'
