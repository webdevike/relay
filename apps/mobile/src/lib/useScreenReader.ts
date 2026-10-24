import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** Whether VoiceOver is on, kept current as the user turns it on or off. */
export function useScreenReader(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (live) setEnabled(on);
    });
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setEnabled);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return enabled;
}
