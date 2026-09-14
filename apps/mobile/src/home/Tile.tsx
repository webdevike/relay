/**
 * One cell of the home grid. Reads like an iOS widget: symbol top-left, the big fact in the
 * middle when there is one, name and one-line caption anchored at the bottom. `square` tiles
 * pair up in a row; `wide` tiles take the row and get a `children` slot for live content.
 */
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "@/ui/Text";
import { colors, radii, spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";

export interface TileProps {
  symbol: SFSymbol;
  title: string;
  caption: string;
  /** Large tabular figure between symbol and title (a count). */
  value?: number;
  /** Symbol and value colour; `warn` when the tile needs the user. */
  tone?: "accent" | "warn" | "textMuted";
  size?: "square" | "wide";
  onPress: () => void;
  children?: ReactNode;
}

export function Tile({ symbol, title, caption, value, tone = "accent", size = "square", onPress, children }: TileProps) {
  const tint = colors[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${caption}`}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => [styles.tile, size === "square" ? styles.square : styles.wide, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        <SymbolView name={symbol} size={22} tintColor={tint} />
        {value !== undefined && (
          <Text variant="largeTitle" tabular style={{ color: tint }}>
            {value}
          </Text>
        )}
      </View>
      {children !== undefined && <View style={styles.content}>{children}</View>}
      <View style={styles.bottom}>
        <Text variant="title" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {caption}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    padding: spacing.lg,
    justifyContent: "space-between",
    gap: spacing.md,
  },
  square: { flex: 1, aspectRatio: 1 },
  wide: { alignSelf: "stretch" },
  pressed: { backgroundColor: colors.surfaceRaised },
  top: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  content: { flexGrow: 1 },
  bottom: { gap: 2 },
});
