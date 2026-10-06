import type { SFSymbol } from "expo-symbols";
import { Image, Pressable, View } from "react-native";

import { radii, useColors } from "@/theme";
import { OverlayTag } from "@/ui/OverlayTag";

export interface ImageFrameProps {
  uri: string;
  width: number;
  height: number;
  onPress?: (() => void) | undefined;
  badge?: SFSymbol | undefined;
  resizeMode?: "contain" | "cover" | undefined;
}

/** Base image element: a rounded, sized frame around an image, optionally tappable with a corner badge. */
export function ImageFrame({ uri, width, height, onPress, badge, resizeMode }: ImageFrameProps) {
  const colors = useColors();
  const frame = (
    <View
      style={{
        width,
        height,
        borderRadius: radii.sm,
        overflow: "hidden",
        backgroundColor: colors.surface,
      }}
    >
      <Image source={{ uri }} resizeMode={resizeMode ?? "contain"} style={{ width, height }} />
      {badge !== undefined ? <OverlayTag icon={badge} corner="bottom-right" /> : null}
    </View>
  );
  if (onPress === undefined) return frame;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      {frame}
    </Pressable>
  );
}
