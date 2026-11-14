/**
 * Overlays drawn inside the app's root view over a screen's content: bottom sheets, the bubble
 * menu, the thinking popover. A 3D poster is cut from a snapshot of the root view
 * (`lib/modelPosters.ts`), so it must not be taken while any of them shows. Native modals (their own
 * view controller) are not in the root view and need not register.
 */
import { useEffect } from "react";

let showing = 0;

/** Counts this overlay as covering content while `active`. */
export function useCoversContent(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    showing++;
    return () => {
      showing--;
    };
  }, [active]);
}

/** Whether any root-view overlay shows now. */
export function contentCovered(): boolean {
  return showing > 0;
}
