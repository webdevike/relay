/**
 * Catch Up widget. Small: how many cards are new. Medium: that count beside the first card's source
 * and title. Opens /catch-up.
 */
import { StyleSheet, View } from "react-native";
import { Text } from "@/ui/Text";
import { deckCards } from "@/lib/catchup";
import { useCatchUpStore } from "@/state/catchup";
import { useConnectionStore } from "@/state/connection";
import { spacing } from "@/theme";
import { WidgetFigure, WidgetHeader, WidgetNote, WidgetSpacer, WidgetSurface, type WidgetBodyProps } from "../WidgetParts";

export function CatchUpWidget({ size, open, a11y }: WidgetBodyProps) {
  const items = useCatchUpStore((state) => state.items);
  const deferred = useCatchUpStore((state) => state.deferred);
  const connected = useConnectionStore((state) => state.status === "connected");
  const cards = items === null ? [] : deckCards(items, deferred);
  const first = cards[0];
  const note = items === null ? (connected ? "Loading…" : "Not connected") : cards.length === 0 ? "All caught up" : null;
  const label =
    note !== null
      ? `Catch Up. ${note}`
      : `Catch Up. ${String(cards.length)} new${size === "medium" && first !== undefined ? `. ${first.label}: ${first.title}` : ""}`;

  const count =
    note !== null ? (
      <WidgetNote text={note} />
    ) : (
      <View>
        <WidgetFigure value={String(cards.length)} />
        <Text variant="label" color="textMuted">
          new
        </Text>
      </View>
    );

  return (
    <WidgetSurface label={label} href="/catch-up" open={open} a11y={a11y}>
      <WidgetHeader symbol="rectangle.stack.fill" title="Catch Up" color="indigo" />
      <WidgetSpacer />
      {size === "medium" && first !== undefined ? (
        <View style={styles.row}>
          {count}
          <View style={styles.preview}>
            <Text variant="caption" color="textMuted" numberOfLines={1}>
              {first.label}
            </Text>
            <Text variant="label" numberOfLines={3} style={styles.title}>
              {first.title}
            </Text>
          </View>
        </View>
      ) : (
        count
      )}
    </WidgetSurface>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: spacing.lg },
  preview: { flex: 1, gap: 2, paddingBottom: 2 },
  title: { fontWeight: "600" },
});
