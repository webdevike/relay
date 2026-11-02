import { Linking } from "react-native";
import { router } from "expo-router";
import { reviewLinkOf } from "@/reviews/model";

/** Opens a URL in the system handler, ignoring failures (e.g. no app can handle it). */
export function openExternal(url: string): void {
  Linking.openURL(url).catch(() => undefined);
}

/**
 * A link tapped in chat text: a GitHub PR, Linear issue or Slack permalink opens in Reviews
 * (`relay://reviews?item=<url>`, the same route the deep link takes), anything else leaves the app
 * like `openExternal`. Reviews' own "open in app" keeps using `openExternal`.
 */
export function openChatLink(url: string): void {
  if (reviewLinkOf(url) === null) openExternal(url);
  else router.push(`/reviews?item=${encodeURIComponent(url)}`);
}
