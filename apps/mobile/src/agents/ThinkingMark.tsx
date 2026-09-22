/**
 * The sign of life beside the activity label: a little ASCII pulse, a dot that swells into a
 * ring of parens and settles again, stepping through fixed-width frames in the code font so
 * nothing shifts. Terminal-flavoured on purpose: the thing on the other end is omp in a TTY.
 */
import { useEffect, useState } from "react";
import { Platform, Text as RNText } from "react-native";
import { colors, type as typeScale } from "@/theme";

const FRAME_MS = 110;
const mono = Platform.select({ ios: "Menlo", default: "monospace" });
/** Every frame is five columns wide; the beat spreads out from the middle and comes back. */
const FRAMES = [
  "  .  ",
  "  o  ",
  "  O  ",
  " (O) ",
  "((O))",
  "( O )",
  " (o) ",
  "  o  ",
  "  .  ",
  "     ",
  "     ",
] as const;

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
