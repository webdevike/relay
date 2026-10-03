/**
 * Before/after image comparison for the ```ui "compare" widget. Both images fill one frame; the
 * before image is clipped to the left of a draggable divider, so dragging (or tapping) reveals more
 * of either side. The pan only claims clearly horizontal drags, so the transcript still scrolls.
 */
import { useState } from "react";
import { Image, View, type ImageLoadEventData, type NativeSyntheticEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { radii, spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { resolveDropSrc } from "./dropSrc";
import type { CompareSpec } from "./widget";

const KNOB = 32;
const DIVIDER = 2;
const DEFAULT_ASPECT = 16 / 9;

export function CompareSlider({ spec }: { spec: CompareSpec }) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const position = useSharedValue(0.5);
  const before = resolveDropSrc(spec.before.src);
  const after = resolveDropSrc(spec.after.src);
  const height = width > 0 ? width / aspect : 0;

  const moveTo = (x: number) => {
    "worklet";
    position.value = width > 0 ? Math.min(1, Math.max(0, x / width)) : 0.5;
  };
  const gesture = Gesture.Race(
    Gesture.Pan()
      .activeOffsetX([-8, 8])
      .failOffsetY([-12, 12])
      .onBegin((e) => moveTo(e.x))
      .onUpdate((e) => moveTo(e.x)),
    Gesture.Tap().onEnd((e) => moveTo(e.x)),
  );

  const clipStyle = useAnimatedStyle(() => ({ width: position.value * width }));
  const handleStyle = useAnimatedStyle(() => ({ transform: [{ translateX: position.value * width - KNOB / 2 }] }));

  const onAfterLoad = (e: NativeSyntheticEvent<ImageLoadEventData>) => {
    const { width: w, height: h } = e.nativeEvent.source;
    if (w > 0 && h > 0) setAspect(w / h);
  };

  return (
    <View style={{ gap: spacing.sm }}>
      {spec.title !== undefined && <Text variant="label">{spec.title}</Text>}
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {before === null || after === null ? (
          <Text variant="caption" color="textMuted">
            Connect to the host to load these images.
          </Text>
        ) : (
          width > 0 && (
            <GestureDetector gesture={gesture}>
              <View style={{ width, height, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
                <Image source={{ uri: after }} onLoad={onAfterLoad} resizeMode="contain" style={{ position: "absolute", width, height }} />
                <Animated.View style={[{ position: "absolute", left: 0, top: 0, bottom: 0, overflow: "hidden" }, clipStyle]}>
                  <Image source={{ uri: before }} resizeMode="contain" style={{ width, height }} />
                </Animated.View>
                <Animated.View pointerEvents="none" style={[{ position: "absolute", top: 0, bottom: 0, width: KNOB, alignItems: "center", justifyContent: "center" }, handleStyle]}>
                  <View style={{ position: "absolute", top: 0, bottom: 0, width: DIVIDER, backgroundColor: colors.text }} />
                  <View style={{ width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" }}>
                    <SymbolView name="arrow.left.and.right" size={14} tintColor={colors.bg} />
                  </View>
                </Animated.View>
                <Corner side="left" text={spec.before.label ?? "Before"} />
                <Corner side="right" text={spec.after.label ?? "After"} />
              </View>
            </GestureDetector>
          )
        )}
      </View>
    </View>
  );
}

function Corner({ side, text }: { side: "left" | "right"; text: string }) {
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: spacing.xs, [side]: spacing.xs, paddingHorizontal: spacing.xs, borderRadius: radii.sm, backgroundColor: "rgba(0,0,0,0.6)" }}
    >
      <Text variant="caption" style={{ color: "#fff" }}>
        {text}
      </Text>
    </View>
  );
}
