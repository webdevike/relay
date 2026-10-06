import { Linking } from "react-native";

/** Opens a URL in the system handler, ignoring failures (e.g. no app can handle it). */
export function openExternal(url: string): void {
  Linking.openURL(url).catch(() => undefined);
}
