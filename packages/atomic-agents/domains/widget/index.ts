/** Relay chat widgets: pick the widget block for a draft reply, checked by Relay's OpenUI parser (the widget agent). The domain's public entry: code outside `domains/widget/` imports only this file. */
export { openui } from "./adapters/openui.ts"
export { widget } from "./adapters/widget.ts"
