/**
 * Base element for agent-made UI: a page in a sandboxed web view that reads as part of the chat.
 * It is transparent, sized to its content (no inner scroll until `maxHeight`), unzoomable and
 * without link previews or callouts; drags on it scroll the chat around it. The page gets the app's
 * palette as CSS variables plus `window.relay` (`@relay/widget-runtime/frame`, shared with the
 * desktop). `runtime` "html" shows the code as an HTML fragment; "mantine" runs it as JSX in the
 * bundled Mantine runtime with the shared theme. Nothing loads from the network, and the page cannot
 * navigate: a tapped web link opens through `onOpenLink` instead. `code` null (still streaming)
 * shows the same spinner frame as a page that hasn't laid out yet.
 */
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { htmlFrameDocument, mantineFrameDocument, parseFrameMessage, type FrameTheme } from "@relay/widget-runtime/frame";
import { radii, useColors, useScheme } from "@/theme";

export interface HtmlFrameProps {
  /** The agent's HTML fragment or Mantine JSX; null while it is still being written. */
  code: string | null;
  /** How the page runs `code`. */
  runtime?: "html" | "mantine";
  /** Body text size of the surrounding transcript, so the page matches it. */
  fontSize: number;
  lineHeight: number;
  /** `relay.reply(text)` from a tap in the page; null leaves it doing nothing. */
  onReply: ((text: string) => void) | null;
  /** A tapped http(s) or mailto link. */
  onOpenLink: (url: string) => void;
  /** Taller content scrolls inside the frame from here. */
  maxHeight?: number;
}

/** Height of the loading frame before the page reports its own. */
const PLACEHOLDER_HEIGHT = 120;
const MAX_HEIGHT = 1200;
/**
 * Every URL reaches `onShouldStartLoadWithRequest`: with a narrower whitelist, react-native-webview
 * hands any other URL straight to `Linking.openURL`, even one the page's script navigates to on load.
 */
const ORIGINS = ["*"];
const SYSTEM_FONT = "-apple-system, system-ui, sans-serif";
const MONO_FONT = "ui-monospace, Menlo, monospace";

export function HtmlFrame({ code, runtime = "html", fontSize, lineHeight, onReply, onOpenLink, maxHeight = MAX_HEIGHT }: HtmlFrameProps) {
  const colors = useColors();
  const scheme = useScheme();
  const web = useRef<WebView>(null);
  const [measured, setMeasured] = useState<{ code: string; height: number } | null>(null);
  const height = measured !== null && measured.code === code ? measured.height : null;

  const source = useMemo(() => {
    if (code === null) return null;
    const theme: FrameTheme = {
      dark: scheme === "dark",
      colors: {
        fg: colors.text,
        muted: colors.textMuted,
        faint: colors.textFaint,
        border: colors.hairline,
        surface: colors.surface,
        raised: colors.surfaceRaised,
        accent: colors.accent,
        ok: colors.ok,
        warn: colors.warn,
        danger: colors.danger,
        bg: "transparent",
      },
      font: { family: SYSTEM_FONT, mono: MONO_FONT, size: fontSize, lineHeight },
      radius: { sm: radii.sm, md: radii.md, lg: radii.lg },
    };
    return { html: runtime === "mantine" ? mantineFrameDocument(code, theme) : htmlFrameDocument(code, theme) };
  }, [code, runtime, colors, scheme, fontSize, lineHeight]);

  const onMessage = (event: WebViewMessageEvent): void => {
    const message = parseFrameMessage(event.nativeEvent.data);
    if (message === null || code === null) return;
    if (message.type === "height") setMeasured({ code, height: message.height });
    else onReply?.(message.text);
  };

  const onShouldStartLoad = (request: ShouldStartLoadRequest): boolean => {
    if (request.url.startsWith("about:")) return true;
    if (request.navigationType === "click" && /^(https?|mailto):/i.test(request.url)) onOpenLink(request.url);
    return false;
  };

  const shown = height === null ? PLACEHOLDER_HEIGHT : Math.min(Math.max(height, 1), maxHeight);
  return (
    <View style={{ height: shown }}>
      {source !== null ? (
        <WebView
          ref={web}
          source={source}
          originWhitelist={ORIGINS}
          onShouldStartLoadWithRequest={onShouldStartLoad}
          onMessage={onMessage}
          style={[styles.web, { opacity: height === null ? 0 : 1 }]}
          containerStyle={styles.web}
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically={false}
          scrollEnabled={height !== null && height > maxHeight}
          bounces={false}
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          allowsLinkPreview={false}
          allowsBackForwardNavigationGestures={false}
          allowsInlineMediaPlayback
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          dataDetectorTypes="none"
          incognito
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          onContentProcessDidTerminate={() => {
            // WebKit dropped the page (memory pressure): load it again.
            web.current?.reload();
          }}
        />
      ) : null}
      {height === null ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.loading, { borderRadius: radii.md, backgroundColor: colors.surface }]}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
  loading: { alignItems: "center", justifyContent: "center" },
});
