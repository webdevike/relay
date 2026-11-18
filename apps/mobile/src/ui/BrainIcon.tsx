import { useMemo } from "react";
import { SymbolView } from "expo-symbols";
import { loadSkia } from "@/dictation/skia";

/** Tabler's IconBrain (24 x 24 box): what opens an assistant turn's work (`agents/WorkBrain`, `agents/TurnWorkSheet`). */
const PATHS = [
  "M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8",
  "M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8",
  "M17.5 16a3.5 3.5 0 0 0 0 -7h-.5",
  "M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0",
  "M6.5 16a3.5 3.5 0 0 1 0 -7h.5",
  "M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10",
];
/** Tabler's outline weight, as the router glyph draws it. */
const STROKE = 1.5;

/** A brain glyph at `size` pt in `color`, drawn with Skia; a build without Skia gets SF Symbols' `brain`. */
export function BrainIcon({ size, color }: { size: number; color: string }) {
  const skia = loadSkia();
  const paths = useMemo(() => {
    if (skia === null) return null;
    const made = PATHS.map((d) => skia.Skia.Path.MakeFromSVGString(d));
    return made.every((path): path is NonNullable<typeof path> => path !== null) ? made : null;
  }, [skia]);
  if (skia === null || paths === null)
    return <SymbolView name="brain" size={size} tintColor={color} />;
  const { Canvas, Group, Path } = skia;
  return (
    <Canvas style={{ width: size, height: size }} pointerEvents="none">
      <Group transform={[{ scale: size / 24 }]}>
        {paths.map((path, i) => (
          <Path
            key={i}
            path={path}
            style="stroke"
            strokeWidth={STROKE}
            strokeCap="round"
            strokeJoin="round"
            color={color}
          />
        ))}
      </Group>
    </Canvas>
  );
}
