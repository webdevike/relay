// Light or dark for the board. Who decides, strongest first:
//   1. this viewer's own choice from the toolbar toggle (localStorage, per browser),
//   2. the embedding app's scheme: `theme=` in the URL, then live `relay.theme` messages
//      (Relay Desktop posts one whenever its appearance or theme preset changes),
//   3. the system setting (`prefers-color-scheme`).

export type Scheme = "light" | "dark";

/** The embedding app's semantic colors for one scheme (Relay's `ThemeConfig.semantic`), all optional. */
export interface AppTokens {
	body?: string;
	text?: string;
	dimmed?: string;
	border?: string;
	popover?: string;
	surface?: string;
	accent?: string;
}

export interface ThemeInputs {
	/** The viewer's saved choice. */
	override: Scheme | null;
	/** The embedding app's scheme, if there is one. */
	app: Scheme | null;
	/** `prefers-color-scheme: dark`. */
	systemDark: boolean;
}

export const THEME_STORAGE_KEY = "relay.canvas.theme";

export function resolveScheme({ override, app, systemDark }: ThemeInputs): Scheme {
	return override ?? app ?? (systemDark ? "dark" : "light");
}

/** What the page follows when the viewer has no override. */
export function followedScheme(inputs: Omit<ThemeInputs, "override">): Scheme {
	return resolveScheme({ ...inputs, override: null });
}

/**
 * The toggle's next override from the scheme on screen: the opposite scheme is saved, except that
 * flipping back to what the page would follow anyway clears the override (returns to "follow").
 */
export function nextOverride(inputs: Omit<ThemeInputs, "override">, shown: Scheme): Scheme | null {
	const next: Scheme = shown === "dark" ? "light" : "dark";
	return next === followedScheme(inputs) ? null : next;
}

export function asScheme(v: unknown): Scheme | null {
	return v === "dark" || v === "light" ? v : null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readOverride(storage: StorageLike | null): Scheme | null {
	try {
		return asScheme(storage?.getItem(THEME_STORAGE_KEY));
	} catch {
		return null;
	}
}

export function writeOverride(storage: StorageLike | null, value: Scheme | null): void {
	try {
		if (value) storage?.setItem(THEME_STORAGE_KEY, value);
		else storage?.removeItem(THEME_STORAGE_KEY);
	} catch {
		// Storage can be blocked (private mode, sandboxed frame): the choice then lasts for this page only.
	}
}

export interface ThemeMessage {
	scheme: Scheme;
	tokens: AppTokens;
}

const TOKEN_KEYS = ["body", "text", "dimmed", "border", "popover", "surface", "accent"] as const;
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\))$/i;

/** `{ type: "relay.theme", scheme, tokens? }` from the embedding app; anything else is null. */
export function parseThemeMessage(data: unknown): ThemeMessage | null {
	if (!data || typeof data !== "object") return null;
	const d = data as { type?: unknown; scheme?: unknown; tokens?: unknown };
	if (d.type !== "relay.theme") return null;
	const scheme = asScheme(d.scheme);
	if (!scheme) return null;
	const tokens: AppTokens = {};
	if (d.tokens && typeof d.tokens === "object") {
		for (const k of TOKEN_KEYS) {
			const v = (d.tokens as Record<string, unknown>)[k];
			if (typeof v === "string" && COLOR.test(v.trim())) tokens[k] = v.trim();
		}
	}
	return { scheme, tokens };
}

const VARS: Record<keyof AppTokens, string> = {
	body: "--c-bg",
	text: "--c-fg",
	dimmed: "--c-muted",
	border: "--c-border",
	popover: "--c-popover",
	surface: "--c-surface",
	accent: "--c-accent",
};

/** The page's CSS variables for the app's tokens (only the ones it sent). */
export function tokenVars(tokens: AppTokens): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of TOKEN_KEYS) {
		const v = tokens[k];
		if (v) out[VARS[k]] = v;
	}
	return out;
}

/**
 * The app's tokens apply only while the page shows the scheme they were sent for: a viewer who
 * toggled against the app gets the built-in palette of the scheme they chose.
 */
export function tokensFor(shown: Scheme, app: ThemeMessage | null): AppTokens {
	return app && app.scheme === shown ? app.tokens : {};
}

/** Wires the page: applies the resolved scheme, follows the app's messages and the system. */
export function startTheme(opts: { doc: Document; win: Window; initialApp: Scheme | null; storage: StorageLike | null }): {
	toggle(): void;
	subscribe(cb: (scheme: Scheme) => void): () => void;
	scheme(): Scheme;
} {
	const { doc, win } = opts;
	const media = win.matchMedia("(prefers-color-scheme: dark)");
	let override = readOverride(opts.storage);
	let app: Scheme | null = opts.initialApp;
	let appTokens: ThemeMessage | null = null;
	let applied: string[] = [];
	let current: Scheme = "light";
	const listeners = new Set<(s: Scheme) => void>();
	const inputs = () => ({ app, systemDark: media.matches });

	const apply = () => {
		current = resolveScheme({ override, ...inputs() });
		const root = doc.documentElement;
		root.dataset["theme"] = current;
		for (const name of applied) root.style.removeProperty(name);
		const vars = tokenVars(tokensFor(current, appTokens));
		applied = Object.keys(vars);
		for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
		for (const cb of listeners) cb(current);
	};

	media.addEventListener("change", apply);
	win.addEventListener("message", (e: MessageEvent) => {
		// Only the embedding page (or the phone's native side) may restyle the board.
		if (e.source !== win.parent && e.source !== win && e.source !== null) return;
		const m = parseThemeMessage(e.data);
		if (!m) return;
		app = m.scheme;
		appTokens = m;
		apply();
	});
	apply();
	return {
		toggle() {
			override = nextOverride(inputs(), current);
			writeOverride(opts.storage, override);
			apply();
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		scheme: () => current,
	};
}
