import { useMemo } from "react";
import { SymbolView } from "expo-symbols";
import { loadSkia } from "@/dictation/skia";

/** Tabler's IconChefHat (24 x 24 box), the desktop's specialist glyph; SF Symbols has no chef hat. */
const HAT = "M12 3c1.918 0 3.52 1.35 3.91 3.151a4 4 0 0 1 2.09 7.723l0 7.126h-12v-7.126a4 4 0 1 1 2.092 -7.723a4 4 0 0 1 3.908 -3.151";
const BAND = "M6.161 17.009l11.839 -.009";
/** The desktop draws it at stroke 1.5 in its 24 box. */
const STROKE = 1.5;

/** A chef hat outline at `size` pt in `color`, drawn with Skia; a build without Skia gets `fork.knife`. */
export function ChefHatIcon({ size, color }: { size: number; color: string }) {
  const skia = loadSkia();
  const paths = useMemo(() => {
    if (skia === null) return null;
    const hat = skia.Skia.Path.MakeFromSVGString(HAT);
    const band = skia.Skia.Path.MakeFromSVGString(BAND);
    return hat === null || band === null ? null : { hat, band };
  }, [skia]);
  if (skia === null || paths === null) return <SymbolView name="fork.knife" size={size} tintColor={color} />;
  const { Canvas, Group, Path } = skia;
  return (
    <Canvas style={{ width: size, height: size }} pointerEvents="none">
      <Group transform={[{ scale: size / 24 }]}>
        {[paths.hat, paths.band].map((path, i) => (
          <Path key={i} path={path} style="stroke" strokeWidth={STROKE} strokeCap="round" strokeJoin="round" color={color} />
        ))}
      </Group>
    </Canvas>
  );
}
