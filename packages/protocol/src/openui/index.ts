/**
 * OpenUI Lang for Relay widgets: agents emit a ```openui fence instead of ```ui JSON; clients parse
 * it (also while it streams) into the same validated `WidgetSpec` tree their renderers already draw.
 * `createOpenUIRuntime` keeps a widget's `$variable` state, runs its button actions and, given a
 * query client (dashboards, canvas `ui` nodes), feeds its Query statements live host data.
 */
export { parseOpenUI } from "./parse";
export type { OpenUIError, OpenUIErrorCode, ParseOpenUIOptions, ParseOpenUIResult } from "./parse";
export { createOpenUIRuntime } from "./runtime";
export type { OpenUIRuntime, OpenUIRuntimeOptions } from "./runtime";
export { MAX_REFRESH_SEC, MIN_REFRESH_SEC } from "./queries";
export type { OpenUIQueryClient } from "./queries";
export { checkLiveOpenUI, MAX_LIVE_OPENUI, renderLiveOpenUI } from "./live";
export type { LiveOpenUICheck, LiveOpenUIRender } from "./live";
export { toOpenUI } from "./serialize";
export { relayWidgetPrompt } from "./prompt";
