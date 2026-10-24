/**
 * The pieces every Home widget is built from, drawn like iOS home screen widgets: one solid
 * rounded rect (22pt continuous corners) with the content inset 14pt, an app-coloured glyph and
 * title on top, big figures, and tappable rows. A widget kind file only wires its data into these.
 */
import type { ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionInfo,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { Href } from "expo-router";
import { Text } from "@/ui/Text";
import { ICON_COLORS } from "@/home/AppRow";
import { spacing, useColors, useScheme, type ColorToken } from "@/theme";
import type { WidgetSize } from "./layout";

export type WidgetColor = keyof typeof ICON_COLORS;

/** The grid's VoiceOver actions for one placed widget (resize, move, remove, edit). */
export interface WidgetA11y {
  actions: AccessibilityActionInfo[];
  onAction: (name: string) => void;
}

export interface WidgetBodyProps {
  size: WidgetSize;
  /** Opens a route; null where the widget is only a picture (jiggle mode, the menu, the gallery). */
  open: ((href: Href) => void) | null;
  /** Present on placed widgets: they are one VoiceOver element carrying the grid's actions. */
  a11y: WidgetA11y | null;
}

export const WIDGET_RADIUS = 22;

/** The kind's colour as text and glyph tint: the light end of its icon gradient on dark, the deep end on light. */
export function useWidgetTint(color: WidgetColor): string {
  const [top, bottom] = ICON_COLORS[color];
  return useScheme() === "dark" ? top : bottom;
}

export interface WidgetSurfaceProps extends Pick<WidgetBodyProps, "open" | "a11y"> {
  /** What VoiceOver reads: the kind and its live fact. */
  label: string;
  /**
   * Where a tap anywhere outside an inner link goes. Null when the widget is only its inner rows:
   * the rect is then neither a tap target nor one VoiceOver element, and the rows carry `a11y`.
   */
  href: Href | null;
  /** Overrides the rect's style, such as its inset. */
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/** The widget's solid rounded rect. A tap opens `href`; inner `WidgetLink`s take their own taps first. */
export function WidgetSurface({ label, href, open, a11y, style, children }: WidgetSurfaceProps) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const surface = [
    styles.surface,
    dark
      ? { backgroundColor: colors.surfaceRaised }
      : [styles.lightShadow, { backgroundColor: colors.surface }],
    style,
  ];
  if (href === null) return <View style={surface}>{children}</View>;
  const a11yProps =
    a11y === null
      ? { accessible: false }
      : {
          accessible: true,
          accessibilityRole: "button" as const,
          accessibilityLabel: label,
          accessibilityHint: "Open actions to resize, move or remove the widget.",
          accessibilityActions: [{ name: "activate" }, ...a11y.actions],
          onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
            const name = event.nativeEvent.actionName;
            if (name === "activate") open?.(href);
            else a11y.onAction(name);
          },
        };
  if (open === null) {
    return (
      <View style={surface} {...a11yProps}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      {...a11yProps}
      onPress={() => {
        open(href);
      }}
      style={({ pressed }) => [surface, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

/** A row or column inside a widget that opens its own route (one session, one assistant). */
export function WidgetLink({
  href,
  open,
  children,
  style,
}: {
  href: Href;
  open: WidgetBodyProps["open"];
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  if (open === null) return <View style={style}>{children}</View>;
  return (
    <Pressable
      onPress={() => {
        open(href);
      }}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

/** App glyph and title in the kind's colour, like the top of iOS's Sleep widget. */
export function WidgetHeader({
  symbol,
  title,
  color,
}: {
  symbol: SFSymbol;
  title: string;
  color: WidgetColor;
}) {
  const tint = useWidgetTint(color);
  return (
    <View style={styles.header}>
      <SymbolView name={symbol} size={15} tintColor={tint} weight="semibold" />
      <Text variant="label" numberOfLines={1} style={[styles.headerText, { color: tint }]}>
        {title}
      </Text>
    </View>
  );
}

/** A large tabular number (a count or a share), optionally in a tone. */
export function WidgetFigure({
  value,
  color,
  small = false,
}: {
  value: string;
  color?: string | undefined;
  small?: boolean;
}) {
  return (
    <Text
      tabular
      numberOfLines={1}
      adjustsFontSizeToFit
      style={[small ? styles.figureSmall : styles.figure, color === undefined ? null : { color }]}
    >
      {value}
    </Text>
  );
}

/** Why a widget has nothing to show yet (not connected, loading, empty). */
export function WidgetNote({ text, color = "textMuted" }: { text: string; color?: ColorToken }) {
  return (
    <Text variant="caption" color={color} numberOfLines={3}>
      {text}
    </Text>
  );
}

/** Pushes what follows to the bottom of the widget. */
export function WidgetSpacer() {
  return <View style={styles.spacer} />;
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    borderRadius: WIDGET_RADIUS,
    borderCurve: "continuous",
    padding: 14,
    overflow: "hidden",
  },
  lightShadow: {
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
  },
  pressed: { opacity: 0.75 },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { flexShrink: 1, fontWeight: "600" },
  figure: { fontSize: 40, lineHeight: 46, fontWeight: "600", letterSpacing: -0.5 },
  figureSmall: { fontSize: 28, lineHeight: 33, fontWeight: "600", letterSpacing: -0.3 },
  spacer: { flex: 1, minHeight: spacing.xs },
});
