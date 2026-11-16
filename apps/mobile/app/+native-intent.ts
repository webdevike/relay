import { systemPath } from "@/lib/appLinks";
import { useLinkNotice } from "@/state/linkNotice";
import { useThreadHandoff } from "@/state/threadHandoff";

/**
 * A URL the system hands the app (Safari, Notes, a notification, another app): a `relay://assistant/<id>`
 * or `relay://open/<page>` link opens the same screen as when it is tapped in chat (`lib/appLinks.ts`),
 * or the nearest one with a notice when the phone has no such screen; anything else reaches the router
 * as it came. An assistant link's `?send=` or `?draft=` text lands in that thread's composer, never sent.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const target = systemPath(path);
    if (target.notice !== undefined) useLinkNotice.getState().say(target.notice);
    if (target.compose !== undefined) useThreadHandoff.getState().hand(target.compose);
    return target.path;
  } catch {
    return path;
  }
}
