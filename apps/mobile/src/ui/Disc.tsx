import { StyleSheet, View } from "react-native";
import { loadSkia } from "@/dictation/skia";

/**
 * A filled circle that fills its parent (place it first, under the glyph). Drawn with Skia when the
 * build has it: a View circle from `borderRadius` came out as a teardrop on iOS (one corner left
 * square by Fabric), which no combination of corner props fixed.
 */
export function Disc({ size, color }: { size: number; color: string }) {
  const sk = loadSkia();
  if (sk === null) return <View style={[StyleSheet.absoluteFill, { borderRadius: size / 2, backgroundColor: color }]} />;
  return (
    <sk.Canvas style={StyleSheet.absoluteFill}>
      <sk.Circle cx={size / 2} cy={size / 2} r={size / 2} color={color} />
    </sk.Canvas>
  );
}
