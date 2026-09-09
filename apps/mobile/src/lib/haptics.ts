import * as Haptics from "expo-haptics";
import { useSettingsStore } from "@/state/settings";

function enabled(): boolean {
  return useSettingsStore.getState().hapticsEnabled;
}

/** Light tap: momentary UI feedback (row press, toggle). */
export function tapHaptic(): void {
  if (!enabled()) return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** Selection change: segmented controls, pickers. */
export function selectHaptic(): void {
  if (!enabled()) return;
  void Haptics.selectionAsync();
}

/** Heavier confirmation/error feedback. */
export function impactHaptic(style: "medium" | "heavy" = "medium"): void {
  if (!enabled()) return;
  void Haptics.impactAsync(
    style === "heavy" ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Medium,
  );
}

export function notifyHaptic(kind: "success" | "warning" | "error"): void {
  if (!enabled()) return;
  const map = {
    success: Haptics.NotificationFeedbackType.Success,
    warning: Haptics.NotificationFeedbackType.Warning,
    error: Haptics.NotificationFeedbackType.Error,
  } as const;
  void Haptics.notificationAsync(map[kind]);
}
