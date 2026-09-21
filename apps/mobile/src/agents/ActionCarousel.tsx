import { useRef, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { motion } from "@/theme";
import { selectHaptic } from "@/lib/haptics";

/** Finger travel (pt) sideways on a plain action that turns the carousel. */
const TURN_DISTANCE = 40;
/** How far (pt) the outgoing and incoming actions travel; well inside the seam. */
const TRAVEL = 28;

export interface CarouselAction {
  key: string;
  /**
   * The action's control. `turn` is what a sideways swipe on it should call; controls that own
   * their touches (the mic) wire it themselves, plain buttons are wrapped in a pan here.
   */
  render: (turn: (direction: "left" | "right") => void) => ReactNode;
  /** The control handles sideways swipes itself; no pan is laid over it. */
  ownsSwipes?: boolean;
}

export interface ActionCarouselProps {
  actions: readonly CarouselAction[];
  index: number;
  onChange: (index: number) => void;
  size: number;
}

/**
 * One action showing at a time in the seam; a swipe left brings the next, right the previous,
 * around and around. Left is "forward" (the content follows the finger), so the newcomer enters
 * from the side the finger is heading to.
 */
export function ActionCarousel({ actions, index, onChange, size }: ActionCarouselProps) {
  const direction = useRef<1 | -1>(1);
  const current = actions[wrap(index, actions.length)];
  const turn = (to: "left" | "right"): void => {
    direction.current = to === "left" ? 1 : -1;
    onChange(wrap(index + direction.current, actions.length));
  };
  if (current === undefined) return null;
  const from = direction.current * TRAVEL;
  const entering: EntryExitAnimationFunction = () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateX: from }] },
      animations: {
        opacity: withTiming(1, { duration: motion.duration.base }),
        transform: [{ translateX: withTiming(0, { duration: motion.duration.base }) }],
      },
    };
  };
  const exiting: EntryExitAnimationFunction = () => {
    "worklet";
    return {
      initialValues: { opacity: 1, transform: [{ translateX: 0 }] },
      animations: {
        opacity: withTiming(0, { duration: motion.duration.fast }),
        transform: [{ translateX: withTiming(-from, { duration: motion.duration.fast }) }],
      },
    };
  };
  const body = (
    <Animated.View
      key={current.key}
      entering={entering}
      exiting={exiting}
      style={StyleSheet.absoluteFill}
    >
      {current.render(turn)}
    </Animated.View>
  );
  return (
    <View style={{ width: size, height: size }}>
      {current.ownsSwipes === true ? body : <Swipeable onTurn={turn}>{body}</Swipeable>}
    </View>
  );
}

function wrap(index: number, count: number): number {
  return ((index % count) + count) % count;
}

/** A pan over a plain button: crossing the distance sideways turns; a tap still reaches the button. */
function Swipeable({
  onTurn,
  children,
}: {
  onTurn: (direction: "left" | "right") => void;
  children: ReactNode;
}) {
  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;
  const fire = (direction: "left" | "right"): void => {
    selectHaptic();
    onTurnRef.current(direction);
  };
  const pan = Gesture.Pan()
    .activeOffsetX([-TURN_DISTANCE / 2, TURN_DISTANCE / 2])
    .failOffsetY([-TURN_DISTANCE / 2, TURN_DISTANCE / 2])
    .onEnd((event) => {
      if (Math.abs(event.translationX) < TURN_DISTANCE) return;
      scheduleOnRN(fire, event.translationX < 0 ? "left" : "right");
    });
  return <GestureDetector gesture={pan}>{children}</GestureDetector>;
}
