import { useMemo } from "react";
import { SymbolView } from "expo-symbols";
import { loadSkia } from "@/dictation/skia";

/** Tabler's IconRoute (24 x 24 box), the desktop's specialist router glyph. */
const PATHS = [
  "M3 19a2 2 0 1 0 4 0a2 2 0 0 0 -4 0",
  "M19 7a2 2 0 1 0 0 -4a2 2 0 0 0 0 4",
  "M11 19h5.5a3.5 3.5 0 0 0 0 -7h-8a3.5 3.5 0 0 1 0 -7h4.5",
];
/** The desktop draws it at stroke 1.5 in its 24 box. */
const STROKE = 1.5;

/** A route glyph at `size` pt in `color`, drawn with Skia; a build without Skia gets `arrow.triangle.branch`. */
export function RouteIcon({ size, color }: { size: number; color: string }) {
  const skia = loadSkia();
  const paths = useMemo(() => {
    if (skia === null) return null;
    const made = PATHS.map((d) => skia.Skia.Path.MakeFromSVGString(d));
    return made.every((path): path is NonNullable<typeof path> => path !== null) ? made : null;
  }, [skia]);
  if (skia === null || paths === null)
    return <SymbolView name="arrow.triangle.branch" size={size} tintColor={color} />;
  const { Canvas, Group, Path } = skia;
  return (
    <Canvas style={{ width: size, height: size }} pointerEvents="none">
      <Group transform={[{ scale: size / 24 }]}>
        {paths.map((path, i) => (
          <Path key={i} path={path} style="stroke" strokeWidth={STROKE} strokeCap="round" strokeJoin="round" color={color} />
        ))}
      </Group>
    </Canvas>
  );
}
