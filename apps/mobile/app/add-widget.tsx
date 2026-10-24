/**
 * Add Widget (`/add-widget`): Home's widget gallery as a native iOS sheet, listing every widget
 * kind with a live preview at each size it offers, drawn from the same stores as the placed
 * widgets. Tapping a preview adds that widget at the end of Home's grid and closes the sheet.
 */
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Text } from "@/ui/Text";
import { notifyHaptic } from "@/lib/haptics";
import { AppGlyph } from "@/home/AppRow";
import {
  addWidget,
  WIDGET_GAP,
  widgetBox,
  WIDGET_KINDS,
  WIDGET_SIZES,
} from "@/home/widgets/layout";
import { SIZE_LABEL, WIDGET_REGISTRY } from "@/home/widgets/registry";
import { editWidgets, useWidgetUi } from "@/home/widgets/ui";
import { spacing, useColors } from "@/theme";

export default function AddWidget() {
  const router = useRouter();
  const colors = useColors();
  const screen = useWindowDimensions();
  // Content is inset by `spacing.xl` on each side.
  const width = screen.width - spacing.xl * 2;
  // Home keeps jiggle mode while this sheet is up; closing it hands focus back normally.
  useEffect(
    () => () => {
      useWidgetUi.getState().set({ adding: false });
    },
    [],
  );

  return (
    <ScrollView style={{ backgroundColor: colors.surface }} contentContainerStyle={styles.content}>
      <Text variant="title" style={styles.heading}>
        Add Widget
      </Text>
      {WIDGET_KINDS.map((kind) => {
        const spec = WIDGET_REGISTRY[kind];
        const { Body } = spec;
        return (
          <View key={kind} style={styles.kind}>
            <View style={styles.kindHead}>
              <AppGlyph color={spec.color} symbol={spec.symbol} />
              <View style={styles.flex}>
                <Text variant="body" style={styles.kindTitle}>
                  {spec.title}
                </Text>
                <Text variant="caption" color="textMuted">
                  {spec.description}
                </Text>
              </View>
            </View>
            <View style={styles.previews}>
              {WIDGET_SIZES[kind].map((size) => (
                <Pressable
                  key={size}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${spec.title} widget, ${SIZE_LABEL[size].toLowerCase()}`}
                  onPress={() => {
                    notifyHaptic("success");
                    editWidgets((widgets) => addWidget(widgets, kind, size));
                    router.back();
                  }}
                  style={({ pressed }) => [styles.preview, pressed && styles.pressed]}
                >
                  <View style={widgetBox(size, { width, gap: WIDGET_GAP })}>
                    <Body size={size} open={null} a11y={null} />
                  </View>
                  <Text variant="caption" color="textMuted" style={styles.sizeLabel}>
                    {SIZE_LABEL[size]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.xxl, paddingBottom: spacing.xxxl },
  heading: { paddingBottom: spacing.lg },
  kind: { paddingBottom: spacing.xxl, gap: spacing.md },
  kindHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  flex: { flex: 1 },
  kindTitle: { fontWeight: "600" },
  previews: { gap: spacing.md },
  preview: { alignSelf: "flex-start", gap: 6 },
  pressed: { opacity: 0.7 },
  sizeLabel: { textAlign: "center" },
});
