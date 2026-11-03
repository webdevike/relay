import { useSyncExternalStore } from "react";
import { env } from "./room";
import { type Scheme, startTheme } from "./theme";

let storage: Storage | null = null;
try {
	storage = window.localStorage;
} catch {
	// Blocked storage: the toggle then lasts for this page only.
}

/** This page's light/dark: the viewer's toggle, else the embedding app's, else the system's. */
export const pageTheme = startTheme({ doc: document, win: window, initialApp: env.theme, storage });

export function useScheme(): Scheme {
	return useSyncExternalStore(pageTheme.subscribe, pageTheme.scheme);
}
