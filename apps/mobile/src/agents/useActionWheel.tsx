/**
 * The long-press that opens an `ActionWheel` under the finger, shared by every surface that has
 * one (the agent chat, the trackpad). Holding still opens the wheel with a heavy tap; moving
 * before the hold fails the recogniser so the surface's own gesture (scroll, pointer) runs
 * instead; after opening, the finger picks an entry by direction and the lift selects it.
 */
import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, type PanGesture } from "react-native-gesture-handler";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ActionWheel, type ActionWheelEntry } from "./ActionWheel";
import { impactHaptic } from "@/lib/haptics";

/** Holding still this long (ms) opens the wheel; moving sooner is the surface's own gesture. */
export const WHEEL_HOLD_MS = 350;
/** Travel (pt) before the hold that hands the touch back to the surface. */
const HOLD_SLOP = 12;

export interface ActionWheelOptions {
  entries: ActionWheelEntry[];
  onSelect: (key: string) => void;
  /**
   * Y offset from the gesture view's origin to the wheel layer's origin, for a gesture view that
   * sits below something inside the layer (the chat card under the header). Omit when they share
   * an origin.
   */
  offsetY?: SharedValue<number>;
  /** Runs on the JS thread the moment the wheel opens; the trackpad uses it to stop tracking the finger. */
  onOpen?: () => void;
}

export interface ActionWheelHandle {
  gesture: PanGesture;
  /** The wheel layer; render it above the surface, filling the same parent the coordinates refer to. */
  wheel: ReactNode;
}

export function useActionWheel({
  entries,
  onSelect,
  offsetY,
  onOpen,
}: ActionWheelOptions): ActionWheelHandle {
  const visible = useSharedValue(0);
  const center = useSharedValue({ x: 0, y: 0 });
  const pointer = useSharedValue({ x: 0, y: 0 });
  const origin = useSharedValue({ x: 0, y: 0 });

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .activateAfterLongPress(WHEEL_HOLD_MS)
        .shouldCancelWhenOutside(false)
        .onTouchesDown((event) => {
          const touch = event.allTouches[0];
          if (touch !== undefined) origin.value = { x: touch.x, y: touch.y };
        })
        .onTouchesMove((event, manager) => {
          if (visible.value === 1) return;
          const touch = event.allTouches[0];
          if (touch === undefined) return;
          const dx = touch.x - origin.value.x;
          const dy = touch.y - origin.value.y;
          if (dx * dx + dy * dy > HOLD_SLOP * HOLD_SLOP) manager.fail();
        })
        .onStart((event) => {
          const at = { x: event.x, y: (offsetY?.value ?? 0) + event.y };
          center.value = at;
          pointer.value = at;
          visible.value = 1;
          scheduleOnRN(impactHaptic, "heavy");
          if (onOpen !== undefined) scheduleOnRN(onOpen);
        })
        .onUpdate((event) => {
          pointer.value = { x: event.x, y: (offsetY?.value ?? 0) + event.y };
        })
        .onEnd(() => {
          visible.value = 0;
        })
        .onFinalize((_event, success) => {
          if (success) return;
          // Cancelled by the system: shut the wheel with nothing picked.
          pointer.value = center.value;
          visible.value = 0;
        }),
    [offsetY, onOpen, origin, center, pointer, visible],
  );

  const wheel = (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <ActionWheel
        entries={entries}
        visible={visible}
        center={center}
        pointer={pointer}
        onSelect={onSelect}
      />
    </View>
  );
  return { gesture, wheel };
}
