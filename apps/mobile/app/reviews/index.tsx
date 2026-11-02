/**
 * Reviews (`/reviews`): what waits on Isaac's reply from GitHub, Linear and Slack, newest first in
 * Today and Earlier, filtered by source. Swipe a row left for Done; pull to read every source again
 * (Slack's read takes minutes, so it is said quietly under the list until it lands).
 * `relay://reviews?item=<encoded item url>` opens that item's screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { isReviewUnread, liveReviewItems, reviewDayGroups, type ReviewItem, type ReviewQueue, type ReviewSource } from "@relay/protocol";
import { reviewsRequest } from "@/connection";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { markReviewDone, openReviewItem } from "@/reviews/actions";
import { ItemHeader } from "@/reviews/ItemHeader";
import { reviewItemRoute, reviewMatches, reviewOpenRow } from "@/reviews/model";
import { SourceMark } from "@/reviews/SourceGlyph";
import { QueueRow } from "@/reviews/QueueRow";
import { useConnectionStore } from "@/state/connection";
import { useReviewsStore } from "@/state/reviews";
import { spacing, useColors, useScheme } from "@/theme";
import { EmptyState } from "@/ui/EmptyState";
import { Screen } from "@/ui/Screen";
import { SegmentedTabs } from "@/ui/SegmentedTabs";
import { Text } from "@/ui/Text";
import { Toast } from "@/ui/Toast";

type Filter = "all" | ReviewSource;

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "github", label: "GitHub" },
  { key: "linear", label: "Linear" },
  { key: "slack", label: "Slack" },
];

const SOURCE_NAME: Record<ReviewSource, string> = { github: "GitHub", linear: "Linear", slack: "Slack" };

/** Ages move by the minute. */
const TICK_MS = 30_000;

/** `Reading Slack…` while a source reads, its error after a failed read; nothing when all is well. */
function sourceNotes(queue: ReviewQueue, filter: Filter): string[] {
  const sources = (Object.keys(SOURCE_NAME) as ReviewSource[]).filter((source) => filter === "all" || filter === source);
  return sources.flatMap((source) => {
    const state = queue.sources[source];
    if (state.loading) return [`Reading ${SOURCE_NAME[source]}…`];
    if (state.error !== null) return [`${SOURCE_NAME[source]}: ${state.error}`];
    return [];
  });
}

export default function Reviews() {
  const colors = useColors();
  const scheme = useScheme();
  const router = useRouter();
  const queue = useReviewsStore((state) => state.queue);
  const connected = useConnectionStore((state) => state.status === "connected");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [pulled, setPulled] = useState(false);
  const toast = useTransientMessage();

  useFocusEffect(
    useCallback(() => {
      void reviewsRequest({ kind: "queue", refresh: false });
      setNow(Date.now());
    }, []),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // `relay://reviews?item=<url>` opens that item's own screen over the queue.
  const { item: linked } = useLocalSearchParams<{ item?: string }>();
  useEffect(() => {
    if (linked === undefined || linked === "") return;
    router.setParams({ item: undefined });
    const route = reviewItemRoute(linked);
    if (route === null) toast.show("Reviews cannot open that link");
    else router.push(route);
  }, [linked, router, toast]);

  // Snoozed rows come back on their own as `now` passes their time.
  const waiting = useMemo(() => (queue === null ? [] : liveReviewItems(queue, null, now)), [queue, now]);
  const text = search.trim();
  const byFilter = useMemo(() => (filter === "all" ? waiting : waiting.filter((item) => item.ref.kind === filter)), [waiting, filter]);
  const shown = useMemo(() => (text === "" ? byFilter : byFilter.filter((item) => reviewMatches(item, text))), [byFilter, text]);
  const openRow = useMemo(() => (text === "" ? null : reviewOpenRow(text, waiting)), [waiting, text]);
  const sections = useMemo(() => reviewDayGroups(shown, now).map((group) => ({ title: group.label, data: group.items })), [shown, now]);
  const notes = queue === null ? [] : sourceNotes(queue, filter);

  const done = (item: ReviewItem) => {
    void markReviewDone(item.url, item.updatedAt).then((error) => {
      if (error !== null) toast.show(error);
    });
  };

  return (
    <Screen>
      <ItemHeader />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.url}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            tintColor={colors.textMuted}
            onRefresh={() => {
              if (!connected) return;
              setPulled(true);
              void reviewsRequest({ kind: "queue", refresh: true }).then((result) => {
                setPulled(false);
                if (!result.ok) toast.show(result.error ?? "Could not refresh.");
              });
            }}
          />
        }
        ListHeaderComponent={
          <View style={styles.head}>
            <Text variant="largeTitle">Reviews</Text>
            <Text color="textMuted" style={styles.count}>
              {queue === null ? (connected ? "Asking your Mac…" : "Not connected") : waiting.length === 0 ? "Nothing waiting on you" : `${String(waiting.length)} waiting on you`}
            </Text>
            <SegmentedTabs tabs={FILTERS} value={filter} onChange={setFilter} />
            <View style={[styles.search, { backgroundColor: colors.surfaceRaised }]}>
              <SymbolView name="magnifyingglass" size={15} tintColor={colors.textFaint} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search title, ENG-6693, repo#246, person, channel"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                clearButtonMode="while-editing"
                keyboardAppearance={scheme}
                selectionColor={colors.accent}
                accessibilityLabel="Search reviews"
                style={[styles.searchInput, { color: colors.text }]}
              />
            </View>
            {openRow !== null && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={openRow.title}
                onPress={() => {
                  router.push(openRow.route);
                }}
                style={[styles.open, { borderBottomColor: colors.hairline }]}
              >
                <SourceMark source={openRow.source} size={16} color="textMuted" />
                <Text style={styles.openTitle} numberOfLines={1}>
                  {openRow.title}
                </Text>
                <SymbolView name="chevron.right" size={12} tintColor={colors.textFaint} />
              </Pressable>
            )}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text variant="label" color="textMuted" style={[styles.section, { borderBottomColor: colors.hairline }]}>
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <QueueRow
            item={item}
            unread={queue !== null && isReviewUnread(item, queue.read)}
            now={now}
            onOpen={() => {
              openReviewItem(router, item);
            }}
            onDone={() => {
              done(item);
            }}
          />
        )}
        ListEmptyComponent={
          queue === null || openRow !== null ? null : text !== "" ? (
            <EmptyState symbol="magnifyingglass" title="No matches." body="Nothing in the queue matches that search." />
          ) : (
            <EmptyState symbol="checklist" title="All caught up" body={filter === "all" ? "Nothing from GitHub, Linear or Slack waits on you." : `Nothing from ${SOURCE_NAME[filter]} waits on you.`} />
          )
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListFooterComponent={
          notes.length === 0 ? null : (
            <View style={styles.notes}>
              {notes.map((note) => (
                <Text key={note} variant="caption" color="textFaint" numberOfLines={2}>
                  {note}
                </Text>
              ))}
            </View>
          )
        }
        contentContainerStyle={styles.list}
      />
      {toast.message !== null && (
        <View style={styles.toast} pointerEvents="none">
          <Toast message={toast.message} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: spacing.xl, paddingBottom: spacing.md, gap: spacing.xs },
  count: { marginBottom: spacing.md },
  search: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: 12, marginTop: spacing.sm },
  searchInput: { flex: 1, minHeight: 38, fontSize: 16 },
  open: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  openTitle: { flex: 1, fontWeight: "600" },
  section: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  notes: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.xs },
  list: { paddingBottom: spacing.xxxl },
  toast: { position: "absolute", left: 0, right: 0, bottom: spacing.xxxl, alignItems: "center" },
});
