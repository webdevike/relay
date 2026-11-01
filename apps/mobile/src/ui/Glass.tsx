import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { tapHaptic } from "@/lib/haptics";
import { spacing, useColors, useScheme, withAlpha } from "@/theme";
import { Text } from "./Text";

/** Height of glass buttons and bars, a 44pt touch target. */
export const GLASS_HEIGHT = 44;
const BLUR_INTENSITY = 40;

export interface GlassProps {
  radius: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * A frosted surface for chrome that floats over a scrolling page (iOS's glass controls): a blur of
 * what is under it, a translucent raised tint over the blur and a hairline edge.
 */
export function Glass({ radius, style, children }: GlassProps) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <View style={[styles.glass, { borderRadius: radius, borderColor: colors.hairline }, style]}>
      <BlurView intensity={BLUR_INTENSITY} tint={scheme} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.surfaceRaised, 0.6) }]} />
      {children}
    </View>
  );
}

export interface GlassButtonProps {
  symbol: SFSymbol;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string | undefined;
}

/** A round glass button with one glyph (back, the inbox). */
export function GlassButton({ symbol, onPress, accessibilityLabel, testID }: GlassButtonProps) {
  const colors = useColors();
  return (
    <Glass radius={GLASS_HEIGHT / 2} style={styles.round}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        hitSlop={4}
        onPress={() => {
          tapHaptic();
          onPress();
        }}
        style={({ pressed }) => [styles.fill, pressed && styles.pressed]}
      >
        <SymbolView name={symbol} size={19} tintColor={colors.text} />
      </Pressable>
    </Glass>
  );
}

export interface GlassSegment {
  key: string;
  symbol: SFSymbol;
  /** Without one the segment is a round-sized glyph button. */
  label?: string | undefined;
  onPress: () => void;
  accessibilityLabel?: string | undefined;
  testID?: string | undefined;
}

export interface GlassBarProps {
  segments: readonly GlassSegment[];
  /** Sizing from the caller (`flex: 1` for a full-width bar); glyph-only bars size to their segments. */
  style?: StyleProp<ViewStyle>;
}

/**
 * One glass capsule of segments split by thin dividers: labelled segments share the width
 * (Unread | Snooze | Done, the "+ Comment" pill), glyph-only ones are 44pt each (a header's
 * edit and ⋯ capsule).
 */
export function GlassBar({ segments, style }: GlassBarProps) {
  const colors = useColors();
  return (
    <Glass radius={GLASS_HEIGHT / 2} style={[styles.bar, style]}>
      {segments.map((segment, index) => (
        <View key={segment.key} style={[styles.segmentWrap, segment.label === undefined ? styles.glyphOnly : styles.grow]}>
          {index > 0 && <View style={[styles.divider, { backgroundColor: colors.hairline }]} />}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={segment.accessibilityLabel ?? segment.label}
            testID={segment.testID}
            onPress={() => {
              tapHaptic();
              segment.onPress();
            }}
            style={({ pressed }) => [styles.segment, pressed && styles.pressed]}
          >
            <SymbolView name={segment.symbol} size={segment.label === undefined ? 19 : 16} tintColor={colors.text} />
            {segment.label !== undefined && (
              <Text variant="label" numberOfLines={1}>
                {segment.label}
              </Text>
            )}
          </Pressable>
        </View>
      ))}
    </Glass>
  );
}

const styles = StyleSheet.create({
  glass: { overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  round: { width: GLASS_HEIGHT, height: GLASS_HEIGHT },
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
  bar: { height: GLASS_HEIGHT, flexDirection: "row", alignItems: "center" },
  segmentWrap: { flexDirection: "row", alignItems: "center", height: "100%" },
  grow: { flex: 1 },
  glyphOnly: { width: GLASS_HEIGHT },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 20 },
  segment: { flex: 1, height: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs + 2 },
});
