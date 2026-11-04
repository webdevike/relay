import { Linking } from "react-native";
import { router } from "expo-router";
import { appLinkRoute } from "./appLinks";
import { reviewLinkOf } from "@/reviews/model";

/** Opens a URL in the system handler, ignoring failures (e.g. no app can handle it). */
export function openExternal(url: string): void {
  Linking.openURL(url).catch(() => undefined);
}

/**
 * Follows a `relay://assistant/<id>` (that assistant's thread) or `relay://open/<page>[/<sub>]`
 * link inside the app (a Reviews `?item=` opens that item; the table is `lib/appLinks.ts`, shared
 * with links opened from outside the app). Returns false when `url` isn't one, so callers fall
 * through to the web; a page this app has no screen for (Test Bench, Jobs) is swallowed: it never
 * goes to the system handler.
 */
function openAppLink(url: string): boolean {
  const route = appLinkRoute(url);
  if (route === null) return false;
  if (route !== "none") router[route.how](route.href);
  return true;
}

/** A widget's tappable `url` (link, button, card): an in-app `relay://` link stays in the app,
 * anything else leaves it like `openExternal`. */
export function openWidgetUrl(url: string): void {
  if (!openAppLink(url)) openExternal(url);
}

/**
 * A link tapped in chat text: a `relay://` app link stays in the app, a GitHub PR, Linear issue or
 * Slack permalink opens in Reviews (`relay://reviews?item=<url>`, the same route the deep link
 * takes), anything else leaves the app like `openExternal`. Reviews' own "open in app" keeps using
 * `openExternal`.
 */
export function openChatLink(url: string): void {
  if (openAppLink(url)) return;
  if (reviewLinkOf(url) === null) openExternal(url);
  else router.push(`/reviews?item=${encodeURIComponent(url)}`);
}
