/**
 * A fenced code block in the transcript: language label, copy, horizontal scroll, Prism
 * tokens rendered as nested Text (no WebView). Grammars beyond Prism's core are registered
 * here once; add to `extraGrammars` when the agents start emitting something else.
 */
import { memo, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, ScrollView, Text as RNText, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Highlight, Prism, themes } from "prism-react-renderer";
import "./prism-setup";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-diff";
import { copyText } from "@/lib/clipboard";
import { tapHaptic } from "@/lib/haptics";
import { radii, spacing, useColors, useScheme } from "@/theme";
import { Text } from "@/ui/Text";

/** Fence names and file extensions the agents use that Prism knows under another id. */
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

/** A fence name or file extension to a loaded Prism grammar id; "text" when none is loaded. */
export function prismLanguage(name: string | null): string {
  const language = name === null ? "text" : (aliases[name] ?? name);
  return language in Prism.languages ? language : "text";
}

/** Prism themes per scheme, so syntax hues keep contrast on either surface. */
export const codeThemes = { dark: themes.vsDark, light: themes.vsLight } as const;
const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const FONT_SIZE = 14;
const LINE_HEIGHT = 21;
/** How long the copy button reads as done before returning to the copy glyph. */
const COPIED_MS = 1800;

export interface CodeBlockProps {
  code: string;
  lang: string | null;
  /** A closed ```ui or ```openui block that failed validation: the header says so instead of passing as code. */
  invalid?: boolean;
}

type CopyState = "idle" | "copying" | "copied" | "error";

export function CodeBlock({ code, lang, invalid = false }: CodeBlockProps) {
  const colors = useColors();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const cancelReset = useRef<(() => void) | null>(null);
  const request = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    setCopyState("idle");
    pending.current = false;
    return () => {
      request.current += 1;
      cancelReset.current?.();
    };
  }, [code]);

  const copy = async () => {
    if (pending.current) return;
    pending.current = true;
    const id = ++request.current;
    cancelReset.current?.();
    setCopyState("copying");
    try {
      await copyText(code);
      if (request.current !== id) return;
      setCopyState("copied");
      AccessibilityInfo.announceForAccessibility("Code copied");
      tapHaptic();
      const timer = setTimeout(() => { setCopyState("idle"); }, COPIED_MS);
      cancelReset.current = () => { clearTimeout(timer); };
    } catch {
      if (request.current === id) {
        setCopyState("error");
        AccessibilityInfo.announceForAccessibility("Couldn’t copy code. Try again.");
      }
    } finally {
      if (request.current === id) pending.current = false;
    }
  };
  const copyLabel = copyState === "copying" ? "Copying…" : copyState === "copied" ? "Copied" : copyState === "error" ? "Retry" : "Copy";

  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.hairline, overflow: "hidden" }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: spacing.md,
          paddingRight: spacing.xs,
          minHeight: 44,
          borderBottomWidth: 1,
          borderBottomColor: colors.hairline,
        }}
      >
        <Text variant="caption" color={invalid ? "warn" : "textMuted"} numberOfLines={1} style={{ flex: 1, marginRight: spacing.sm }}>
          {invalid ? "Widget couldn't render" : (lang ?? "code")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copyState === "error" ? "Copy failed. Retry copying code" : `${copyLabel} code`}
          accessibilityHint="Copies the entire code block to the clipboard"
          accessibilityState={{ disabled: copyState === "copying", busy: copyState === "copying" }}
          accessibilityLiveRegion="polite"
          disabled={copyState === "copying"}
          onPress={() => { void copy(); }}
          style={({ pressed }) => ({
            minWidth: 76,
            minHeight: 44,
            paddingHorizontal: spacing.sm,
            flexDirection: "row",
            gap: spacing.xs,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed || copyState === "copying" ? 0.6 : 1,
          })}
        >
          <SymbolView name={copyState === "copied" ? "checkmark" : copyState === "error" ? "arrow.clockwise" : "doc.on.doc"} size={14} tintColor={copyState === "error" ? colors.danger : colors.textMuted} />
          <Text variant="caption" color={copyState === "error" ? "danger" : "textMuted"}>{copyLabel}</Text>
        </Pressable>
      </View>
      {copyState === "error" ? (
        <Text variant="caption" color="danger" accessibilityRole="alert" style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm }}>
          Couldn’t copy code. Try again.
        </Text>
      ) : null}
      {/* flexGrow 0: ScrollView's default grow inflates a shrink-to-fit parent (a user bubble) to thousands of points. */}
      <ScrollView horizontal style={{ flexGrow: 0 }} bounces={false} showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md }}>
        <CodeContent code={code} lang={lang} />
      </ScrollView>
    </View>
  );
}

/** Copy feedback must not tokenize an unchanged block again. */
const CodeContent = memo(function CodeContent({ code, lang }: Pick<CodeBlockProps, "code" | "lang">) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <Highlight code={code} language={prismLanguage(lang)} theme={codeThemes[scheme]}>
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
                    {token.empty ? "" : children}
                  </RNText>
                );
              })}
              {i < tokens.length - 1 ? "\n" : null}
            </RNText>
          ))}
        </RNText>
      )}
    </Highlight>
  );
});
