import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { colors } from "@/theme";

export const CUTOUT_GAP = 4;

/** A ring of screen background around an edge button so it reads as carved out of the surface. */
export function Cutout({ size, style, children }: { size: number; style: ViewStyle; children: ReactNode }) {
  const outer = size + CUTOUT_GAP * 2;
  return (
    <View
      style={[
        { position: "absolute", width: outer, height: outer, borderRadius: outer / 2, padding: CUTOUT_GAP, backgroundColor: colors.bg },
        style,
      ]}
    >
      {children}
    </View>
  );
}
