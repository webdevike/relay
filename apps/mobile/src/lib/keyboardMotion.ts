import { Dimensions, Keyboard, type KeyboardEvent } from "react-native";
import { Easing, makeMutable, ReduceMotion, withTiming } from "react-native-reanimated";
import { KEYBOARD_CLOSE_MS, KEYBOARD_OPEN_MS, keyboardClosing, keyboardHeightAt, keyboardOpening } from "@/lib/keyboardCurve";

/**
 * The keyboard's height on the UI thread, frame by frame, for views that ride on it as a
 * transform (the assistant thread's composer and list).
 *
 * Not Reanimated's `useAnimatedKeyboard`: on iOS 26 it reports only the final height, once the
 * keyboard has finished moving (software-mansion/react-native-reanimated#8270, closed by Reanimated
 * as no longer supported), so whatever rides on it hides under the rising keyboard and then snaps.
 * react-native-keyboard-controller reads the real frames but is a native module, and build 18 does
 * not have it. So this is one app-wide height animated on the UI thread along the keyboard's own
 * curve (`keyboardCurve.ts`): started by the tap that focuses a field (`expectKeyboard`, in the same
 * tick as `focus()`, so both start on the same frame) and aimed at the exact frame from the
 * keyboard's will-show, will-change-frame and will-hide events. A drag that dismisses the keyboard
 * interactively cannot be followed this way: screens that ride on it dismiss on drag instead.
 */

/** The keyboard's height above the bottom of the window, this frame. */
export const keyboardHeight = makeMutable(0);
/**
 * The keyboard's height when up (the last one seen; a typical iPhone keyboard before the first):
 * `keyboardHeight / keyboardOpenHeight` is how far open it is, 0 to 1, in both directions.
 */
export const keyboardOpenHeight = makeMutable(336);

/** How long a ride along with the keyboard can take, with room for a late event. */
export const KEYBOARD_RIDE_MS = Math.max(KEYBOARD_OPEN_MS, KEYBOARD_CLOSE_MS) + 200;
/** If no keyboard event follows `expectKeyboard` this soon, the field did not take focus: settle back. */
const EXPECT_TIMEOUT_MS = 600;
/** A correction finishes in what is left of the move, never quicker than this. */
const MIN_CORRECTION_MS = 120;

const OPEN = { duration: KEYBOARD_OPEN_MS, easing: keyboardOpening, reduceMotion: ReduceMotion.Never };
const CLOSE = { duration: KEYBOARD_CLOSE_MS, easing: keyboardClosing, reduceMotion: ReduceMotion.Never };

// JS-thread mirrors, so nothing here reads a shared value back from the UI thread.
/** Where the keyboard is heading (0 = down). */
let heading = 0;
/** Its height when up. */
let openHeight = 336;
/** When the current move ends (`Date.now()` ms). */
let movingUntil = 0;
/** Bumped by every keyboard event: a pending `expectKeyboard` check stands down when it changed. */
let events = 0;

function drive(to: number, animated: boolean): void {
  if (to === heading) return;
  const now = Date.now();
  // The rise `expectKeyboard` started, aimed at a keyboard of another height: correct the target
  // and land with the keyboard instead of starting its curve over.
  const correcting = animated && heading > 0 && to > 0 && now < movingUntil;
  heading = to;
  if (to > 0) {
    openHeight = to;
    keyboardOpenHeight.value = to;
  }
  if (!animated) {
    movingUntil = 0;
    keyboardHeight.value = to;
  } else if (correcting) {
    const left = Math.max(MIN_CORRECTION_MS, movingUntil - now);
    movingUntil = now + left;
    keyboardHeight.value = withTiming(to, { duration: left, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.Never });
  } else {
    const config = to > 0 ? OPEN : CLOSE;
    movingUntil = now + config.duration;
    keyboardHeight.value = withTiming(to, config);
  }
}

function onFrame(event: KeyboardEvent): void {
  events += 1;
  drive(keyboardHeightAt(event.endCoordinates.screenY, Dimensions.get("window").height), event.duration > 0);
}

Keyboard.addListener("keyboardWillShow", onFrame);
Keyboard.addListener("keyboardWillChangeFrame", onFrame);
Keyboard.addListener("keyboardWillHide", (event) => {
  events += 1;
  drive(0, event.duration > 0);
});

/**
 * A field is about to take focus (call it right before `focus()`): the keyboard's rise starts now,
 * toward its last height, instead of a frame or two later when its event reaches JS; the event then
 * corrects the height if this keyboard is a different one.
 */
export function expectKeyboard(): void {
  if (heading > 0) return;
  drive(openHeight, true);
  const seen = events;
  setTimeout(() => {
    if (events === seen && !Keyboard.isVisible()) drive(0, true);
  }, EXPECT_TIMEOUT_MS);
}

/** The keyboard is rising right now (a composer opening with it rides along). */
export function keyboardRising(): boolean {
  return heading > 0 && Date.now() < movingUntil;
}

/** The keyboard is up or still falling (a composer closing with it rides along). */
export function keyboardUpOrFalling(): boolean {
  return heading > 0 || Date.now() < movingUntil;
}
