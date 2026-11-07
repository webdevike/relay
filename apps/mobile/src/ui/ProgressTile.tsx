import { Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { spacing, useColors } from "@/theme";
import { MEDIA_TILE_RADIUS } from "./MediaTile";
import { Text } from "./Text";

const BAR = 3;

export interface ProgressTileProps {
  size: number;
  /** The big line: "42%", "Queued". */
  title: string;
  /** Muted lines under it: the step, the time left. */
  details: readonly string[];
  /** 0..1, drawn as a thin bar along the bottom. */
  fraction: number;
  /** Shows a Cancel x in the corner that stops this job. */
  onCancel?: (() => void) | undefined;
}

/** A grid tile for something still being made: its state in the middle and a thin progress bar at the bottom. */
export function ProgressTile({ size, title, details, fraction, onCancel }: ProgressTileProps) {
  const colors = useColors();
  const share = Math.min(Math.max(fraction, 0), 1);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={[title, ...details].join(", ")}
      style={{ width: size, height: size, borderRadius: MEDIA_TILE_RADIUS, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.sm }}
    >
      <Text variant="title" tabular>
        {title}
      </Text>
      {details.map((line) => (
        <Text key={line} variant="caption" color="textMuted" numberOfLines={1} style={{ textAlign: "center" }}>
          {line}
        </Text>
      ))}
      {onCancel !== undefined && (
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={10} onPress={onCancel} style={{ position: "absolute", top: spacing.sm, right: spacing.sm, width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.hairline }}>
          <SymbolView name="xmark" size={11} tintColor={colors.text} />
        </Pressable>
      )}
      <View style={{ position: "absolute", left: spacing.md, right: spacing.md, bottom: spacing.md, height: BAR, borderRadius: BAR / 2, backgroundColor: colors.hairline, overflow: "hidden" }}>
        <View style={{ width: `${share * 100}%`, height: BAR, backgroundColor: colors.accent }} />
      </View>
    </View>
  );
}
