/**
 * OpenUI Lang for chat widgets: agents emit a ```openui fence instead of ```ui JSON; the chat parses
 * it (also while it streams) into the same validated `WidgetSpec` tree its renderers already draw.
 * `createOpenUIRuntime` keeps a widget's `$variable` state, runs its button actions and, given a
 * query client (dashboards, canvas `ui` nodes), feeds its Query statements live host data.
 *
 * Port of ~/Eva/work/relay/packages/protocol/src/openui/: `lang/` is the vendored
 * thesysdev/openui lang-core copied verbatim (see `lang/LICENSE-openui`), the rest follows Relay's
 * files with this package's `WidgetNode`. Relay's prompt generator, block-check CLI and the
 * write-time live check (`live.ts`, which needs the query tools' schemas) stay there: Eva reads
 * them from Relay, and this app only renders. Keep the two in step.
 */
export { parseOpenUI } from './parse'
export type { OpenUIError, OpenUIErrorCode, ParseOpenUIOptions, ParseOpenUIResult } from './parse'
export { createOpenUIRuntime } from './runtime'
export type { OpenUIRuntime, OpenUIRuntimeOptions } from './runtime'
export { MAX_REFRESH_SEC, MIN_REFRESH_SEC } from './queries'
export type { OpenUIQueryClient } from './queries'
export { toOpenUI } from './serialize'
