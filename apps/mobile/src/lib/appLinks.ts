/**
 * Where a Relay `relay://` link goes on the phone: `relay://assistant/<id>` and
 * `relay://open/<page>[/<sub>][?...]` (the grammar Relay desktop builds with its `link` tool), plus
 * the older `relay://<screen>` paths the router knows. One table for a link tapped in chat
 * (`lib/links.ts`) and for one the system hands the app (`app/+native-intent.ts`: Safari, Notes, a
 * notification). Pure: no router, no React Native.
 *
 * Total on purpose: every `relay://` link lands on a screen, never the router's "page not found".
 * Where the phone has no screen for what the link names it opens the nearest one (the parent list,
 * Home) and says so in `notice`.
 */
import { parseAppLink, type AppLink } from "@relay/protocol";

const CANVAS_SLUG = /^[a-z0-9-]{1,80}$/;

export type AppHref = string | { pathname: string; params: Record<string, string> };

/** `navigate` switches to the screen if it is already in the stack; `push` always adds one (a Reviews item over the queue). */
export interface AppRoute {
  how: "navigate" | "push";
  href: AppHref;
  /** Said briefly after landing when the screen is the nearest one, not the one the link names. */
  notice?: string;
}

/**
 * Top-level screens of `app/` that `relay://<screen>` reaches without a rewrite (`relay://reviews?item=`,
 * `relay://agents/<id>`, `relay://rooms/dev`); `appLinks.test.ts` checks the list against `app/`.
 */
export const ROUTER_SCREENS: readonly string[] = [
  "add-widget",
  "agents",
  "assistants",
  "boards",
  "canvas",
  "catch-up",
  "eva",
  "eva-computer",
  "eva-signin",
  "feed",
  "meetings",
  "pairing",
  "reviews",
  "rooms",
  "screen",
  "settings",
  "studio",
  "trackpad",
  "usage",
];

/** `relay://expo-development-client/?url=` is Expo's, not ours. */
const DEV_CLIENT = "relay://expo-development-client";

const nav = (href: AppHref, notice?: string): AppRoute => ({
  how: "navigate",
  href,
  ...(notice === undefined ? {} : { notice }),
});
const home = (notice: string): AppRoute => nav("/", notice);

/** Settings sections the phone's one Settings screen has a counterpart for (hosts, appearance, notifications, app update). */
const SETTINGS_ON_PHONE: Record<string, true> = {
  connections: true,
  notifications: true,
  theme: true,
  about: true,
};

/** The omp session id in a chat file path: `<dir>/<timestamp>_<id>.jsonl`. */
function sessionIdOf(chatFile: string): string | null {
  const stem = chatFile.slice(chatFile.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const id = stem.slice(stem.lastIndexOf("_") + 1);
  return id === "" ? null : id;
}

type OpenLink = Extract<AppLink, { kind: "open" }>;

function openRoute(link: OpenLink): AppRoute {
  const params = link.params ?? {};
  switch (link.page) {
    // Home is the phone's dashboard.
    case "dashboard":
      return nav("/");
    case "assistants":
      return nav("/assistants");
    // The Agent Inbox is the phone's list of sessions (omp sessions, helpers); a chat names one by its file.
    case "agents":
      return nav("/agents");
    case "chat": {
      const id = params.chat === undefined ? null : sessionIdOf(params.chat);
      return id === null
        ? nav("/agents", "Chats open as sessions under Agents")
        : nav({ pathname: "/agents", params: { sessionId: id } });
    }
    case "skills":
      return nav("/assistants", "Skills are on desktop");
    case "jobs":
      return home("Jobs are on desktop");
    case "test-bench":
      return home("Test Bench is on desktop");
    case "habits":
      return home("Habits are on desktop");
    case "meetings":
      return nav(
        params.meeting === undefined
          ? "/meetings"
          : `/meetings/${encodeURIComponent(params.meeting)}`,
      );
    // A canvas room is opened by its board slug; without a valid one the boards list is the nearest screen.
    case "canvas": {
      const slug = params.canvas;
      return slug !== undefined && CANVAS_SLUG.test(slug)
        ? nav({ pathname: "/canvas", params: { slug } })
        : nav("/boards", "That link names no canvas room");
    }
    // `relay://open/board/<slug>` is that board; bare, the list of boards.
    case "board":
      return nav(
        link.sub === undefined ? "/boards" : { pathname: "/boards", params: { slug: link.sub } },
      );
    // `relay://open/rooms/<id>` and desktop's `relay://open/room/<id>` are that room; bare, the list.
    case "rooms":
    case "room":
      return nav(link.sub === undefined ? "/rooms" : `/rooms/${encodeURIComponent(link.sub)}`);
    // The phone's Studio shows the whole library: it has no single-job view.
    case "studio":
      return nav(
        "/studio",
        link.params?.job === undefined
          ? undefined
          : "Studio shows every job; that one opens on desktop",
      );
    case "feed":
      return nav("/feed");
    case "reviews":
      return params.item === undefined
        ? nav("/reviews")
        : { how: "push", href: `/reviews?item=${encodeURIComponent(params.item)}` };
    case "workspace":
      return home("Workspaces are on desktop");
    case "settings": {
      if (link.sub === "usage") return nav("/usage");
      if (link.sub === undefined || SETTINGS_ON_PHONE[link.sub] === true) return nav("/settings");
      return nav("/settings", "That settings section is on desktop");
    }
    case "setup":
      return nav("/settings", "Setup runs on desktop");
    case "web":
      return home("Web pages open on desktop");
    case "files":
      return home("Files open on desktop");
    default:
      return home("The phone has no screen for that link");
  }
}

/** The legacy `relay://<screen>[/...]` forms that name a router screen directly. */
function screenOf(url: string): string | null {
  const name = /^relay:\/\/([a-z0-9-]+)(?:[/?#]|$)/.exec(url)?.[1];
  return name !== undefined && ROUTER_SCREENS.includes(name) ? name : null;
}

/**
 * The screen `url` opens; null when `url` is not a Relay link the app handles (a web URL, Expo's
 * dev-client link, or a `relay://<screen>` path the router already knows). A `relay://` link the
 * grammar rejects is Home with a notice.
 */
export function appLinkRoute(url: string): AppRoute | null {
  if (!url.startsWith("relay://") || url.startsWith(DEV_CLIENT)) return null;
  const link = parseAppLink(url);
  if (link === null) {
    return screenOf(url) !== null ? null : home("That link isn't one Relay can open");
  }
  if (link.kind === "assistant") return nav({ pathname: "/eva", params: { agent: link.id } });
  return openRoute(link);
}

/** `href` as the path-and-query string the router parses. */
export function hrefPath(href: AppHref): string {
  if (typeof href === "string") return href;
  const query = Object.entries(href.params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query === "" ? href.pathname : `${href.pathname}?${query}`;
}

/** What the router should open for a URL the system hands the app, and what to say on landing. */
export interface SystemPath {
  path: string;
  notice?: string;
}

/**
 * What the router should open for a URL the system hands the app (`+native-intent`): an app link's
 * screen, the nearest one (with a notice) for one the phone has no screen for, anything else (an
 * Expo dev-client link, a `relay://reviews?item=` or `relay://agents/<id>` path the router already
 * knows, a plain path) as it came.
 */
export function systemPath(path: string): SystemPath {
  const route = appLinkRoute(path);
  if (route === null) return { path };
  return {
    path: hrefPath(route.href),
    ...(route.notice === undefined ? {} : { notice: route.notice }),
  };
}
