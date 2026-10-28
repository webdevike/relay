/**
 * The glass action list under a long-pressed chat bubble (Reply, Copy, Select Text, Share), drawn
 * like iOS's context menus and WidgetMenu's: label left, SF Symbol right, hairlines between rows.
 * It grows from the bubble's edge; with Reduce Motion it only fades.
 */
import { Fragment } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { SymbolView, type SFSymbol } from "expo-symbols";
import Animated, { FadeIn, ZoomIn } from "react-native-reanimated";
import { Text } from "@/ui/Text";
import { spacing, useColors, useScheme, withAlpha } from "@/theme";

const ROW = 46;

export const MESSAGE_MENU_WIDTH = 230;

/** The menu's height with `count` rows, for placing it before it is drawn. */
export function messageMenuHeight(count: number): number {
  return count * ROW + Math.max(count - 1, 0) * StyleSheet.hairlineWidth;
}

export interface MessageMenuAction {
  key: string;
  label: string;
  symbol: SFSymbol;
  onPress: () => void;
}

export interface MessageMenuProps {
  actions: readonly MessageMenuAction[];
  /** Which top corner it grows from (the bubble's side). */
  anchor: "left" | "right";
  reducedMotion: boolean;
}

export function MessageMenu({ actions, anchor, reducedMotion }: MessageMenuProps) {
  const colors = useColors();
  const scheme = useScheme();
  const entering = reducedMotion ? FadeIn.duration(140) : ZoomIn.springify().damping(18).stiffness(260).mass(0.8);
  return (
    <Animated.View
      entering={entering}
      style={[styles.menu, { borderColor: colors.hairline, transformOrigin: `${anchor} top` }]}
      accessibilityRole="menu"
    >
      <BlurView intensity={90} tint={scheme === "dark" ? "systemThickMaterialDark" : "systemThickMaterialLight"} style={StyleSheet.absoluteFill} />
      {actions.map((action, index) => (
        <Fragment key={action.key}>
          {index > 0 && <View style={[styles.rule, { backgroundColor: colors.hairline }]} />}
          <Pressable
            accessibilityRole="menuitem"
            accessibilityLabel={action.label}
            onPress={action.onPress}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: withAlpha(scheme === "dark" ? "#FFFFFF" : "#000000", 0.08) }]}
          >
            <Text variant="body" numberOfLines={1} style={styles.label}>
              {action.label}
            </Text>
            <SymbolView name={action.symbol} size={18} tintColor={colors.text} />
          </Pressable>
        </Fragment>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  menu: {
    width: MESSAGE_MENU_WIDTH,
    borderRadius: 16,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  row: { height: ROW, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg },
  rule: { height: StyleSheet.hairlineWidth },
  label: { flex: 1, fontSize: 17, lineHeight: 22 },
});
