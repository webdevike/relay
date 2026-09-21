import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { colors } from "@/theme";

export const CUTOUT_GAP = 4;

export interface CutoutProps {
  /** Height of the content; also its width unless `width` is given. */
  size: number;
  /** Content width for a pill; omit for a circle. */
  width?: number;
  style: ViewStyle;
  children: ReactNode;
}

/** A ring of screen background around an edge element so it reads as carved out of the surfaces it straddles. */
export function Cutout({ size, width = size, style, children }: CutoutProps) {
  const outerHeight = size + CUTOUT_GAP * 2;
  const outerWidth = width + CUTOUT_GAP * 2;
  return (
    <View
      style={[
        {
          position: "absolute",
          width: outerWidth,
          height: outerHeight,
          borderTopLeftRadius: outerHeight / 2,
          borderTopRightRadius: outerHeight / 2,
          borderBottomLeftRadius: outerHeight / 2,
          borderBottomRightRadius: outerHeight / 2,
          padding: CUTOUT_GAP,
          backgroundColor: colors.bg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
