/**
 * OpenUI Lang for Relay widgets: agents emit a ```openui fence instead of ```ui JSON; clients parse
 * it (also while it streams) into the same validated `WidgetSpec` tree their renderers already draw.
 * `createOpenUIRuntime` keeps a widget's `$variable` state and runs its button actions.
 */
export { parseOpenUI } from "./parse";
export type { OpenUIError, OpenUIErrorCode, ParseOpenUIOptions, ParseOpenUIResult } from "./parse";
export { createOpenUIRuntime } from "./runtime";
export type { OpenUIRuntime } from "./runtime";
export { toOpenUI } from "./serialize";
export { relayWidgetPrompt } from "./prompt";
