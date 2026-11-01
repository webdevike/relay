/**
 * The bar over every Reviews screen: back on the left, an optional centered title and subtitle
 * (a Slack thread's channel), and on the right Done and the ⋯ menu when the screen has them.
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import { spacing, useColors } from "@/theme";
import { Chip } from "@/ui/Chip";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";

export interface ItemHeaderProps {
  title?: string | undefined;
  subtitle?: string | undefined;
  onDone?: (() => void) | undefined;
  onMenu?: (() => void) | undefined;
  /** Replaces Done and the menu (the queue's own controls). */
  right?: ReactNode;
}

export function ItemHeader({ title, subtitle, onDone, onMenu, right }: ItemHeaderProps) {
  const colors = useColors();
  const router = useRouter();
  return (
    <View style={[styles.bar, title !== undefined && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }]}>
      <IconButton
        symbol="chevron.left"
        size={44}
        accessibilityLabel="Back"
        onPress={() => {
          router.back();
        }}
      />
      <View style={styles.middle}>
        {title !== undefined && (
          <Text variant="title" numberOfLines={1}>
            {title}
          </Text>
        )}
        {subtitle !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      <View style={styles.right}>
        {right}
        {onDone !== undefined && (
          <Chip
            label="Done"
            accessibilityLabel="Mark Done"
            leading={<SymbolView name="checkmark" size={13} tintColor={colors.text} />}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            onPress={onDone}
          />
        )}
        {onMenu !== undefined && <IconButton symbol="ellipsis" size={44} accessibilityLabel="More" onPress={onMenu} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  middle: { flex: 1, alignItems: "center" },
  right: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minWidth: 44, justifyContent: "flex-end" },
});
