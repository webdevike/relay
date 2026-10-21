/**
 * Eva's computer: a full-screen view of Eva's contained browser (the Selkies web screen, see
 * `src/eva/computer.ts`), after Dot's. Top row: close, the "Eva's computer" chip, reload. The
 * screen sits between on black; the web view stays mounted for as long as the route is open, so
 * zoom and the session survive the keyboard coming and going. Pinch zooms the view (native web
 * view zoom, unlocked by `ALLOW_PINCH_ZOOM_JS`); taps and typing reach the remote browser through
 * the page itself. Bottom row: history arrows (not wired yet, shown at 40%) and keyboard + reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Banner } from "@/ui/Banner";
import { ChromePill } from "@/ui/ChromePill";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { Toast } from "@/ui/Toast";
import { spacing } from "@/theme";
import { BLUR_KEYBOARD_JS, ALLOW_PINCH_ZOOM_JS, EVA_COMPUTER_URL, FOCUS_KEYBOARD_JS, KEYBOARD_NONE } from "@/eva/computer";
import { useTransientMessage } from "@/lib/useTransientMessage";

const BUTTON = 44;
const OFF_TAILNET = "Can't reach Eva's computer. Check that this phone is on the tailnet.";
const HISTORY_LABEL = "Browser history, coming soon";
const TAP_FIRST = "Tap the screen first";
const GLASS_BUTTON = "transparent";

export default function EvaComputer() {
  const router = useRouter();
  const web = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const toast = useTransientMessage();
  const showToast = toast.show;

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboardUp(true);
    });
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardUp(false);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const close = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const reload = useCallback((): void => {
    setFailure(null);
    setLoading(true);
    web.current?.reload();
  }, []);
  const toggleKeyboard = (): void => {
    web.current?.injectJavaScript(keyboardUp ? BLUR_KEYBOARD_JS : FOCUS_KEYBOARD_JS);
  };
  const onMessage = useCallback(
    (event: WebViewMessageEvent): void => {
      if (event.nativeEvent.data === KEYBOARD_NONE) showToast(TAP_FIRST);
    },
    [showToast],
  );

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.bar}>
        <IconButton symbol="xmark" tone="overlay" size={BUTTON} onPress={close} accessibilityLabel="Close" />
        <View style={styles.title}>
          <ChromePill symbol="laptopcomputer" label="Eva's computer" />
        </View>
        <IconButton symbol="arrow.clockwise" tone="overlay" size={BUTTON} onPress={reload} accessibilityLabel="Reload" />
      </View>

      <View style={styles.screen}>
        <WebView
          ref={web}
          source={{ uri: EVA_COMPUTER_URL }}
          style={styles.web}
          allowsBackForwardNavigationGestures={false}
          scalesPageToFit
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          keyboardDisplayRequiresUserAction={false}
          javaScriptEnabled
          sharedCookiesEnabled
          allowsLinkPreview={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          injectedJavaScript={ALLOW_PINCH_ZOOM_JS}
          onMessage={onMessage}
          onLoadStart={() => {
            setLoading(true);
          }}
          onLoadEnd={() => {
            setLoading(false);
          }}
          onError={() => {
            setFailure(OFF_TAILNET);
          }}
          onHttpError={(event) => {
            setFailure(`Eva's computer answered with HTTP ${String(event.nativeEvent.statusCode)}.`);
          }}
        />
        {loading && failure === null && (
          <View pointerEvents="none" style={styles.overlayCenter}>
            <Text variant="body" color="textMuted">
              Loading Eva's computer…
            </Text>
          </View>
        )}
        {failure !== null && (
          <View style={styles.overlayCenter}>
            <Banner tone="danger" message={failure} actionLabel="Retry" onAction={reload} />
          </View>
        )}
        {toast.message !== null && (
          <View pointerEvents="none" style={styles.toast}>
            <Toast message={toast.message} />
          </View>
        )}
      </View>

      <View style={styles.bar}>
        <ChromePill>
          <IconButton symbol="chevron.left" tone="overlay" size={BUTTON} backgroundColor={GLASS_BUTTON} disabled onPress={noop} accessibilityLabel={HISTORY_LABEL} />
          <IconButton symbol="chevron.right" tone="overlay" size={BUTTON} backgroundColor={GLASS_BUTTON} disabled onPress={noop} accessibilityLabel={HISTORY_LABEL} />
        </ChromePill>
        <ChromePill>
          <IconButton symbol="keyboard" tone="overlay" size={BUTTON} backgroundColor={GLASS_BUTTON} onPress={toggleKeyboard} accessibilityLabel={keyboardUp ? "Hide keyboard" : "Show keyboard"} />
          <IconButton symbol="arrow.clockwise" tone="overlay" size={BUTTON} backgroundColor={GLASS_BUTTON} onPress={reload} accessibilityLabel="Reload" />
        </ChromePill>
      </View>
    </SafeAreaView>
  );
}

function noop(): void {
  // The history buttons are disabled; Pressable never calls this.
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  title: { flex: 1, alignItems: "center", paddingHorizontal: spacing.sm },
  screen: { flex: 1, backgroundColor: "#000000" },
  web: { flex: 1, backgroundColor: "#000000" },
  overlayCenter: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  toast: { position: "absolute", left: 0, right: 0, bottom: spacing.lg },
});
