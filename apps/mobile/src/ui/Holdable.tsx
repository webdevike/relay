import { useContext, useMemo, useRef, type ReactElement } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { impactHaptic } from "@/lib/haptics";
import { BUBBLE_HOLD_MS, BubbleHoldContext } from "./ReactableBubble";

/**
 * Holding still on `children` for `minDuration` (default `BUBBLE_HOLD_MS`) calls `onHold` after a
 * medium haptic: the long press on an image or video. Inside a chat bubble it goes before the
 * bubble's own hold (the reaction overlay), so a held picture opens its menu and the rest of the
 * bubble still reacts. A tap still reaches the child's press, and a drag past 10 pt (a scrub on a
 * native player) fails the hold; once the hold fires it cancels the press. No `onHold`, no gesture.
 */
export function Holdable({ onHold, minDuration = BUBBLE_HOLD_MS, children }: { onHold: (() => void) | undefined; minDuration?: number; children: ReactElement }) {
  const bubble = useContext(BubbleHoldContext);
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;
  const hold = useMemo(() => {
    const gesture = Gesture.LongPress()
      .minDuration(minDuration)
      .runOnJS(true)
      .onStart(() => {
        impactHaptic("medium");
        onHoldRef.current?.();
      });
    return bubble === null ? gesture : gesture.blocksExternalGesture(bubble);
  }, [bubble, minDuration]);
  if (onHold === undefined) return children;
  return <GestureDetector gesture={hold}>{children}</GestureDetector>;
}
