/**
 * A live canvas room (`/canvas?slug=&roomId=&board=&agent=&color=&avatar=&origin=`), pushed over
 * the chat whose Join card was tapped: the chat stays mounted underneath, so Back to chat finds
 * its scroll and draft as they were. The room is the host's web client (`canvas.access` URL with
 * `embed=phone`) in a web view; it draws the board, cursors, the agent's caret and the Comment
 * button, and handles the keyboard itself. The native header carries Back to chat, the board's
 * title and the agent with a live dot. When the session ends (the page says so, the host lists
 * the room ended, or there was no room to open) the screen says so and Back to chat leads out.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { SymbolView } from "expo-symbols";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { Avatar } from "@/ui/Avatar";
import { Banner } from "@/ui/Banner";
import { EmptyState } from "@/ui/EmptyState";
import { Text } from "@/ui/Text";
import { spacing, useColors, useScheme } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { openExternal } from "@/lib/links";
import { canvasEmbedUrl, parseEmbedEvent, staysInRoom } from "@/canvas/embed";
import { liveRoomOn, useCanvasStore } from "@/state/canvas";
import { useConnectionStore } from "@/state/connection";
import { hostBaseUrl, requestCanvasAccess } from "@/connection";

const HEADER_HEIGHT = 52;
const BACK_HEIGHT = 44;
const AVATAR = 30;
const DOT = 10;
const UNREACHABLE = "Can't reach the canvas. Check the connection to your Mac.";

export default function CanvasScreen() {
  const router = useRouter();
  const colors = useColors();
  const scheme = useScheme();
  const { slug, roomId, board, agent, color, avatar, origin } = useLocalSearchParams<{
    slug: string;
    roomId?: string;
    board?: string;
    agent?: string;
    color?: string;
    avatar?: string;
    /** The chat's href, for Back to chat when the stack has nothing under this screen (a deep link). */
    origin?: string;
  }>();
  const access = useCanvasStore((state) => state.access[slug]);
  // A deep link may name only the board: its live room stands in for the card's.
  const room = useCanvasStore((state) => (roomId === undefined ? liveRoomOn(state.rooms, slug) : state.rooms[roomId]));
  const connected = useConnectionStore((state) => state.status === "connected");
  // The URL this screen loaded, kept even after the store drops the token (the room ended).
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [pageEnded, setPageEnded] = useState(false);

  const agentName = agent ?? room?.agent.name ?? "Agent";
  const title = board ?? room?.board ?? slug;
  const avatarPath = avatar ?? room?.agent.avatar;
  const base = connected ? hostBaseUrl() : null;
  const avatarUri = base === null || avatarPath === undefined ? null : `${base}${avatarPath}`;
  const ended = pageEnded || room?.live === false || (url === null && access?.kind === "unavailable");

  // A deep link (or a reopened screen) arrives without the Join card having asked.
  useEffect(() => {
    if (useCanvasStore.getState().access[slug] === undefined) requestCanvasAccess(slug);
  }, [slug]);

  useEffect(() => {
    if (url === null && access?.kind === "ready") setUrl(canvasEmbedUrl(access.url, scheme));
  }, [access, url, scheme]);

  const back = (): void => {
    tapHaptic();
    if (router.canGoBack()) router.back();
    else router.replace((origin ?? "/") as Href);
  };

  const retry = useCallback((): void => {
    // A refused page means a dead token: drop it and ask for a fresh one.
    setFailure(null);
    setLoading(true);
    setUrl(null);
    useCanvasStore.getState().setAccess(slug, { kind: "asking" });
    requestCanvasAccess(slug);
  }, [slug]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent): void => {
      const embed = parseEmbedEvent(event.nativeEvent.data);
      if (embed?.slug !== slug) return;
      if (embed.type === "canvas.ready") setLoading(false);
      else setPageEnded(true);
    },
    [slug],
  );

  // The room's own page, its websocket and images stay inside; a link on the board opens outside the app.
  const onNavigate = useCallback(
    (request: ShouldStartLoadRequest): boolean => {
      // Frames inside the page (an embed on a board) load where they are.
      if (url === null || !request.isTopFrame || staysInRoom(request.url, url)) return true;
      openExternal(request.url);
      return false;
    },
    [url],
  );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={["top"]}>
      <View style={[styles.header, { borderBottomColor: colors.hairline }]}>
        <Pressable
          testID="canvas-back"
          accessibilityRole="button"
          accessibilityLabel="Back to chat"
          hitSlop={spacing.sm}
          onPress={back}
          style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}
        >
          <SymbolView name="chevron.left" size={20} weight="semibold" tintColor={colors.accent} />
          <Text variant="title" style={{ color: colors.accent, fontWeight: "400" }}>
            Back to chat
          </Text>
        </Pressable>
        <Text variant="title" numberOfLines={1} style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <View accessibilityLabel={`${agentName}, ${ended ? "ended" : "live"}`} style={styles.agent}>
          <Avatar name={agentName} uri={avatarUri} size={AVATAR} tint={color ?? room?.agent.color} />
          <View style={[styles.dot, { backgroundColor: ended ? colors.textFaint : colors.ok, borderColor: colors.bg }]} />
        </View>
      </View>

      <View style={styles.body}>
        {url !== null ? (
          <WebView
            source={{ uri: url }}
            style={[styles.web, { backgroundColor: colors.bg }]}
            javaScriptEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            keyboardDisplayRequiresUserAction={false}
            hideKeyboardAccessoryView
            bounces={false}
            overScrollMode="never"
            scrollEnabled={false}
            allowsBackForwardNavigationGestures={false}
            allowsLinkPreview={false}
            setSupportMultipleWindows={false}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            onShouldStartLoadWithRequest={onNavigate}
            onMessage={onMessage}
            onLoadEnd={() => {
              setLoading(false);
            }}
            onError={() => {
              setFailure(UNREACHABLE);
            }}
            onHttpError={(event) => {
              setFailure(`The canvas answered with HTTP ${String(event.nativeEvent.statusCode)}.`);
            }}
          />
        ) : ended ? (
          <EmptyState
            symbol="rectangle.3.group"
            title="This session has ended"
            body={access?.kind === "unavailable" ? access.reason : `${agentName} wrapped up on ${title}. The summary is in the chat.`}
            actionLabel="Back to chat"
            onAction={back}
          />
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={colors.textMuted} />
            <Text variant="body" color="textMuted">
              {connected ? `Joining ${agentName}…` : "Waiting for your Mac…"}
            </Text>
          </View>
        )}
        {url !== null && loading && failure === null && !ended && (
          <View pointerEvents="none" style={[styles.overlay, { backgroundColor: colors.bg }]}>
            <ActivityIndicator color={colors.textMuted} />
            <Text variant="body" color="textMuted">
              Loading the board…
            </Text>
          </View>
        )}
        {failure !== null && (
          <View style={styles.banner}>
            <Banner tone="danger" message={failure} actionLabel="Retry" onAction={retry} />
          </View>
        )}
        {url !== null && ended && failure === null && (
          <View style={styles.banner}>
            <Banner tone="info" icon="checkmark.circle" message="This session has ended" detail="The summary is in the chat." actionLabel="Back to chat" onAction={back} />
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { minHeight: BACK_HEIGHT, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.xs },
  title: { flex: 1, textAlign: "center" },
  agent: { width: AVATAR + spacing.sm, alignItems: "flex-end", marginRight: spacing.sm },
  dot: { position: "absolute", right: -2, bottom: -2, width: DOT, height: DOT, borderRadius: DOT / 2, borderWidth: 2 },
  body: { flex: 1 },
  web: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: spacing.md },
  banner: { position: "absolute", left: 0, right: 0, top: spacing.md },
});
