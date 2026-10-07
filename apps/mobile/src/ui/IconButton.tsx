import { Pressable, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useColors } from "@/theme";
import { impactHaptic, tapHaptic } from "@/lib/haptics";
import { loadSkia } from "@/dictation/skia";

export interface IconButtonProps {
  symbol: SFSymbol;
  onPress: () => void;
  size?: number;
  tintColor?: string;
  disabled?: boolean;
  backgroundColor?: string;
  /** `overlay`: white glyph on a translucent disc, for controls over photos or the black viewer. */
  tone?: "default" | "overlay";
  /**
   * `press`: a medium haptic and a slight shrink the moment the finger lands, for primary actions
   * that should feel immediate (Send). `release` (default): a light haptic when the tap completes.
   */
  feedback?: "release" | "press";
  /** Extra touchable margin (pt) around the disc; must stay inside the parent's bounds. */
  hitSlop?: number;
}

const OVERLAY = { tint: "#FFFFFF", background: "rgba(255,255,255,0.12)" } as const;

/**
 * Round icon button. The disc is drawn with Skia when the build has it: a View circle from
 * `borderRadius` came out as a teardrop on iOS (one corner left square by Fabric), which no
 * combination of corner props fixed.
 */
export function IconButton({
  symbol,
  onPress,
  size = 40,
  tintColor: tintOverride,
  disabled = false,
  backgroundColor: backgroundOverride,
  tone = "default",
  feedback = "release",
  hitSlop,
}: IconButtonProps) {
  const colors = useColors();
  const overlay = tone === "overlay";
  const backgroundColor =
    backgroundOverride ?? (overlay ? OVERLAY.background : colors.surfaceRaised);
  const tintColor = tintOverride ?? (overlay ? OVERLAY.tint : colors.text);
  const sk = loadSkia();
  return (
    <Pressable
      disabled={disabled}
      {...(hitSlop === undefined ? {} : { hitSlop })}
      onPressIn={() => {
        if (feedback === "press") impactHaptic();
      }}
      onPress={() => {
        if (feedback === "release") tapHaptic();
        onPress();
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
        transform: [{ scale: pressed && feedback === "press" ? 0.9 : 1 }],
      })}
    >
      {sk === null ? (
        <View style={[StyleSheet.absoluteFill, { borderRadius: size / 2, backgroundColor }]} />
      ) : (
        <sk.Canvas style={StyleSheet.absoluteFill}>
          <sk.Circle cx={size / 2} cy={size / 2} r={size / 2} color={backgroundColor} />
        </sk.Canvas>
      )}
      <SymbolView name={symbol} size={size * 0.45} tintColor={tintColor} />
    </Pressable>
  );
}
