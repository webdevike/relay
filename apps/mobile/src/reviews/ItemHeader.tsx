/**
 * The bar over every Reviews screen (Linear's issue view): a round glass back button, the item's
 * source mark and small grey key over its truncated title, and on the right one glass capsule with
 * the edit glyph (open the item in its app) and ⋯ (the screen's menu) when the screen has them.
 */
import { Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import type { ReviewSource } from "@relay/protocol";
import { spacing } from "@/theme";
import { GlassBar, GlassButton, type GlassSegment } from "@/ui/Glass";
import { Text } from "@/ui/Text";
import { SourceMark } from "./SourceGlyph";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

export interface ItemHeaderProps {
  /** Small grey line over the title: `ENG-6545`, `api#170`, `#ui-ux`, `DM`. */
  label?: string | undefined;
  /** The item's source: its brand mark leads the label, a Linear key in mono. */
  source?: ReviewSource | undefined;
  title?: string | undefined;
  /** The edit glyph: opens the item in its app or on the web. */
  onEdit?: (() => void) | undefined;
  /** What the edit glyph says to VoiceOver: "Open in Linear". */
  editLabel?: string | undefined;
  onMenu?: (() => void) | undefined;
}

export function ItemHeader({ label, source, title, onEdit, editLabel = "Open", onMenu }: ItemHeaderProps) {
  const router = useRouter();
  const segments: GlassSegment[] = [
    ...(onEdit === undefined ? [] : [{ key: "edit", symbol: "square.and.pencil" as const, onPress: onEdit, accessibilityLabel: editLabel, testID: "review-edit" }]),
    ...(onMenu === undefined ? [] : [{ key: "more", symbol: "ellipsis" as const, onPress: onMenu, accessibilityLabel: "More", testID: "review-more" }]),
  ];
  return (
    <View style={styles.bar}>
      <GlassButton
        symbol="chevron.left"
        accessibilityLabel="Back"
        testID="review-back"
        onPress={() => {
          router.back();
        }}
      />
      <View style={styles.middle}>
        {label !== undefined && label !== "" && (
          <View style={styles.label}>
            {source !== undefined && <SourceMark source={source} size={11} color="textMuted" />}
            <Text variant="caption" color="textMuted" numberOfLines={1} style={source === "linear" ? styles.mono : undefined}>
              {label}
            </Text>
          </View>
        )}
        {title !== undefined && title !== "" && (
          <Text variant="label" numberOfLines={1} style={styles.title}>
            {title}
          </Text>
        )}
      </View>
      {segments.length > 0 && <GlassBar segments={segments} />}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  middle: { flex: 1 },
  label: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  mono: { fontFamily: mono, letterSpacing: -0.3 },
  title: { fontSize: 15, fontWeight: "600" },
});
