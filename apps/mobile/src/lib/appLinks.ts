/**
 * Where a `relay://assistant/<id>` or `relay://open/<page>[/<sub>][?...]` link goes on the phone:
 * one table for a link tapped in chat (`lib/links.ts`) and for one opened from outside the app
 * (`app/+native-intent.ts`: Safari, Notes, a notification). Pure: no router, no React Native.
 */
import { parseAppLink } from "@relay/protocol";

const CANVAS_SLUG = /^[a-z0-9-]{1,80}$/;

export type AppHref = string | { pathname: string; params: Record<string, string> };

/** `navigate` switches to the screen if it is already in the stack; `push` always adds one (a Reviews item over the queue). */
export interface AppRoute {
  how: "navigate" | "push";
  href: AppHref;
}

/**
 * The screen `url` opens, `"none"` for a page this app has no screen for (Test Bench, Jobs, a
 * canvas link without a room), or null when `url` is not an app link at all.
 */
export function appLinkRoute(url: string): AppRoute | "none" | null {
  const link = parseAppLink(url);
  if (link === null) return null;
  if (link.kind === "assistant") return { how: "navigate", href: { pathname: "/eva", params: { agent: link.id } } };
  switch (link.page) {
    case "assistants":
      return { how: "navigate", href: "/assistants" };
    // The phone's Settings is one screen: every desktop section (theme, connections) lands there.
    case "settings":
      return { how: "navigate", href: "/settings" };
    // A canvas room is opened by its board slug (`?canvas=`); the screen has nothing to show without one.
    case "canvas": {
      const slug = link.params?.canvas;
      return slug !== undefined && CANVAS_SLUG.test(slug) ? { how: "navigate", href: { pathname: "/canvas", params: { slug } } } : "none";
    }
    // `relay://open/board/<slug>` is that board; bare, the list of boards.
    case "board":
      return { how: "navigate", href: link.sub === undefined ? "/boards" : { pathname: "/boards", params: { slug: link.sub } } };
    case "studio":
      return { how: "navigate", href: "/studio" };
    case "reviews": {
      const item = link.params?.item;
      return item === undefined ? { how: "navigate", href: "/reviews" } : { how: "push", href: `/reviews?item=${encodeURIComponent(item)}` };
    }
    default:
      return "none";
  }
}

/** `href` as the path-and-query string the router parses. */
export function hrefPath(href: AppHref): string {
  if (typeof href === "string") return href;
  const query = Object.entries(href.params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query === "" ? href.pathname : `${href.pathname}?${query}`;
}

/**
 * What the router should open for a URL the system hands the app (`+native-intent`): an app link's
 * screen, Home for one the phone has no screen for, anything else (an Expo dev-client link, a
 * `relay://reviews?item=` or `relay://agents/<id>` path the router already knows) as it came.
 */
export function systemPath(path: string): string {
  const route = appLinkRoute(path);
  if (route === null) return path;
  return route === "none" ? "/" : hrefPath(route.href);
}
