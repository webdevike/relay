/**
 * The elaborate sign of life while the agent works: a ringed planet in living ASCII, its light
 * swinging round and its ring grain sliding, rendered a frame at a time in the code font.
 */
import { useEffect, useState } from "react";
import { Platform, Text as RNText, View } from "react-native";
import { colors } from "@/theme";
import { asciiPlanet } from "./asciiPlanet";

const FRAME_MS = 90;
const FONT_SIZE = 9;
const LINE_HEIGHT = 10;
const mono = Platform.select({ ios: "Menlo", default: "monospace" });

export function AsciiScene() {
  const [t, setT] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setT((Date.now() - started) / 1000);
    }, FRAME_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <View style={{ alignItems: "center" }}>
      <RNText style={{ fontFamily: mono, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, color: colors.accent }}>
        {asciiPlanet(t).join("\n")}
      </RNText>
    </View>
  );
}
