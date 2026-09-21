/**
 * A fenced code block in the transcript: language label, copy, horizontal scroll, Prism
 * tokens rendered as nested Text (no WebView). Grammars beyond Prism's core are registered
 * here once; add to `extraGrammars` when the agents start emitting something else.
 */
import { useState } from "react";
import { Platform, Pressable, ScrollView, Text as RNText, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Highlight, Prism, themes } from "prism-react-renderer";
import "./prism-setup";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-diff";
import { copyText } from "@/lib/clipboard";
import { tapHaptic } from "@/lib/haptics";
import { colors, radii, spacing } from "@/theme";
import { Text } from "@/ui/Text";

/** Fence names the agents use that Prism knows under another id. */
const aliases: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rs: "rust",
  objc: "objectivec",
  html: "markup",
  xml: "markup",
  plist: "markup",
};

const theme = themes.vsDark;
const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const FONT_SIZE = 13;
const LINE_HEIGHT = 18;
/** How long the copy button reads as done before returning to the copy glyph. */
const COPIED_MS = 1200;

export interface CodeBlockProps {
  code: string;
  lang: string | null;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const language = lang === null ? "text" : (aliases[lang] ?? lang);
  const known = language in Prism.languages;
  const [copied, setCopied] = useState(false);

  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.hairline, overflow: "hidden" }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: spacing.md,
          paddingRight: spacing.xs,
          height: 32,
          borderBottomWidth: 1,
          borderBottomColor: colors.hairline,
        }}
      >
        <Text variant="caption" color="textMuted">
          {lang ?? "code"}
        </Text>
        <Pressable
          hitSlop={8}
          onPress={() => {
            tapHaptic();
            void copyText(code);
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, COPIED_MS);
          }}
          style={({ pressed }) => ({ width: 28, height: 28, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}
        >
          <SymbolView name={copied ? "checkmark" : "doc.on.doc"} size={14} tintColor={copied ? colors.ok : colors.textMuted} />
        </Pressable>
      </View>
      <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md }}>
        <Highlight code={code} language={known ? language : "text"} theme={theme}>
          {({ tokens, getTokenProps }) => (
            <RNText style={{ fontFamily: mono, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, color: colors.text }} selectable>
              {tokens.map((line, i) => (
                <RNText key={i}>
                  {line.map((token, j) => {
                    const { style, children } = getTokenProps({ token });
                    return (
                      <RNText
                        key={j}
                        style={{
                          color: typeof style?.color === "string" ? style.color : colors.text,
                          fontStyle: style?.fontStyle === "italic" ? "italic" : "normal",
                          fontWeight: style?.fontWeight === "bold" ? "700" : "400",
                        }}
                      >
                        {children}
                      </RNText>
                    );
                  })}
                </RNText>
              ))}
            </RNText>
          )}
        </Highlight>
      </ScrollView>
    </View>
  );
}
