import { useState } from "react";
import { Image, Pressable, View } from "react-native";
import { radii, spacing, useColors } from "@/theme";
import { OverlayTag } from "./OverlayTag";

export interface ThumbGridItem {
  key: string;
  /** Null while there is nothing to fetch it from (disconnected); the tile stays blank. */
  uri: string | null;
  /** A video's length ("0:05"), shown with a play glyph in the corner. */
  length?: string | undefined;
  accessibilityLabel: string;
}

export interface ThumbGridProps {
  items: readonly ThumbGridItem[];
  columns?: number;
  gap?: number;
  onPress: (key: string) => void;
}

/** Square-cropped thumbnails in equal columns that fill the width they get; tap opens one. */
export function ThumbGrid({ items, columns = 3, gap = spacing.xs, onPress }: ThumbGridProps) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const tile = width === 0 ? 0 : Math.floor((width - gap * (columns - 1)) / columns);
  return (
    <View
      style={{ flexDirection: "row", flexWrap: "wrap", gap }}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
      }}
    >
      {tile > 0 &&
        items.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="imagebutton"
            accessibilityLabel={item.accessibilityLabel}
            onPress={() => {
              onPress(item.key);
            }}
            style={({ pressed }) => ({ width: tile, height: tile, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surfaceRaised, opacity: pressed ? 0.85 : 1 })}
          >
            {item.uri !== null && <Image source={{ uri: item.uri }} resizeMode="cover" style={{ width: tile, height: tile }} />}
            {item.length !== undefined && <OverlayTag icon="play.fill" label={item.length} corner="bottom-right" />}
          </Pressable>
        ))}
    </View>
  );
}
