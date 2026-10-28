// Everything the client needs comes from its own URL: the host serves it at
// `/canvas/<slug>/?token=…&embed=desktop|phone|web&follow=0&theme=dark|light`, and every other
// route of the room hangs off the same `/canvas/<slug>` prefix with the same token.

export type Embed = "desktop" | "phone" | "web";
export type ThemeChoice = "dark" | "light" | null;

export interface PageEnv {
	slug: string;
	token: string;
	embed: Embed;
	/** Keep the agent's cursor in view while it works (`follow=0` turns it off). */
	follow: boolean;
	/** `theme=` override; null follows prefers-color-scheme. */
	theme: ThemeChoice;
	/** Path prefix of the room's routes, `/canvas/<slug>` (no trailing slash). */
	base: string;
	/** `https://host:port` of the page. */
	origin: string;
}

export function parseEnv(href: string): PageEnv {
	const url = new URL(href);
	const q = url.searchParams;
	// The last `/canvas/<slug>` in the path, so a mount prefix in front of it still works.
	const parts = url.pathname.split("/");
	let at = -1;
	for (let i = parts.length - 2; i >= 0; i--) {
		if (parts[i] === "canvas" && parts[i + 1]) {
			at = i;
			break;
		}
	}
	const slug = at >= 0 ? decodeURIComponent(parts[at + 1] ?? "") : "";
	const base = at >= 0 ? parts.slice(0, at + 2).join("/") : url.pathname.replace(/\/[^/]*$/, "");
	const embed = q.get("embed");
	const theme = q.get("theme");
	return {
		slug,
		token: q.get("token") ?? "",
		embed: embed === "desktop" || embed === "phone" ? embed : "web",
		follow: q.get("follow") !== "0",
		theme: theme === "dark" || theme === "light" ? theme : null,
		base,
		origin: url.origin,
	};
}

/** `<base>/<route>?token=…` (+ extra params), relative to the page origin. */
export function roomUrl(env: PageEnv, route: string, extra: Record<string, string> = {}): string {
	const q = new URLSearchParams();
	if (env.token) q.set("token", env.token);
	for (const [k, v] of Object.entries(extra)) q.set(k, v);
	const s = q.toString();
	return `${env.base}/${route}${s ? `?${s}` : ""}`;
}

/** y-websocket server URL; the provider appends `/<room>?<params>`, room = "ws". */
export function wsServer(env: PageEnv): string {
	return `${env.origin.replace(/^http/, "ws")}${env.base}`;
}

export function wsParams(env: PageEnv): Record<string, string> {
	return env.token ? { token: env.token } : {};
}

/** Remote images load directly; board-local paths go through the host's token-gated `img` route. */
export function imageUrl(env: PageEnv, src: string): string {
	if (/^(https?:|data:|blob:)/i.test(src)) return src;
	return roomUrl(env, "img", { src });
}

/** An avatar path from presence: host paths (`/canvas/avatar/<key>`) and URLs as they are, else relative to the room. */
export function avatarUrl(env: PageEnv, path: string): string {
	if (/^(https?:|data:|blob:|\/)/i.test(path)) return path;
	return `${env.base}/${path}`;
}
