import { useMemo } from "react";
import { View } from "react-native";
import { loadSkia } from "@/dictation/skia";
import { portraitSvg } from "@/lib/portrait";
import { palettes } from "@/theme";
import { Avatar } from "./Avatar";

export interface PortraitProps {
  /** Who it is: the accessibility label, and the initials when the build has no Skia. */
  name: string;
  /** The notionists seed (`lib/portrait` `portraitSeed`). */
  seed: string;
  size?: number;
}

// The line art is black, so the disc stays the light palette's raised surface in both schemes.
const PAPER = palettes.light.surfaceRaised;

/** An assistant's illustrated portrait on a round light disc; the initials `Avatar` without Skia. */
export function Portrait({ name, seed, size = 36 }: PortraitProps) {
  const sk = loadSkia();
  const svg = useMemo(() => (sk === null ? null : sk.Skia.SVG.MakeFromString(portraitSvg(seed))), [sk, seed]);
  if (sk === null || svg === null) return <Avatar name={name} size={size} />;
  return (
    <View
      accessible
      accessibilityLabel={name}
      style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", backgroundColor: PAPER }}
    >
      <sk.Canvas style={{ width: size, height: size }}>
        <sk.ImageSVG svg={svg} x={0} y={0} width={size} height={size} />
      </sk.Canvas>
    </View>
  );
}
