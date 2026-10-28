import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";

/**
 * Whether a looping animation should run: its screen is focused, the app is in the foreground,
 * and the caller has not `paused` it (it is covered or scrolled away). Loops stop otherwise, so
 * nothing animates where nobody can see it.
 */
export function useAnimationActive(paused = false): boolean {
  const [focused, setFocused] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
      };
    }, []),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      setForeground(next === "active");
    });
    return () => {
      subscription.remove();
    };
  }, []);
  return focused && foreground && !paused;
}
