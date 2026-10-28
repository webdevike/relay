import { useMemo } from "react";
import { View } from "react-native";
import type { AssistantPortrait } from "@relay/protocol";
import { loadSkia } from "@/dictation/skia";
import { portraitSvg } from "@/lib/portrait";
import { palettes } from "@/theme";
import { Avatar } from "./Avatar";

export interface PortraitProps {
  /** Who it is: the accessibility label, and the initials when the build has no Skia. */
  name: string;
  /** What to draw (`lib/portrait` `portraitOf`). */
  portrait: AssistantPortrait;
  size?: number;
}

// The line art is black, so a portrait without its own paper sits on the light palette's raised surface in both schemes.
const PAPER = palettes.light.surfaceRaised;

/** An assistant's illustrated portrait on a round disc of its paper color; the initials `Avatar` without Skia. */
export function Portrait({ name, portrait, size = 36 }: PortraitProps) {
  const sk = loadSkia();
  const svg = useMemo(() => (sk === null ? null : sk.Skia.SVG.MakeFromString(portraitSvg(portrait))), [sk, portrait]);
  if (sk === null || svg === null) return <Avatar name={name} size={size} />;
  return (
    <View
      accessible
      accessibilityLabel={name}
      style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", backgroundColor: portrait.colors?.paper ?? PAPER }}
    >
      <sk.Canvas style={{ width: size, height: size }}>
        <sk.ImageSVG svg={svg} x={0} y={0} width={size} height={size} />
      </sk.Canvas>
    </View>
  );
}
