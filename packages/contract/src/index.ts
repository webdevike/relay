import type { z } from 'zod'
import { appEvents, appInvoke } from './app'
import { shellInvoke } from './shell'
import { evaInvoke } from './eva'
import { chatEvents, chatInvoke } from './chat'
import { browserEvents, browserInvoke } from './browser'

export * from './result'
export { AppInfoSchema, type AppInfo } from './app'
export {
  type SavedTabs,
  type Appearance,
  type ChatSettings,
  SavedTabsSchema,
  AppearanceSchema,
  ChatSettingsSchema,
} from './shell'
export { type TabState, type TabsSnapshot } from './browser'

export const invokeContract = {
  ...appInvoke,
  ...shellInvoke,
  ...evaInvoke,
  ...chatInvoke,
  ...browserInvoke,
}
export const eventContract = { ...appEvents, ...chatEvents, ...browserEvents }

export type InvokeChannel = keyof typeof invokeContract
export type EventChannel = keyof typeof eventContract

export type InvokeInput<K extends InvokeChannel> = z.input<(typeof invokeContract)[K]['input']>
export type InvokeOutput<K extends InvokeChannel> = z.output<(typeof invokeContract)[K]['output']>
export type EventPayload<K extends EventChannel> = z.output<(typeof eventContract)[K]>

export const INVOKE_CHANNELS: readonly string[] = Object.keys(invokeContract)
export const EVENT_CHANNELS: readonly string[] = Object.keys(eventContract)
export { BatchSchema, OpSchema, type Batch, type Op } from './chat'
