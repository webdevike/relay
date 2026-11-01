/**
 * One Reviews queue row: unread dot, source glyph, title on one line, `<actor> <reason> <label>`
 * under it and the age on the right. Swiping left shows a green Done; VoiceOver gets Done as an
 * action on the row.
 */
import { useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { SymbolView } from "expo-symbols";
import { reviewAgo, type ReviewItem } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { Text } from "@/ui/Text";
import { SourceGlyph } from "./SourceGlyph";

export interface QueueRowProps {
  item: ReviewItem;
  now: number;
  onOpen: () => void;
  onDone: () => void;
}

export function QueueRow({ item, now, onOpen, onDone }: QueueRowProps) {
  const colors = useColors();
  const swipe = useRef<SwipeableMethods>(null);
  const age = reviewAgo(item.updatedAt, now);
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          testID="review-done-action"
          onPress={() => {
            swipe.current?.close();
            onDone();
          }}
          style={[styles.action, { backgroundColor: colors.ok }]}
        >
          <SymbolView name="checkmark" size={20} tintColor={colors.bg} />
          <Text variant="label" color="bg">
            Done
          </Text>
        </Pressable>
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.unread ? "Unread, " : ""}${item.title}, ${item.actor} ${item.reason} ${item.label}, ${age}`}
        accessibilityHint="Swipe left for Done"
        accessibilityActions={[{ name: "done", label: "Done" }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "done") onDone();
        }}
        onPress={onOpen}
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfaceRaised : colors.bg }]}
      >
        <View style={[styles.dot, { backgroundColor: item.unread ? colors.accent : "transparent" }]} />
        <View style={styles.glyph}>
          <SourceGlyph item={item} />
        </View>
        <View style={[styles.text, { borderBottomColor: colors.hairline }]}>
          <View style={styles.line}>
            <Text variant="title" numberOfLines={1} style={[styles.title, !item.unread && styles.read]}>
              {item.title}
            </Text>
            <Text variant="label" color="textFaint" tabular>
              {age}
            </Text>
          </View>
          <Text color="textMuted" numberOfLines={1}>
            {`${item.actor} ${item.reason} `}
            <Text color="textFaint">{item.label}</Text>
          </Text>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", paddingLeft: spacing.xs },
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: spacing.lg + 7, marginRight: spacing.sm },
  glyph: { width: 24, alignItems: "center", marginTop: spacing.lg, marginRight: spacing.md },
  text: { flex: 1, gap: 2, paddingVertical: spacing.md, paddingRight: spacing.xl, borderBottomWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: "row", alignItems: "baseline", gap: spacing.md },
  title: { flex: 1 },
  read: { fontWeight: "400" },
  action: { width: 92, alignItems: "center", justifyContent: "center", gap: 2 },
});
