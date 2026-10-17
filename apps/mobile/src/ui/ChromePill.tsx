import type { ReactNode } from "react";
import { View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { Text } from "@/ui/Text";
import { spacing } from "@/theme";

/** Height of the pill, matching a 44pt `IconButton`. */
export const CHROME_PILL_HEIGHT = 44;
/** Translucent white fill, the same as `IconButton` `tone="overlay"`. */
const FILL = "rgba(255,255,255,0.12)";

export interface ChromePillProps {
  /** Glyph before the label. */
  symbol?: SFSymbol;
  label?: string;
  /** Controls inside the pill, e.g. `IconButton`s with a transparent background. */
  children?: ReactNode;
}

/**
 * A translucent white capsule for controls floating over the black full-screen viewer: either a
 * glyph with a label (the title chip) or a row of round icon buttons (the toolbars).
 */
export function ChromePill({ symbol, label, children }: ChromePillProps) {
  return (
    <View
      style={{
        height: CHROME_PILL_HEIGHT,
        borderRadius: CHROME_PILL_HEIGHT / 2,
        backgroundColor: FILL,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.sm,
        paddingHorizontal: label === undefined ? 0 : spacing.lg,
      }}
    >
      {symbol !== undefined && <SymbolView name={symbol} size={18} tintColor="#FFFFFF" />}
      {label !== undefined && (
        <Text variant="title" numberOfLines={1} style={{ color: "#FFFFFF" }}>
          {label}
        </Text>
      )}
      {children}
    </View>
  );
}
