/**
 * Live view: pick a window on the host, then watch it (~10 fps JPEGs over the relay socket). The
 * watch lives as long as this screen: leaving it, or going back to the list, stops the capture on
 * the host. Frames replace each other in `useScreenStore`, so nothing queues on the phone.
 */
import { useEffect, useState } from "react";
import { FlatList, Image, RefreshControl, StyleSheet, View } from "react-native";
import type { ScreenError, ScreenWindow } from "@relay/protocol";
import { Screen } from "@/ui/Screen";
import { IconButton } from "@/ui/IconButton";
import { Separator } from "@/ui/Separator";
import { EmptyState } from "@/ui/EmptyState";
import { Banner } from "@/ui/Banner";
import { Row } from "@/ui/Row";
import { Text } from "@/ui/Text";
import { spacing } from "@/theme";
import { useConnectionStore } from "@/state/connection";
import { useScreenStore } from "@/state/screen";
import { requestScreenWindows, stopScreenWatch, watchScreen } from "@/connection";

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
      <Screen title={watching.app} headerRight={<IconButton symbol="square.grid.2x2" onPress={back} />}>
        <LiveFrame window={watching} connected={connected} />
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

function LiveFrame({ window, connected }: { window: ScreenWindow; connected: boolean }) {
  const frame = useScreenStore((state) => state.frame);
  const ended = useScreenStore((state) => state.ended);
  const aspect = frame === null ? window.width / window.height : frame.width / frame.height;
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
      <View style={[styles.frame, { aspectRatio: aspect }]}>
        {frame === null ? (
          <Text variant="caption" color="textMuted">
            Waiting for the first frame…
          </Text>
        ) : (
          <Image source={{ uri: frame.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" fadeDuration={0} />
        )}
      </View>
      {window.title !== "" && (
        <Text variant="caption" color="textMuted" numberOfLines={1} style={styles.caption}>
          {window.title}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  padded: { paddingHorizontal: spacing.xl, paddingBottom: spacing.lg },
  live: { flex: 1 },
  frame: { width: "100%", maxHeight: "100%", alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  caption: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },
});
