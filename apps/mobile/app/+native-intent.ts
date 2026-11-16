import { systemPath } from "@/lib/appLinks";
import { useLinkNotice } from "@/state/linkNotice";

/**
 * A URL the system hands the app (Safari, Notes, a notification, another app): a `relay://assistant/<id>`
 * or `relay://open/<page>` link opens the same screen as when it is tapped in chat (`lib/appLinks.ts`),
 * or the nearest one with a notice when the phone has no such screen; anything else reaches the router
 * as it came.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const target = systemPath(path);
    if (target.notice !== undefined) useLinkNotice.getState().say(target.notice);
    return target.path;
  } catch {
    return path;
  }
}
