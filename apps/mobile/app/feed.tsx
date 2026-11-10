/**
 * Feed (`/feed`): Isaac's discovery feed, a vertical scroll of cards (tools, designs, process videos)
 * that `work/discovery-feed/fetch.ts` ranks in the Eva hub, the same list as Relay Desktop's Feed page.
 * Like, save and skip go to the host, which appends them to the feed's `signals.jsonl` for the next
 * ranking; a skipped card disappears. The chips filter by interest. Thumbnails of sources blocked on
 * the phone (X, Behance, twimg) are cached by the host's container and load from the host itself.
 * The host owns the cards (`useFeedStore`); the screen asks again on focus and on pull-to-refresh.
 */
import { useCallback, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import type { FeedAction, FeedItem } from "@relay/protocol";
import { FeedPost } from "@/feed/FeedPost";
import { hostBaseUrl, requestFeed, signalFeed } from "@/connection";
import { feedSources, feedTags, visibleFeed } from "@/lib/feed";
import { openExternal } from "@/lib/links";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { useConnectionStore } from "@/state/connection";
import { useFeedStore } from "@/state/feed";
import { Chip } from "@/ui/Chip";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";
import { Toast } from "@/ui/Toast";
import { spacing, useColors } from "@/theme";

export default function Feed() {
  const colors = useColors();
  const router = useRouter();
  const items = useFeedStore((state) => state.items);
  const acted = useFeedStore((state) => state.acted);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [tag, setTag] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useTransientMessage();
  const showToast = toast.show;

  useFocusEffect(
    useCallback(() => {
      requestFeed();
    }, []),
  );

  const tags = items === null ? [] : feedTags(items, acted);
  const sources = items === null ? [] : feedSources(items, acted);
  // A tag or platform whose cards were all skipped is no longer a chip: fall back to everything.
  const activeTag = tag !== null && tags.includes(tag) ? tag : null;
  const activeSource = source !== null && sources.includes(source) ? source : null;
  const cards = items === null ? [] : visibleFeed(items, acted, activeTag, activeSource);
  const hostBase = connected ? hostBaseUrl() : null;

  const onAct = useCallback(
    (item: FeedItem, action: FeedAction) => {
      if (!signalFeed(item, action)) showToast("Not connected");
    },
    [showToast],
  );
  const onOpen = useCallback((item: FeedItem) => {
    openExternal(item.url);
  }, []);

  const refresh = () => {
    setRefreshing(true);
    requestFeed();
    // The answer arrives as a frame with no request id; a short spinner is the acknowledgement.
    setTimeout(() => {
      setRefreshing(false);
    }, 800);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          symbol="chevron.left"
          accessibilityLabel="Back"
          backgroundColor="transparent"
          onPress={() => {
            router.back();
          }}
        />
        <Text variant="title">Feed</Text>
      </View>
      {sources.length > 1 && (
        <View style={styles.chipsWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityLabel="Filter by platform">
            {[null, ...sources].map((s) => (
              <Chip
                key={s ?? "all"}
                label={s ?? "All platforms"}
                selected={activeSource === s}
                onPress={() => {
                  setSource(s);
                }}
              />
            ))}
          </ScrollView>
        </View>
      )}
      {tags.length > 0 && (
        <View style={styles.chipsWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityLabel="Filter by interest">
            {[null, ...tags].map((t) => (
              <Chip
                key={t ?? "all"}
                label={t ?? "All"}
                selected={activeTag === t}
                onPress={() => {
                  setTag(t);
                }}
              />
            ))}
          </ScrollView>
        </View>
      )}
      {cards.length === 0 ? (
        <EmptyState
          symbol={items === null ? "square.stack" : "checkmark.circle"}
          title={items === null ? (connected ? "Loading…" : "Not connected") : "Nothing here"}
          body={
            items === null
              ? connected
                ? "Asking your Mac for the feed."
                : "The feed comes from your Mac; connect to it to see it."
              : "Run the fetch on your Mac for fresh cards."
          }
        />
      ) : (
        <FlatList
          data={cards}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <FeedPost item={item} action={acted[item.id]} hostBase={hostBase} onAct={onAct} onOpen={onOpen} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          initialNumToRender={4}
          windowSize={7}
          contentContainerStyle={styles.list}
        />
      )}
      {toast.message !== null && (
        <View style={styles.toast} pointerEvents="none">
          <Toast message={toast.message} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  chipsWrap: { paddingBottom: spacing.sm },
  chips: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  list: { paddingBottom: spacing.xxxl },
  toast: { position: "absolute", left: 0, right: 0, bottom: spacing.xxxl },
});
