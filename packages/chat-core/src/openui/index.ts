/**
 * OpenUI Lang for chat widgets: agents emit a ```openui fence instead of ```ui JSON; the chat parses
 * it (also while it streams) into the same validated `WidgetSpec` tree its renderers already draw.
 *
 * Port of ~/Eva/work/relay/packages/protocol/src/openui/ at commit bf13a06: `lang/` is the vendored
 * thesysdev/openui lang-core copied verbatim (see `lang/LICENSE-openui`), the rest follows Relay's
 * files with this package's `WidgetNode`. Relay's prompt generator and block-check CLI stay there:
 * Eva reads them from Relay, and this app only renders. Keep the two in step.
 */
export { parseOpenUI } from './parse'
export type { OpenUIError, OpenUIErrorCode, ParseOpenUIOptions, ParseOpenUIResult } from './parse'
export { toOpenUI } from './serialize'
