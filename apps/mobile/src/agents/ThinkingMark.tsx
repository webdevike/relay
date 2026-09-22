/**
 * The sign of life beside the activity label: a single glyph blooming from a dot into a star
 * and back, the way Claude Code's spinner does, in the code font so nothing shifts.
 */
import { useEffect, useState } from "react";
import { Platform, Text as RNText } from "react-native";
import { colors, type as typeScale } from "@/theme";

const FRAME_MS = 120;
const mono = Platform.select({ ios: "Menlo", default: "monospace" });
/** Out and back: dot, sparks, star, and down again; every glyph is one column wide. */
const BLOOM = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
const FRAMES = [...BLOOM, ...[...BLOOM].reverse().slice(1, -1)] as const;

export function ThinkingMark() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, FRAME_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <RNText
      style={{
        fontFamily: mono,
        fontSize: typeScale.caption.fontSize,
        lineHeight: typeScale.caption.lineHeight,
        color: colors.accent,
      }}
    >
      {FRAMES[frame]}
    </RNText>
  );
}
