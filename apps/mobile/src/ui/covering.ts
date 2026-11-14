/**
 * Overlays drawn inside the app's root view over a screen's content: bottom sheets, the bubble
 * menu, the thinking popover. A 3D poster is cut from a snapshot of the root view
 * (`lib/modelPosters.ts`), so it must not be taken while any of them shows. Native modals (their own
 * view controller) are not in the root view and need not register. An overlay counts only while
 * its screen is the focused one: a sheet left open on a screen in the back covers nothing seen.
 */
import { NavigationContext } from "@react-navigation/native";
import { useContext, useEffect, useState } from "react";

let showing = 0;

/** Whether the screen holding the caller is the focused one; true outside a navigator. */
export function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  useEffect(() => {
    if (navigation === undefined) return;
    setFocused(navigation.isFocused());
    const offFocus = navigation.addListener("focus", () => { setFocused(true); });
    const offBlur = navigation.addListener("blur", () => { setFocused(false); });
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  return focused;
}

/** Counts this overlay as covering content while `active` and its screen is focused. */
export function useCoversContent(active: boolean): void {
  const focused = useScreenFocused();
  const covering = active && focused;
  useEffect(() => {
    if (!covering) return;
    showing++;
    return () => {
      showing--;
    };
  }, [covering]);
}

/** Whether any root-view overlay shows now. */
export function contentCovered(): boolean {
  return showing > 0;
}
