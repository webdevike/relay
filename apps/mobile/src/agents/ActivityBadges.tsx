import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useActivityStore } from "@/state/activity";
import { Chip } from "@/ui/Chip";
import { SideFade } from "@/ui/SideFade";
import { activityBadges } from "@/lib/activity";
import { spacing, useColors } from "@/theme";

/** Pixels of slack before a row counts as scrolled to an end. */
const END_SLACK = 4;

/**
 * One row of chips above the composer, a chip per thing this assistant has in progress (sessions,
 * helpers, harnesses, canvas rooms; each once): a spinner while it runs, a hand while it waits on
 * Isaac. It scrolls sideways when they do not fit, fading at the edge with more beyond it. A
 * session's chip opens that session; the others open the Artifacts sheet on its Working group.
 * Nothing renders when idle. The thread's header lists only sessions that are not running, so none
 * shows twice. `background` is the page colour (`#RRGGBB`) the edge fades into.
 */
export function ActivityBadges({ thread, background, onPress }: { thread: string; background: string; onPress: () => void }) {
  const router = useRouter();
  const colors = useColors();
  const items = useActivityStore((state) => state.items);
  const shown = useMemo(() => activityBadges(items, thread), [items, thread]);
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  if (shown.length === 0) return null;
  const overflow = content > viewport + END_SLACK;
  return (
    <View style={styles.wrap} accessibilityRole="toolbar" accessibilityLabel="Working now">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.row}
        scrollEventThrottle={16}
        onLayout={(event: LayoutChangeEvent) => {
          setViewport(event.nativeEvent.layout.width);
        }}
        onContentSizeChange={(width) => {
          setContent(width);
        }}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
          setOffset(event.nativeEvent.contentOffset.x);
        }}
      >
        {shown.map((badge) => (
          <Chip
            key={badge.id}
            label={badge.label}
            accessibilityLabel={badge.waiting ? `${badge.label}, waiting on you` : `${badge.label}, running`}
            leading={badge.waiting ? <SymbolView name="hand.raised" size={12} tintColor={colors.warn} /> : <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />}
            onPress={() => {
              if (badge.sessionId === undefined) onPress();
              else router.push({ pathname: "/agents/[sessionId]", params: { sessionId: badge.sessionId } });
            }}
          />
        ))}
      </ScrollView>
      {overflow && offset > END_SLACK && <SideFade side="left" color={background} />}
      {overflow && offset + viewport < content - END_SLACK && <SideFade side="right" color={background} />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch", paddingBottom: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.lg },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
});
