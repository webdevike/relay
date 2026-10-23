/**
 * A VNC screen: noVNC in a web view (the bundled page in `vnc/viewerHtml.ts`, no network fetch),
 * connected to `url` and scaled to fit. Touch is noVNC's (tap clicks, two-finger drag scrolls,
 * long press right-clicks) plus a local pinch zoom; while zoomed, one finger pans. Each new `url`
 * (a fresh single-use ticket) opens a new connection; `ref.send` types into it. The page loads with
 * a `file://` base so it is a secure context (noVNC needs Web Crypto for Apple's auth) that may
 * still open `ws://` to the host.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { StyleSheet } from "react-native";
import { Paths } from "expo-file-system";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { parseVncEvent, vncCommandScript, type VncCommand, type VncCredentials, type VncEvent } from "@/vnc/messages";
import { VIEWER_HTML } from "@/vnc/viewerHtml";

export interface VncViewHandle {
  /** Delivered once the page is ready; earlier commands wait for it. */
  send: (command: VncCommand) => void;
}

export interface VncViewProps {
  /** The bridge URL with a fresh ticket; null keeps the view idle. */
  url: string | null;
  /** Offered up front when known; noVNC asks through `onEvent` otherwise. */
  credentials: VncCredentials | null;
  onEvent: (event: VncEvent) => void;
  ref?: Ref<VncViewHandle>;
}

const SOURCE = { html: VIEWER_HTML, baseUrl: Paths.bundle.uri };
const ORIGINS = ["*"];

export function VncView({ url, credentials, onEvent, ref }: VncViewProps) {
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const queued = useRef<VncCommand[]>([]);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;

  const send = (command: VncCommand): void => {
    if (ready.current) web.current?.injectJavaScript(vncCommandScript(command));
    else queued.current.push(command);
  };
  useImperativeHandle(ref, () => ({ send }));

  // Credentials only matter at connect time: a new value alone must not reconnect.
  useEffect(() => {
    if (url !== null) send({ type: "connect", url, credentials: credentialsRef.current });
  }, [url]);

  const onMessage = (message: WebViewMessageEvent): void => {
    const event = parseVncEvent(message.nativeEvent.data);
    if (event === null) return;
    if (event.type === "ready") {
      ready.current = true;
      for (const command of queued.current.splice(0)) web.current?.injectJavaScript(vncCommandScript(command));
    }
    onEventRef.current(event);
  };

  return (
    <WebView
      ref={web}
      source={SOURCE}
      originWhitelist={ORIGINS}
      style={styles.web}
      javaScriptEnabled
      scrollEnabled={false}
      bounces={false}
      allowsLinkPreview={false}
      allowsBackForwardNavigationGestures={false}
      keyboardDisplayRequiresUserAction={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onMessage={onMessage}
      onContentProcessDidTerminate={() => {
        // WebKit dropped the page (memory pressure): reload, and say the connection is gone.
        ready.current = false;
        web.current?.reload();
        onEventRef.current({ type: "disconnected", clean: false });
      }}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "#000000" },
});
