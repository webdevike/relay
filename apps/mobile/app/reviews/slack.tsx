/**
 * A Slack thread or DM in Reviews (`/reviews/slack?url&channel&threadTs`): the last read at once,
 * then a fresh read through the host (a minute or more, said quietly while it runs). Each message
 * is a card, Isaac's too, with Astra's cards among them by time. A reply is handed to Astra to send
 * from the Slack app, only after the confirm sheet.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import type { ReviewRef } from "@relay/protocol";
import { emojify } from "@relay/slack-emoji";
import { reviewsRequest } from "@/connection";
import { openExternal } from "@/lib/links";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { useMarkSeen } from "@/reviews/actions";
import { ItemDock } from "@/reviews/ItemDock";
import { ItemHeader } from "@/reviews/ItemHeader";
import { ItemScreen } from "@/reviews/ItemScreen";
import { mergeTimeline, slackEntries } from "@/reviews/model";
import { RepliesDivider, SlackCard } from "@/reviews/SlackCard";
import { Timeline } from "@/reviews/Timeline";
import { useReviewComposer } from "@/reviews/useReviewComposer";
import { threadKey, useReviewsStore } from "@/state/reviews";
import { spacing, useColors } from "@/theme";
import { EmptyState } from "@/ui/EmptyState";
import { Text } from "@/ui/Text";

export default function ReviewSlackScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ url: string; channel: string; threadTs: string }>();
  const channel = params.channel;
  const threadTs = params.threadTs === "" ? null : params.threadTs;
  const thread = useReviewsStore((state) => state.threads[threadKey(channel, threadTs)]);
  const item = useReviewsStore((state) => state.queue?.items.find((i) => i.url === params.url));
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useTransientMessage();
  const now = Date.now();

  const read = useCallback(() => {
    setReading(true);
    void reviewsRequest({ kind: "slack", channel, threadTs, refresh: true }).then((result) => {
      setReading(false);
      setError(result.ok ? null : (result.error ?? "Could not read Slack."));
    });
  }, [channel, threadTs]);

  useEffect(() => {
    void reviewsRequest({ kind: "slack", channel, threadTs, refresh: false });
    read();
  }, [channel, threadTs, read]);

  useMarkSeen(params.url, item?.updatedAt);

  const channelName = thread?.channelName ?? item?.label ?? "Slack";
  const reference: ReviewRef = { kind: "slack", channel, threadTs };
  const composer = useReviewComposer(params.url, reference, { kind: "slack", channel, threadTs, channelName }, toast.show, toast.show);

  const messages = thread?.messages ?? [];
  const rows = mergeTimeline(slackEntries(messages, threadTs), composer.astra);
  const people = messages.filter((m) => !m.mine).map((m) => m.author);

  return (
    <ItemScreen
      stickToEnd
      toast={toast.message}
      followKey={composer.followKey}
      revealKey={composer.revealKey}
      header={
        <ItemHeader
          label={item?.label ?? channelName}
          title={item === undefined ? channelName : emojify(item.title)}
          editLabel="Open in Slack"
          onEdit={() => {
            openExternal(params.url);
          }}
        />
      }
      dock={<ItemDock composer={composer} url={params.url} updatedAt={item?.updatedAt} placeholder="Reply" people={people} notify={toast.show} />}
    >
      <View style={styles.page}>
        <View style={styles.head}>
          <Text variant="largeTitle" style={styles.title}>
            {channelName}
          </Text>
          {item !== undefined && <Text color="textMuted">{`${item.actor} ${item.reason}`}</Text>}
        </View>
        {(thread === undefined || thread === null) && !reading && <EmptyState symbol="number" title="Could not read Slack" body={error ?? "Your Mac has not read this thread yet."} actionLabel="Try again" onAction={read} />}
        <Timeline
          rows={rows}
          astra={composer.astra}
          now={now}
          onUseAsReply={composer.takeAnswer}
          onStop={composer.stop}
          renderEntry={(entry) => (entry.kind === "message" ? <SlackCard message={entry.message} now={now} /> : <RepliesDivider count={entry.count} />)}
        />
        {reading && (
          <View style={styles.reading} accessibilityLabel="Reading Slack">
            <ActivityIndicator size="small" color={colors.textMuted} />
            <Text variant="caption" color="textMuted">
              Reading Slack…
            </Text>
          </View>
        )}
        {!reading && error !== null && thread !== undefined && thread !== null && (
          <Text variant="caption" color="textFaint">{`Showing the last read: ${error}`}</Text>
        )}
      </View>
    </ItemScreen>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: spacing.lg, gap: spacing.md },
  head: { paddingHorizontal: spacing.xs, gap: spacing.xs },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  reading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm },
});
