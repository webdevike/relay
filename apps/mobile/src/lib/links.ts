import { Linking } from "react-native";
import { router, type Href } from "expo-router";
import { appLinkRoute } from "./appLinks";
import { useLinkNotice } from "@/state/linkNotice";
import { useThreadHandoff } from "@/state/threadHandoff";
import { reviewLinkOf } from "@/reviews/model";

/** Opens a URL in the system handler, ignoring failures (e.g. no app can handle it). */
export function openExternal(url: string): void {
  Linking.openURL(url).catch(() => undefined);
}

/**
 * Follows a `relay://assistant/<id>` (that assistant's thread) or `relay://open/<page>[/<sub>]`
 * link inside the app (a Reviews `?item=` opens that item; the table is `lib/appLinks.ts`, shared
 * with links opened from outside the app). Returns false when `url` isn't one, so callers fall
 * through to the web. A page this app has no screen for opens the nearest one with a short notice;
 * a Relay link never goes to the system handler. An assistant link's `?send=` / `?draft=` text is
 * handed to its thread in memory (`state/threadHandoff.ts`), sent only when `gesture` (Isaac tapped it).
 */
function openAppLink(url: string, gesture: boolean): boolean {
  const route = appLinkRoute(url, { gesture });
  if (route === null) return false;
  if (route.compose !== undefined) useThreadHandoff.getState().hand(route.compose);
  // appLinks.ts stays free of expo-router (the +native-intent hook and its tests use it), so its
  // route table is untyped; every href it builds names a screen in app/.
  router[route.how](route.href as Href);
  if (route.notice !== undefined) useLinkNotice.getState().say(route.notice);
  return true;
}

/** A widget's tappable `url` (link, button, card), always opened by Isaac's tap: an in-app
 * `relay://` link stays in the app, anything else leaves it like `openExternal`. */
export function openWidgetUrl(url: string): void {
  if (!openAppLink(url, true)) openExternal(url);
}

/**
 * A link tapped in chat text (`gesture` true) or opened by a widget page (`gesture` as its frame
 * reports it): a `relay://` app link stays in the app, a GitHub PR, Linear issue or Slack permalink
 * opens in Reviews (`relay://reviews?item=<url>`, the same route the deep link takes), anything else
 * leaves the app like `openExternal`. Reviews' own "open in app" keeps using `openExternal`.
 */
export function openChatLink(url: string, gesture: boolean): void {
  if (openAppLink(url, gesture)) return;
  if (reviewLinkOf(url) === null) openExternal(url);
  else router.push(`/reviews?item=${encodeURIComponent(url)}`);
}
