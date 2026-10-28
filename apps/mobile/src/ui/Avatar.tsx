import { useState } from "react";
import { Image, View } from "react-native";
import { useColors, withAlpha } from "@/theme";
import { Text } from "./Text";

export interface AvatarProps {
  name: string;
  /** Photo to show; without one (or when it fails to load) the name's initials stand in. */
  uri?: string | null | undefined;
  size?: number;
  /** `#RRGGBB` identity color: the initials take it, on a low-alpha disc of it, instead of the neutral ones. */
  tint?: string | undefined;
}

/** A round photo, or the first letters of the name's first two words on a neutral (or tinted) disc. */
export function Avatar({ name, uri, size = 36, tint }: AvatarProps) {
  const colors = useColors();
  const [failed, setFailed] = useState<string | null>(null);
  const photo = uri !== null && uri !== undefined && uri !== failed ? uri : null;
  if (photo !== null) {
    return (
      <Image
        source={{ uri: photo }}
        accessibilityLabel={name}
        onError={() => {
          setFailed(photo);
        }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.surfaceRaised,
        }}
      />
    );
  }
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <View
      accessibilityLabel={name}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tint === undefined ? colors.surfaceRaised : withAlpha(tint, 0.18),
      }}
    >
      <Text variant="label" color="textMuted" style={[{ fontSize: Math.round(size * 0.38) }, tint !== undefined && { color: tint }]}>
        {initials}
      </Text>
    </View>
  );
}
