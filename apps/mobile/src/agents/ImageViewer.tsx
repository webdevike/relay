import { useEffect } from "react";
import { Modal, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton } from "@/ui/IconButton";
import { colors, spacing } from "@/theme";

export interface ImageViewerProps {
  /** Data URI to show; `null` keeps the viewer closed. */
  uri: string | null;
  onClose: () => void;
}

const MAX_SCALE = 6;
/** Where a double tap lands between fit and filled. */
const DOUBLE_TAP_SCALE = 2.5;

/**
 * A transcript image full-screen on black. Pinch to zoom, drag to pan while zoomed, double tap to
 * toggle a 2.5x zoom centred on the tap, single tap (or the close button) to dismiss. Panning is
 * clamped so the image never leaves the viewport, and letting go below fit springs back.
 *
 * The gestures live under their own GestureHandlerRootView: a React Native Modal renders in a
 * detached native hierarchy the app-root provider does not reach, so without this the pinch/pan
 * handlers never receive touches.
 */
export function ImageViewer({ uri, onClose }: ImageViewerProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const reset = () => {
    "worklet";
    scale.value = withTiming(1);
    savedScale.value = 1;
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  };

  // A freshly opened image always starts at fit, never inheriting the last image's zoom.
  useEffect(() => {
    if (uri === null) return;
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [uri, scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

  // Keep the panned image inside the viewport: at scale s the image can move at most half its
  // grown width/height off centre before an edge would show.
  const clamp = (value: number, limit: number) => {
    "worklet";
    return Math.min(limit, Math.max(-limit, value));
  };

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.min(MAX_SCALE, Math.max(0.5, savedScale.value * event.scale));
    })
    .onEnd(() => {
      if (scale.value < 1) {
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

  const pan = Gesture.Pan()
    .maxPointers(2)
    .onUpdate((event) => {
      if (scale.value <= 1) return;
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
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(onClose)();
    });

  const gesture = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  return (
    <Modal visible={uri !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={styles.backdrop}>
        <GestureDetector gesture={gesture}>
          <Animated.View style={styles.backdrop}>
            {uri !== null && <Animated.Image source={{ uri }} resizeMode="contain" style={[StyleSheet.absoluteFill, imageStyle]} />}
          </Animated.View>
        </GestureDetector>
        <View style={[styles.close, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
          <IconButton symbol="xmark" onPress={onClose} tintColor={colors.text} backgroundColor="rgba(255,255,255,0.12)" />
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000" },
  close: { position: "absolute", right: spacing.lg },
});
