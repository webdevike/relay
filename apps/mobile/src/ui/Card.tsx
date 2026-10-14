import type { ReactNode } from "react";
import { View } from "react-native";
import { radii, useColors } from "@/theme";

export interface CardProps {
  children: ReactNode;
  /** Caps the card's height; content past it scrolls inside the card. */
  maxHeight?: number;
}

/** A raised, hairline-bordered panel that floats over a screen: the shell of the ask and gate cards. */
export function Card({ children, maxHeight }: CardProps) {
  const colors = useColors();
  return (
    <View
      style={{
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: colors.surfaceRaised,
        overflow: "hidden",
        maxHeight,
      }}
    >
      {children}
    </View>
  );
}
