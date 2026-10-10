import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

export interface ZoomableImageProps {
  uri: string;
  /** The box the image fits in; panning is clamped to it. */
  width: number;
  height: number;
  /** Single tap that isn't the first half of a double tap. */
  onTap: () => void;
  /** True from the first pinch until the image is back at fit; a pager stops scrolling meanwhile. */
  onZoomChange?: (zoomed: boolean) => void;
}

const MAX_SCALE = 6;
/** Where a double tap lands between fit and filled. */
const DOUBLE_TAP_SCALE = 2.5;

/**
 * One image fitted to a box: pinch to zoom, drag to pan while zoomed, double tap to toggle a 2.5x
 * zoom aimed at the tap. Panning is clamped so the image never leaves the box, and letting go below
 * fit springs back. At fit the pan never activates, so a surrounding pager still gets the swipe.
 */
export function ZoomableImage({ uri, width, height, onTap, onZoomChange }: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const zoomChanged = (zoomed: boolean) => {
    "worklet";
    if (onZoomChange !== undefined) scheduleOnRN(onZoomChange, zoomed);
  };

  const reset = () => {
    "worklet";
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    zoomChanged(false);
  };

  // A new image always starts at fit, never inheriting the last image's zoom.
  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [uri, scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

  // At scale s the image can move at most half its grown width/height off centre before an edge shows.
  const clamp = (value: number, limit: number) => {
    "worklet";
    return Math.min(limit, Math.max(-limit, value));
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      zoomChanged(true);
    })
    .onUpdate((event) => {
      scale.value = Math.min(MAX_SCALE, Math.max(0.5, savedScale.value * event.scale));
    })
    .onEnd(() => {
      if (scale.value <= 1) {
        reset();
        return;
      }
      savedScale.value = scale.value;
      const limitX = ((scale.value - 1) * width) / 2;
      const limitY = ((scale.value - 1) * height) / 2;
      translateX.value = clamp(translateX.value, limitX);
      translateY.value = clamp(translateY.value, limitY);
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  // Activates only while zoomed; at fit it fails so a pager's swipe goes through.
  const pan = Gesture.Pan()
    .maxPointers(2)
    .manualActivation(true)
    .onTouchesMove((_event, state) => {
      if (scale.value > 1) state.activate();
      else state.fail();
    })
    .onUpdate((event) => {
      const limitX = ((scale.value - 1) * width) / 2;
      const limitY = ((scale.value - 1) * height) / 2;
      translateX.value = clamp(savedTranslateX.value + event.translationX, limitX);
      translateY.value = clamp(savedTranslateY.value + event.translationY, limitY);
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.value > 1) {
        reset();
        return;
      }
      // Zoom in, moving the tapped point toward centre so the double tap feels aimed.
      const target = DOUBLE_TAP_SCALE;
      const limitX = ((target - 1) * width) / 2;
      const limitY = ((target - 1) * height) / 2;
      scale.value = withTiming(target);
      savedScale.value = target;
      translateX.value = withTiming(clamp((width / 2 - event.x) * (target - 1), limitX));
      translateY.value = withTiming(clamp((height / 2 - event.y) * (target - 1), limitY));
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
      zoomChanged(true);
    });

  // A pinch or pan ending with a finger lift must not read as a tap: the tap only wins when both
  // fail, and any movement past a few points cancels it.
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .maxDistance(10)
    .requireExternalGestureToFail(pinch, pan)
    .onEnd((_event, success) => {
      if (success) scheduleOnRN(onTap);
    });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={{ width, height, overflow: "hidden" }}>
        <Animated.Image
          source={{ uri }}
          resizeMode="contain"
          style={[StyleSheet.absoluteFill, imageStyle]}
        />
      </Animated.View>
    </GestureDetector>
  );
}
