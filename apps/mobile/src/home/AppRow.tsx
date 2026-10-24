/**
 * One of Home's apps drawn like an iOS Settings row: a coloured icon square, its name, its live
 * fact, then a red badge when it needs the user (else its count) and a chevron. The `apps` widget
 * stacks these; rows share the widget's height evenly.
 */
import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "@/ui/Text";
import { useColors, useScheme, withAlpha, spacing } from "@/theme";
import type { HomeApp } from "@/home/apps";
import type { WidgetA11y, WidgetBodyProps } from "@/home/widgets/WidgetParts";

/** iOS system colours, top and bottom of each icon square's gradient. */
export const ICON_COLORS = {
  blue: ["#4FA3FF", "#0A6CFF"],
  green: ["#5EDB7A", "#28B446"],
  orange: ["#FFB340", "#FF8A00"],
  indigo: ["#7F7CFF", "#4B44E0"],
  teal: ["#5AD8E6", "#1AA6C2"],
  pink: ["#FF6B8A", "#FF2D55"],
  gray: ["#A3A3AB", "#6E6E76"],
} as const satisfies Record<string, readonly [string, string]>;

/** The coloured, gradient-filled icon square of an app row (and of a widget in the Add Widget gallery). */
export function AppGlyph({ color, symbol }: { color: keyof typeof ICON_COLORS; symbol: SFSymbol }) {
  const [top, bottom] = ICON_COLORS[color];
  return (
    <View
      style={[
        styles.glyph,
        {
          backgroundColor: bottom,
          experimental_backgroundImage: `linear-gradient(160deg, ${top}, ${bottom})`,
        },
      ]}
    >
      <SymbolView name={symbol} size={17} tintColor="#FFFFFF" weight="semibold" />
    </View>
  );
}

/** Height below which a row's two lines and icon no longer fit. */
export const APP_ROW_MIN = 46;

export function AppRow({
  app,
  first,
  open,
  a11y,
}: {
  app: HomeApp;
  /** The top row has no separator above it. */
  first: boolean;
  /** Opens the app's route; null in jiggle mode, the menu and the gallery. */
  open: WidgetBodyProps["open"];
  /** The grid's widget actions, carried by every row since the rows are the widget's VoiceOver elements. */
  a11y: WidgetA11y | null;
}) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const a11yProps =
    a11y === null
      ? { accessible: false }
      : {
          accessible: true,
          accessibilityRole: "button" as const,
          accessibilityLabel: `${app.label}. ${app.hint}`,
          accessibilityActions: [{ name: "activate" }, ...a11y.actions],
          onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
            const name = event.nativeEvent.actionName;
            if (name === "activate") open?.(app.href);
            else a11y.onAction(name);
          },
        };
  const content = (
    <>
      <AppGlyph color={app.color} symbol={app.symbol} />
      <View
        style={[
          styles.body,
          !first && { borderTopColor: colors.hairline, borderTopWidth: StyleSheet.hairlineWidth },
        ]}
      >
        <View style={styles.text}>
          <Text variant="body" numberOfLines={1}>
            {app.label}
          </Text>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {app.hint}
          </Text>
        </View>
        {app.badge !== undefined && app.badge !== 0 ? (
          <View style={styles.badge}>
            <Text variant="caption" tabular style={styles.badgeText}>
              {app.badge === "!" ? "!" : app.badge > 99 ? "99+" : app.badge}
            </Text>
          </View>
        ) : (
          app.value !== undefined && (
            <Text variant="body" color="textMuted" tabular>
              {app.value}
            </Text>
          )
        )}
        <SymbolView name="chevron.right" size={13} tintColor={colors.textFaint} weight="semibold" />
      </View>
    </>
  );
  if (open === null) {
    return (
      <View style={styles.row} {...a11yProps}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      {...a11yProps}
      onPress={() => {
        open(app.href);
      }}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: withAlpha(dark ? "#FFFFFF" : "#000000", 0.08) },
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 14,
    gap: spacing.md,
  },
  glyph: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingRight: 14,
  },
  text: { flex: 1, gap: 1 },
  badge: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: 7,
    borderRadius: 12,
    backgroundColor: "#FF3B30",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600", lineHeight: 18 },
});
