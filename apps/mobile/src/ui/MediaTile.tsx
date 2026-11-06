import { Image, Pressable, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useColors } from "@/theme";
import { impactHaptic } from "@/lib/haptics";
import { OverlayTag } from "./OverlayTag";

/** Corner radius of a grid tile. */
export const MEDIA_TILE_RADIUS = 6;
const CHECK = 22;

export interface MediaTileProps {
  /** Null while there is nothing to fetch it from (disconnected); the tile stays blank. */
  uri: string | null;
  size: number;
  accessibilityLabel: string;
  /** Shows the selection circle on every tile; `selected` fills it. */
  selecting?: boolean;
  selected?: boolean;
  /** A white heart in the top-right corner (hidden while selecting). */
  favorite?: boolean;
  /** Bottom-left tag, e.g. a video's play glyph and length. */
  leading?: { icon: SFSymbol; label?: string | undefined } | undefined;
  /** Bottom-right tag, e.g. how many versions it has. */
  trailing?: { icon: SFSymbol; label?: string | undefined } | undefined;
  onPress: () => void;
  /** A held press, with a medium haptic. */
  onLongPress?: () => void;
}

/** A square-cropped grid tile: tap opens it, a long press selects it; corner marks for selection, favorite and counts. */
export function MediaTile({ uri, size, accessibilityLabel, selecting = false, selected = false, favorite = false, leading, trailing, onPress, onLongPress }: MediaTileProps) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selecting ? { selected } : undefined}
      onPress={onPress}
      onLongPress={
        onLongPress === undefined
          ? undefined
          : () => {
              impactHaptic();
              onLongPress();
            }
      }
      style={({ pressed }) => ({ width: size, height: size, borderRadius: MEDIA_TILE_RADIUS, overflow: "hidden", backgroundColor: colors.surfaceRaised, opacity: pressed ? 0.85 : 1 })}
    >
      {uri !== null && <Image source={{ uri }} resizeMode="cover" style={{ width: size, height: size, opacity: selected ? 0.82 : 1 }} />}
      {selected && <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: MEDIA_TILE_RADIUS, borderWidth: 2, borderColor: colors.accent }} />}
      {selecting && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            width: CHECK,
            height: CHECK,
            borderRadius: CHECK / 2,
            borderWidth: 1.5,
            borderColor: selected ? colors.accent : "rgba(255,255,255,0.9)",
            backgroundColor: selected ? colors.accent : "rgba(0,0,0,0.28)",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {selected && <SymbolView name="checkmark" size={12} weight="bold" tintColor="#FFFFFF" />}
        </View>
      )}
      {favorite && !selecting && (
        <View pointerEvents="none" style={{ position: "absolute", top: 8, right: 8, shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }}>
          <SymbolView name="heart.fill" size={16} tintColor="#FFFFFF" />
        </View>
      )}
      {leading !== undefined && <OverlayTag icon={leading.icon} label={leading.label} corner="bottom-left" />}
      {trailing !== undefined && <OverlayTag icon={trailing.icon} label={trailing.label} corner="bottom-right" />}
    </Pressable>
  );
}
