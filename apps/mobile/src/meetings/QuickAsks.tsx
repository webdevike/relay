/**
 * The meeting view's one-tap questions: one row of pills that never wraps, swiped sideways, with a
 * soft fade on whichever edge has more pills past it.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { MEETING_QUICK_ASKS } from "@relay/protocol";
import { spacing, useColors, withAlpha } from "@/theme";
import { Chip } from "@/ui/Chip";

/** Bands from the edge inward, most opaque first: a fade without a gradient dependency. */
const FADE = [0.9, 0.7, 0.45, 0.2] as const;
const BAND = 6;

function Fade({ side, color }: { side: "left" | "right"; color: string }) {
  return (
    <View pointerEvents="none" style={[styles.fade, side === "left" ? styles.left : styles.right]}>
      {FADE.map((alpha) => (
        <View key={alpha} style={{ width: BAND, backgroundColor: withAlpha(color, alpha) }} />
      ))}
    </View>
  );
}

export function QuickAsks({ onAsk }: { onAsk: (text: string) => void }) {
  const colors = useColors();
  const [box, setBox] = useState({ x: 0, width: 0, content: 0 });
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    setBox({ x: contentOffset.x, width: layoutMeasurement.width, content: contentSize.width });
  };
  const moreLeft = box.x > 1;
  const moreRight = box.x + box.width < box.content - 1;
  return (
    <View testID="meeting-quick-ask-row">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onLayout={(e) => {
          const width = e.nativeEvent.layout.width;
          setBox((b) => ({ ...b, width }));
        }}
        onContentSizeChange={(content) => {
          setBox((b) => ({ ...b, content }));
        }}
      >
        {MEETING_QUICK_ASKS.map((text) => (
          <Chip
            key={text}
            label={text}
            onPress={() => {
              onAsk(text);
            }}
          />
        ))}
      </ScrollView>
      {moreLeft ? <Fade side="left" color={colors.bg} /> : null}
      {moreRight ? <Fade side="right" color={colors.bg} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  fade: { position: "absolute", top: 0, bottom: 0, flexDirection: "row" },
  left: { left: 0 },
  // Most opaque at the edge on both sides.
  right: { right: 0, flexDirection: "row-reverse" },
});
