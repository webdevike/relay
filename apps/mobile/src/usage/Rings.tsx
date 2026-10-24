/**
 * Activity-style concentric rings, one per usage window (outermost first), each filled to its
 * used share on a faint track of its own colour. Drawn with Skia; a build without Skia gets
 * stacked bars instead so the numbers still show.
 */
import { View } from "react-native";
import { loadSkia } from "@/dictation/skia";
import { withAlpha } from "@/theme";

export interface Ring {
  key: string;
  fraction: number;
  color: string;
}

/** Ring width at the Usage screen's size; smaller callers (Home's widgets) pass a thinner one. */
const STROKE = 11;

export function Rings({ rings, size, stroke = STROKE }: { rings: readonly Ring[]; size: number; stroke?: number }) {
  // The space between rings keeps the Usage screen's 11:3 proportion at any width.
  const gap = Math.max(2, Math.round((stroke * 3) / 11));
  const skia = loadSkia();
  if (skia === null) {
    return (
      <View style={{ width: size, gap: 6, justifyContent: "center" }}>
        {rings.map((r) => (
          <View
            key={r.key}
            style={{ height: 8, borderRadius: 4, backgroundColor: withAlpha(r.color, 0.2) }}
          >
            <View
              style={{
                width: `${Math.min(1, r.fraction) * 100}%`,
                height: 8,
                borderRadius: 4,
                backgroundColor: r.color,
              }}
            />
          </View>
        ))}
      </View>
    );
  }
  const { Canvas, Path, Skia } = skia;
  return (
    <Canvas style={{ width: size, height: size }}>
      {rings.map((r, i) => {
        const inset = stroke / 2 + i * (stroke + gap);
        const rect = { x: inset, y: inset, width: size - inset * 2, height: size - inset * 2 };
        const track = Skia.Path.Make();
        track.addOval(rect);
        const arc = Skia.Path.Make();
        // A sliver still shows at 0 so an empty window reads as a ring, not a missing one.
        arc.addArc(rect, -90, Math.max(2, Math.min(1, r.fraction) * 360));
        return [
          <Path
            key={`${r.key}-t`}
            path={track}
            style="stroke"
            strokeWidth={stroke}
            color={withAlpha(r.color, 0.18)}
          />,
          <Path
            key={`${r.key}-a`}
            path={arc}
            style="stroke"
            strokeWidth={stroke}
            strokeCap="round"
            color={r.color}
          />,
        ];
      })}
    </Canvas>
  );
}
