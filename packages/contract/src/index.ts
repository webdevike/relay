import type { z } from 'zod'
import { appInvoke } from './app'
import { chatEvents, chatInvoke } from './chat'
import { browserEvents, browserInvoke } from './browser'

export * from './result'
export { AppInfoSchema, type AppInfo } from './app'
export { type TabState, type TabsSnapshot } from './browser'

export const invokeContract = { ...appInvoke, ...chatInvoke, ...browserInvoke }
export const eventContract = { ...chatEvents, ...browserEvents }

export type InvokeChannel = keyof typeof invokeContract
export type EventChannel = keyof typeof eventContract

export type InvokeInput<K extends InvokeChannel> = z.input<(typeof invokeContract)[K]['input']>
export type InvokeOutput<K extends InvokeChannel> = z.output<(typeof invokeContract)[K]['output']>
export type EventPayload<K extends EventChannel> = z.output<(typeof eventContract)[K]>

export const INVOKE_CHANNELS: readonly string[] = Object.keys(invokeContract)
export const EVENT_CHANNELS: readonly string[] = Object.keys(eventContract)
