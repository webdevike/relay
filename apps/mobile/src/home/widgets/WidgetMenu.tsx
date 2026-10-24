/**
 * The long-press menu of a Home widget, drawn like iOS's: the screen behind dims and blurs, the
 * widget lifts in place, and a glass menu opens under it (over it when there is no room below)
 * with a row of size glyphs (the current one highlighted), Edit Home Screen and a red Remove
 * Widget. While VoiceOver is on it also lists Move Up and Move Down, since dragging is not
 * accessible. It is an overlay in Home's own tree rather than a modal so the finger that opened
 * it keeps driving the widget's gesture (moving on starts jiggle mode with the widget in hand).
 * A tap outside, or VoiceOver's escape, closes it.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { BlurView } from "expo-blur";
import { SymbolView, type SFSymbol } from "expo-symbols";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/ui/Text";
import { useScreenReader } from "@/lib/useScreenReader";
import { useSettingsStore } from "@/state/settings";
import { spacing, useColors, useScheme, withAlpha } from "@/theme";
import { WIDGET_SIZE_LIST, WIDGET_SIZES, type HomeWidget, type WidgetSize } from "./layout";
import { SIZE_LABEL, WIDGET_REGISTRY } from "./registry";
import { runWidgetAction, useWidgetUi, type WidgetAction, type WidgetMenuTarget } from "./ui";

const MENU_WIDTH = 250;
const SIZE_ROW = 60;
const ROW = 48;
/** Space between the lifted widget and the menu, and the menu and the screen edges. */
const MARGIN = 12;
const LIFT = 1.04;
const SPRING = { damping: 18, stiffness: 260, mass: 0.8 } as const;

interface MenuRow {
  action: WidgetAction;
  label: string;
  symbol: SFSymbol;
  destructive?: boolean;
}

/** A size's outline, like the glyphs at the top of iOS's widget menu: a square, a wide bar, or a big square. */
function SizeGlyph({ size, color }: { size: WidgetSize; color: string }) {
  return (
    <View
      style={[
        styles.glyph,
        size !== "small" && styles.glyphWide,
        size === "large" && styles.glyphTall,
        { borderColor: color },
      ]}
    >
      <View style={[styles.glyphDot, { backgroundColor: color }]} />
    </View>
  );
}

function Overlay({
  target,
  widget,
  index,
  count,
}: {
  target: WidgetMenuTarget;
  widget: HomeWidget;
  index: number;
  count: number;
}) {
  const colors = useColors();
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const screenReader = useScreenReader();
  const setUi = useWidgetUi((state) => state.set);
  const root = useRef<View>(null);
  // The overlay's own place in the window; the target was measured in window coordinates.
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const lift = useSharedValue(1);
  const grow = useSharedValue(0.9);
  useEffect(() => {
    lift.value = withSpring(LIFT, SPRING);
    grow.value = withSpring(1, SPRING);
  }, [lift, grow]);
  const lifted = useAnimatedStyle(() => ({ transform: [{ scale: lift.value }] }));
  const grown = useAnimatedStyle(() => ({ transform: [{ scale: grow.value }] }));

  const spec = WIDGET_REGISTRY[widget.kind];
  const { Body } = spec;
  const rows: MenuRow[] = [
    ...(screenReader && index > 0
      ? [{ action: "up" as const, label: "Move Up", symbol: "arrow.up" as const }]
      : []),
    ...(screenReader && index < count - 1
      ? [{ action: "down" as const, label: "Move Down", symbol: "arrow.down" as const }]
      : []),
    { action: "edit", label: "Edit Home Screen", symbol: "iphone" },
    { action: "remove", label: "Remove Widget", symbol: "minus.circle", destructive: true },
  ];

  const close = () => {
    setUi({ menu: null });
  };
  const choose = (action: WidgetAction) => {
    setUi({ menu: null });
    runWidgetAction(widget.id, action);
  };

  const left = target.x - origin.x;
  const top = target.y - origin.y;
  const menuHeight = SIZE_ROW + rows.length * ROW + spacing.sm;
  const grownBottom = top + target.height * (1 + (LIFT - 1) / 2);
  const below = grownBottom + MARGIN;
  const above = top - (target.height * (LIFT - 1)) / 2 - MARGIN - menuHeight;
  const floor = screen.height - insets.bottom - MARGIN;
  const placeBelow = below + menuHeight <= floor || above < insets.top + MARGIN;
  const menuTop = placeBelow ? Math.min(below, floor - menuHeight) : above;
  const alignRight = left + MENU_WIDTH > screen.width - spacing.lg;
  const menuLeft = Math.max(spacing.lg, alignRight ? left + target.width - MENU_WIDTH : left);
  const glyphColor = colors.text;

  return (
    <Animated.View
      ref={root}
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(120)}
      style={StyleSheet.absoluteFill}
      onLayout={() => {
        root.current?.measureInWindow((x, y) => {
          setOrigin({ x, y });
        });
      }}
      accessibilityViewIsModal
      onAccessibilityEscape={close}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={close}
        accessibilityLabel="Close menu"
        accessibilityRole="button"
      >
        <BlurView intensity={22} tint={scheme} style={StyleSheet.absoluteFill} />
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: withAlpha("#000000", scheme === "dark" ? 0.35 : 0.18) },
          ]}
        />
      </Pressable>
      <Animated.View
        pointerEvents="none"
        style={[styles.lifted, { left, top, width: target.width, height: target.height }, lifted]}
        accessibilityElementsHidden
      >
        <Body size={widget.size} open={null} a11y={null} />
      </Animated.View>
      <Animated.View
        style={[
          styles.menu,
          {
            left: menuLeft,
            top: menuTop,
            borderColor: colors.hairline,
            transformOrigin: `${alignRight ? "right" : "left"} ${placeBelow ? "top" : "bottom"}`,
          },
          grown,
        ]}
      >
        <BlurView
          intensity={90}
          tint={scheme === "dark" ? "systemThickMaterialDark" : "systemThickMaterialLight"}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.sizes} accessibilityRole="radiogroup" accessibilityLabel="Widget size">
          {WIDGET_SIZE_LIST.map((size) => {
            const offered = WIDGET_SIZES[widget.kind].includes(size);
            const current = size === widget.size;
            return (
              <Pressable
                key={size}
                accessibilityRole="radio"
                accessibilityLabel={SIZE_LABEL[size]}
                accessibilityState={{ selected: current, disabled: !offered }}
                disabled={!offered}
                onPress={() => {
                  if (current) close();
                  else choose(size);
                }}
                style={({ pressed }) => [
                  styles.size,
                  (current || pressed) && {
                    backgroundColor: withAlpha(
                      scheme === "dark" ? "#FFFFFF" : "#000000",
                      current ? 0.12 : 0.06,
                    ),
                  },
                  !offered && styles.unoffered,
                ]}
              >
                <SizeGlyph size={size} color={glyphColor} />
              </Pressable>
            );
          })}
        </View>
        {rows.map((row) => {
          const tint = row.destructive === true ? colors.danger : colors.text;
          return (
            <Pressable
              key={row.action}
              accessibilityRole="button"
              accessibilityLabel={row.label}
              onPress={() => {
                choose(row.action);
              }}
              style={({ pressed }) => [
                styles.row,
                pressed && {
                  backgroundColor: withAlpha(scheme === "dark" ? "#FFFFFF" : "#000000", 0.08),
                },
              ]}
            >
              <View style={styles.rowIcon}>
                <SymbolView name={row.symbol} size={19} tintColor={tint} />
              </View>
              <Text variant="body" numberOfLines={1} style={[styles.rowText, { color: tint }]}>
                {row.label}
              </Text>
            </Pressable>
          );
        })}
      </Animated.View>
    </Animated.View>
  );
}

/** Home renders this as the last child of its root view so it covers the whole screen. */
export function WidgetMenu() {
  const target = useWidgetUi((state) => state.menu);
  const widgets = useSettingsStore((state) => state.homeWidgets);
  if (target === null) return null;
  const index = widgets.findIndex((w) => w.id === target.id);
  const widget = widgets[index];
  if (widget === undefined) return null;
  return <Overlay target={target} widget={widget} index={index} count={widgets.length} />;
}

const styles = StyleSheet.create({
  lifted: {
    position: "absolute",
    shadowColor: "#000000",
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  menu: {
    position: "absolute",
    width: MENU_WIDTH,
    borderRadius: 28,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    paddingBottom: spacing.sm,
  },
  sizes: {
    height: SIZE_ROW,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  size: {
    height: 44,
    minWidth: 52,
    paddingHorizontal: spacing.sm,
    borderRadius: 12,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  unoffered: { opacity: 0.3 },
  glyph: {
    width: 20,
    height: 18,
    borderWidth: 1.6,
    borderRadius: 5,
    padding: 3,
  },
  glyphWide: { width: 32 },
  glyphTall: { height: 30 },
  glyphDot: { width: 5, height: 3, borderRadius: 1.5 },
  row: {
    height: ROW,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowIcon: { width: 24, alignItems: "center" },
  rowText: { flex: 1, fontSize: 17, lineHeight: 22 },
});
