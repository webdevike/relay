import type { EmbedEvent } from "../../canvas-live/src/shared";

export interface EmbedTarget {
	parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
	ReactNativeWebView?: { postMessage(message: string): void } | undefined;
}

/**
 * Tells the page around the client what happened: the desktop iframe's parent gets the event
 * object, the phone's WebView gets it as JSON. A top-level tab has neither and posts nothing.
 */
export function postEmbed(win: EmbedTarget & object, event: EmbedEvent): void {
	if (win.parent && (win.parent as unknown) !== win) win.parent.postMessage(event, "*");
	win.ReactNativeWebView?.postMessage(JSON.stringify(event));
}
