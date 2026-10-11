/**
 * Live view: pick a window on the host, then watch it (~10 fps JPEGs over the relay socket) and
 * drive it: a tap clicks there, a two-finger drag scrolls, the keyboard button types into it. The
 * watch lives as long as this screen: leaving it, or going back to the list, stops the capture on
 * the host. Frames replace each other in `useScreenStore`, so nothing queues on the phone.
 */
import { useEffect, useRef, useState } from "react";
import { FlatList, Image, RefreshControl, StyleSheet, TextInput, View, type LayoutRectangle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SymbolView } from "expo-symbols";
import type { InputEvent, ScreenError, ScreenWindow } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { IconButton } from "@/ui/IconButton";
import { Separator } from "@/ui/Separator";
import { EmptyState } from "@/ui/EmptyState";
import { Banner } from "@/ui/Banner";
import { Row } from "@/ui/Row";
import { Text } from "@/ui/Text";
import { spacing } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { useConnectionStore } from "@/state/connection";
import { useScreenStore } from "@/state/screen";
import { requestScreenWindows, sendScreenClick, sendScreenKey, sendScreenMove, sendScreenScroll, sendScreenTap, stopScreenWatch, watchScreen } from "@/connection";
import { TrackpadSurface } from "@/trackpad/TrackpadSurface";

/**
 * Trackpad events from the shared gesture model, as live-view commands. TrackpadSurface already
 * flushes once per animation frame, so each batch's moves go out as one summed relative move;
 * drag holds are not supported here and fall back to plain moves.
 */
function sendTrackpad(events: InputEvent[]): void {
  let dx = 0;
  let dy = 0;
  let at: number | null = null;
  const flushMove = (): void => {
    if (at !== null && (dx !== 0 || dy !== 0)) sendScreenMove(dx, dy, at);
    dx = 0;
    dy = 0;
    at = null;
  };
  for (const event of events) {
    if (event.k === "move") {
      dx += event.dx;
      dy += event.dy;
      at = event.t;
      continue;
    }
    flushMove();
    if (event.k === "click") sendScreenClick(event.button);
    else if (event.k === "scroll" && (event.dx !== 0 || event.dy !== 0)) sendScreenScroll(event.dx, event.dy);
  }
  flushMove();
}

const ERROR_TEXT: Record<ScreenError, string> = {
  denied: "The host needs Screen Recording permission: System Settings > Privacy & Security > Screen & System Audio Recording > Relay Host.",
  gone: "That window closed.",
  unavailable: "This host can't share its screen.",
  failed: "Capture stopped on the host.",
};

export default function LiveView() {
  const connected = useConnectionStore((state) => state.status === "connected");
  const windows = useScreenStore((state) => state.windows);
  const listError = useScreenStore((state) => state.listError);
  const [watching, setWatching] = useState<ScreenWindow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const keyboard = useRef<TextInput>(null);

  useEffect(() => {
    if (connected) requestScreenWindows();
  }, [connected]);
  useEffect(() => {
    if (windows !== null || listError !== null) setRefreshing(false);
  }, [windows, listError]);
  // Leaving the screen stops the host capture.
  useEffect(() => stopScreenWatch, []);

  const watch = (window: ScreenWindow): void => {
    setWatching(window);
    watchScreen(window.id);
  };
  const back = (): void => {
    keyboard.current?.blur();
    stopScreenWatch();
    setWatching(null);
    requestScreenWindows();
  };
  const refresh = (): void => {
    setRefreshing(true);
    requestScreenWindows();
  };

  if (watching !== null) {
    return (
      <Screen
        title={watching.app}
        headerRight={
          <View style={styles.actions}>
            <IconButton
              symbol="keyboard"
              onPress={() => {
                if (keyboard.current?.isFocused() === true) keyboard.current.blur();
                else keyboard.current?.focus();
              }}
            />
            <IconButton symbol="square.grid.2x2" onPress={back} />
          </View>
        }
      >
        <View style={styles.live}>
          <LiveFrame window={watching} connected={connected} />
        </View>
        <View style={styles.trackpad}>
          <TrackpadSurface wheel={[]} onWheel={() => undefined} send={sendTrackpad} />
        </View>
        <HiddenKeyboard inputRef={keyboard} />
      </Screen>
    );
  }

  return (
    <Screen title="Live view" headerRight={<IconButton symbol="arrow.clockwise" onPress={refresh} disabled={!connected} />}>
      {!connected ? (
        <EmptyState symbol="wifi.slash" title="Not connected" body="Live view needs a connection to your host." />
      ) : listError !== null ? (
        <View style={styles.padded}>
          <Banner tone="danger" message={ERROR_TEXT[listError]} actionLabel="Retry" onAction={refresh} />
        </View>
      ) : windows === null ? (
        <EmptyState symbol="macwindow" title="Looking for windows" body="Asking the host what's on screen." />
      ) : windows.length === 0 ? (
        <EmptyState symbol="macwindow" title="No windows" body="Nothing on the host's screen can be shared right now." actionLabel="Refresh" onAction={refresh} />
      ) : (
        <FlatList
          data={windows}
          keyExtractor={(window) => String(window.id)}
          ItemSeparatorComponent={Separator}
          ListHeaderComponent={Separator}
          ListFooterComponent={Separator}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          renderItem={({ item }) => (
            <Row
              title={item.app}
              subtitle={item.title === "" ? `${Math.round(item.width)} x ${Math.round(item.height)}` : item.title}
              onPress={() => {
                watch(item);
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}

/**
 * The frame fills the width at the window's aspect. Touches map to 0..1 over the image itself
 * (letterboxing from `contain` excluded), so a tap lands on the same spot of the host window.
 */
function LiveFrame({ window, connected }: { window: ScreenWindow; connected: boolean }) {
  const frame = useScreenStore((state) => state.frame);
  const ended = useScreenStore((state) => state.ended);
  const cursor = useScreenStore((state) => state.cursor);
  const [box, setBox] = useState<LayoutRectangle | null>(null);
  const aspect = frame === null ? window.width / window.height : frame.width / frame.height;

  // The drawn image inside `box` under resizeMode="contain".
  const image = (() => {
    if (box === null) return null;
    const width = Math.min(box.width, box.height * aspect);
    const height = width / aspect;
    return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
  })();
  const normalized = (x: number, y: number): { x: number; y: number } | null => {
    if (image === null) return null;
    const nx = (x - image.left) / image.width;
    const ny = (y - image.top) / image.height;
    return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { x: nx, y: ny };
  };

  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((event, success) => {
      const point = success ? normalized(event.x, event.y) : null;
      if (point === null) return;
      tapHaptic();
      sendScreenTap(point.x, point.y);
    });
  const scroll = Gesture.Pan()
    .runOnJS(true)
    .minPointers(2)
    .onChange((event) => {
      const point = normalized(event.x, event.y) ?? { x: 0.5, y: 0.5 };
      // Phone points to host window points, so a drag moves the content as far as the fingers did.
      const scale = image === null ? 1 : window.width / image.width;
      sendScreenScroll(event.changeX * scale, event.changeY * scale, point);
    });

  return (
    <View style={styles.live}>
      {ended !== null && (
        <View style={styles.padded}>
          <Banner tone={ended === "gone" ? "warn" : "danger"} message={ERROR_TEXT[ended]} />
        </View>
      )}
      {!connected && (
        <View style={styles.padded}>
          <Banner tone="warn" message="Reconnecting to the host…" />
        </View>
      )}
      <GestureDetector gesture={Gesture.Exclusive(scroll, tap)}>
        <View
          style={[styles.frame, { aspectRatio: aspect }]}
          onLayout={(event) => {
            setBox(event.nativeEvent.layout);
          }}
        >
          {frame === null ? (
            <Text variant="caption" color="textMuted">
              Waiting for the first frame…
            </Text>
          ) : (
            <Image source={{ uri: frame.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" fadeDuration={0} />
          )}
          {cursor !== null && image !== null && cursor.x >= 0 && cursor.x <= 1 && cursor.y >= 0 && cursor.y <= 1 && (
            // Frames are captured without the cursor; this one moves as soon as the host reports it.
            <View pointerEvents="none" style={[styles.cursor, { left: image.left + cursor.x * image.width, top: image.top + cursor.y * image.height }]}>
              <SymbolView name="cursorarrow" size={18} tintColor="#FFFFFF" />
            </View>
          )}
        </View>
      </GestureDetector>
      {window.title !== "" && (
        <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.caption}>
          {window.title}
        </Text>
      )}
    </View>
  );
}

/**
 * Off-screen field that only exists to raise the iOS keyboard. Every change is sent and the field
 * cleared, so it never holds text; backspace and return are forwarded as keys.
 */
function HiddenKeyboard({ inputRef }: { inputRef: React.RefObject<TextInput | null> }) {
  return (
    <TextInput
      ref={inputRef}
      style={styles.hidden}
      value=""
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      submitBehavior="submit"
      onChangeText={(text) => {
        if (text !== "") sendScreenKey({ text });
      }}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Backspace") sendScreenKey({ key: "delete" });
      }}
      onSubmitEditing={() => {
        sendScreenKey({ key: "return" });
      }}
    />
  );
}

const styles = StyleSheet.create({
  padded: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg },
  actions: { flexDirection: "row", gap: spacing.sm },
  live: { flex: 1 },
  /** Frame above, trackpad below at ~35% of the screen. */
  trackpad: { flex: 0.54 },
  frame: { width: "100%", maxHeight: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  caption: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, left: -100 },
  /** The arrow's tip sits at the symbol's top-left, a few points in from the box corner. */
  cursor: { position: "absolute", marginLeft: -4, marginTop: -2, shadowColor: "#000", shadowOpacity: 0.6, shadowRadius: 1.5, shadowOffset: { width: 0, height: 0 } },
});
