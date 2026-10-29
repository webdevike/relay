import { ActivityIndicator, Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { radii, spacing, useColors } from "@/theme";
import { IconButton } from "./IconButton";
import { ImageFrame } from "./ImageFrame";
import { Text } from "./Text";

const REMOVE_SIZE = 28;

export interface MediaSlotProps {
  /** What goes here ("Start", "Reference 2"), under the frame. */
  label: string;
  size: number;
  /** The filled image, or null for an empty slot. */
  uri: string | null;
  /** Filled but nothing to show (disconnected, unknown file). */
  filled?: boolean;
  /** Something is on its way in (an upload). */
  busy?: boolean;
  /** Tap on an empty slot. */
  onAdd: () => void;
  /** Tap on a filled slot. */
  onPress?: (() => void) | undefined;
  /** Empties a filled slot; without it the slot has no x. */
  onRemove?: (() => void) | undefined;
}

/**
 * A big square place for one image: empty it is a dashed "Add" target, filled it shows the
 * picture cropped square with an x in the corner that empties it.
 */
export function MediaSlot({ label, size, uri, filled = uri !== null, busy = false, onAdd, onPress, onRemove }: MediaSlotProps) {
  const colors = useColors();
  return (
    <View style={{ width: size, gap: spacing.xs }}>
      {filled ? (
        <View style={{ width: size, height: size }}>
          {uri === null ? (
            <View style={{ width: size, height: size, borderRadius: radii.md, backgroundColor: colors.surfaceRaised }} />
          ) : (
            <ImageFrame uri={uri} width={size} height={size} resizeMode="cover" radius={radii.md} alt={label} onPress={onPress} />
          )}
          {onRemove !== undefined && (
            <View style={{ position: "absolute", top: spacing.xs, right: spacing.xs }}>
              <IconButton symbol="xmark" size={REMOVE_SIZE} glyphSize={12} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} backgroundColor="rgba(0,0,0,0.65)" tintColor="#FFFFFF" accessibilityLabel={`Remove ${label.toLowerCase()} image`} onPress={onRemove} />
            </View>
          )}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add ${label.toLowerCase()} image`}
          disabled={busy}
          onPress={onAdd}
          style={({ pressed }) => ({
            width: size,
            height: size,
            borderRadius: radii.md,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: colors.hairline,
            backgroundColor: pressed ? colors.surfaceRaised : colors.surface,
            alignItems: "center",
            justifyContent: "center",
            gap: spacing.xs,
          })}
        >
          {busy ? <ActivityIndicator color={colors.textMuted} /> : <SymbolView name="plus" size={20} tintColor={colors.textMuted} />}
          {!busy && (
            <Text variant="caption" color="textMuted">
              Add
            </Text>
          )}
        </Pressable>
      )}
      <Text variant="caption" color="textMuted" numberOfLines={1} style={{ textAlign: "center" }}>
        {label}
      </Text>
    </View>
  );
}
