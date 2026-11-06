import { useState } from "react";
import { ScrollView, StyleSheet, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SymbolView } from "expo-symbols";
import type { OpenAsk } from "@relay/protocol";
import { CHIP_HEIGHT, Chip } from "@/ui/Chip";
import { SideFade } from "@/ui/SideFade";
import { askBadges } from "@/lib/openAsks";
import { spacing, useColors } from "@/theme";

const DISMISS = [{ name: "dismiss", label: "Dismiss" }] as const;
/** Pixels of slack before the row counts as scrolled to an end. */
const END_SLACK = 4;

/**
 * The questions the assistant is still waiting on Isaac for, above the composer: one fixed-height
 * row of quiet chips (newest first, `lib/openAsks.ts` `askBadges`), each a glyph and its label at
 * natural width up to the chip's cap, one ellipsized line. They scroll sideways when they do not
 * fit, fading at an edge with more beyond it; the `+N` chip sits outside the scroll at the right,
 * always visible. Tap opens the ask, a long press (or VoiceOver's Dismiss action) dismisses it,
 * `+N` lists them all. `asks` is what `visibleAsks` shows; nothing renders when it is empty.
 * `background` is the page colour (`#RRGGBB`) the edges fade into.
 */
export function OpenAskBadges({
  asks,
  background,
  onOpen,
  onDismiss,
  onMore,
}: {
  asks: readonly OpenAsk[];
  background: string;
  onOpen: (ask: OpenAsk) => void;
  onDismiss: (ask: OpenAsk) => void;
  onMore: () => void;
}) {
  const colors = useColors();
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  if (asks.length === 0) return null;
  const { badges, more } = askBadges(asks);
  const overflow = content > viewport + END_SLACK;
  return (
    <View style={styles.row} accessibilityRole="toolbar" accessibilityLabel="Open questions">
      <View style={styles.scroll}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.badges, more > 0 && styles.badgesBeforeMore]}
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
          {badges.map((ask) => (
            <Chip
              key={ask.id}
              label={ask.label}
              leading={<SymbolView name="questionmark.bubble" size={12} tintColor={colors.accent} />}
              accessibilityLabel={`Open question: ${ask.label}`}
              accessibilityHint="Long-press to dismiss"
              accessibilityActions={DISMISS}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "dismiss") onDismiss(ask);
              }}
              onPress={() => {
                onOpen(ask);
              }}
              onLongPress={() => {
                onDismiss(ask);
              }}
            />
          ))}
        </ScrollView>
        {overflow && offset > END_SLACK && <SideFade side="left" color={background} />}
        {overflow && offset + viewport < content - END_SLACK && <SideFade side="right" color={background} />}
      </View>
      {more > 0 && (
        <View style={styles.more}>
          <Chip label={`+${String(more)}`} accessibilityLabel={`${String(more)} more open questions`} onPress={onMore} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", height: CHIP_HEIGHT + spacing.xs, paddingBottom: spacing.xs },
  scroll: { flex: 1, minWidth: 0 },
  badges: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.lg },
  /** The `+N` chip brings its own inset; the scroll keeps only the gap before it. */
  badgesBeforeMore: { paddingRight: spacing.xs },
  more: { flexShrink: 0, paddingRight: spacing.lg },
});
