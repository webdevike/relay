import { useEffect, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { colors, motion, radii, spacing } from "@/theme";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

const DISMISS_THRESHOLD = 80;

export function Sheet({ visible, onClose, children }: SheetProps) {
  const { height } = useWindowDimensions();
  const translateY = useSharedValue(height);

  useEffect(() => {
    if (visible) translateY.value = withTiming(0, { duration: motion.duration.base });
  }, [visible, translateY]);

  const close = () => {
    translateY.value = withTiming(height, { duration: motion.duration.base });
    onClose();
  };

  const pan = Gesture.Pan()
    .onChange((event) => {
      translateY.value = Math.max(0, translateY.value + event.changeY);
    })
    .onEnd(() => {
      if (translateY.value > DISMISS_THRESHOLD) {
        translateY.value = withTiming(height, { duration: motion.duration.base });
        scheduleOnRN(close);
      } else {
        translateY.value = withTiming(0, { duration: motion.duration.fast });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));

  if (!visible) return null;

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} />
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.sheet, sheetStyle]}>
          <View style={styles.grabber} />
          {children}
        </Animated.View>
      </GestureDetector>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.hairline,
    marginBottom: spacing.lg,
  },
});
