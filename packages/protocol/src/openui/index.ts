/**
 * OpenUI Lang for Relay widgets: agents emit a ```openui fence instead of ```ui JSON; clients parse
 * it (also while it streams) into the same validated `WidgetSpec` tree their renderers already draw.
 */
export { parseOpenUI } from "./parse";
export type { OpenUIError, OpenUIErrorCode, ParseOpenUIOptions, ParseOpenUIResult } from "./parse";
export { toOpenUI } from "./serialize";
export { relayWidgetPrompt } from "./prompt";
