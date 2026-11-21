import type { SFSymbol } from "expo-symbols";
import { Image, Pressable, View } from "react-native";

import { radii, useColors } from "@/theme";
import { Holdable } from "@/ui/Holdable";
import { OverlayTag } from "@/ui/OverlayTag";

export interface ImageFrameProps {
  uri: string;
  width: number;
  height: number;
  onPress?: (() => void) | undefined;
  /** Holding the image (`Holdable`): its save and share menu. */
  onLongPress?: (() => void) | undefined;
  badge?: SFSymbol | undefined;
  resizeMode?: "contain" | "cover" | undefined;
  /** Corner radius; defaults to the small token. */
  radius?: number | undefined;
  /** Alt text read by VoiceOver. */
  alt?: string | undefined;
  /** The image failed to load; gets the platform's reason (may be empty). */
  onError?: ((error: string) => void) | undefined;
}

/** Base image element: a rounded, sized frame around an image, optionally tappable or holdable, with a corner badge. */
export function ImageFrame({ uri, width, height, onPress, onLongPress, badge, resizeMode, radius, alt, onError }: ImageFrameProps) {
  const colors = useColors();
  const frame = (
    <View
      style={{
        width,
        height,
        borderRadius: radius ?? radii.sm,
        overflow: "hidden",
        backgroundColor: colors.surface,
      }}
    >
      <Image
        source={{ uri }}
        resizeMode={resizeMode ?? "contain"}
        style={{ width, height }}
        accessible={alt !== undefined}
        accessibilityLabel={alt}
        onError={onError === undefined ? undefined : (event) => { onError(String(event.nativeEvent.error ?? "")); }}
      />
      {badge !== undefined ? <OverlayTag icon={badge} corner="bottom-right" /> : null}
    </View>
  );
  return (
    <Holdable onHold={onLongPress}>
      {onPress === undefined ? (
        frame
      ) : (
        <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
          {frame}
        </Pressable>
      )}
    </Holdable>
  );
}
