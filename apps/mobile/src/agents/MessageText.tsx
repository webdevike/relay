/** Transcript text: prose with inline code, fenced blocks as CodeBlock. */
import { Platform, Text as RNText, View } from "react-native";
import { colors, radii, spacing } from "@/theme";
import { Text } from "@/ui/Text";
import { CodeBlock } from "./CodeBlock";
import { splitFences, splitInline } from "./markdown";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

export interface MessageTextProps {
  text: string;
}

export function MessageText({ text }: MessageTextProps) {
  const segments = splitFences(text);
  return (
    <View style={{ gap: spacing.sm }}>
      {segments.map((segment, i) =>
        segment.kind === "code" ? (
          <CodeBlock key={i} code={segment.code} lang={segment.lang} />
        ) : (
          <Text key={i} variant="body">
            {splitInline(segment.text).map((run, j) =>
              run.code ? (
                <RNText key={j} style={{ fontFamily: mono, fontSize: 13, color: colors.text, backgroundColor: colors.surfaceRaised, borderRadius: radii.sm }}>
                  {run.text}
                </RNText>
              ) : (
                run.text
              ),
            )}
          </Text>
        ),
      )}
    </View>
  );
}
