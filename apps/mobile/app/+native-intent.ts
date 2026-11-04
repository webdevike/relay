import { systemPath } from "@/lib/appLinks";

/**
 * A URL the system hands the app (Safari, Notes, a notification, another app): a `relay://assistant/<id>`
 * or `relay://open/<page>` link opens the same screen as when it is tapped in chat (`lib/appLinks.ts`);
 * anything else reaches the router as it came.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return systemPath(path);
  } catch {
    return path;
  }
}
