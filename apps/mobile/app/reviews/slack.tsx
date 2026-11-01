/**
 * A Slack thread or DM in Reviews (`/reviews/slack?url&channel&threadTs`): the last read at once,
 * then a fresh read through the host (a minute or more, said quietly while it runs). A reply is
 * handed to Astra to send from the Slack app, only after the confirm sheet.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReviewRef } from "@relay/protocol";
import { reviewsRequest } from "@/connection";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { markReviewDone } from "@/reviews/actions";
import { ComposerDock } from "@/reviews/ComposerDock";
import { ItemHeader } from "@/reviews/ItemHeader";
import { ItemScreen } from "@/reviews/ItemScreen";
import { slackParts } from "@/reviews/model";
import { RepliesDivider, SlackBubble } from "@/reviews/SlackBubble";
import { useReviewComposer } from "@/reviews/useReviewComposer";
import { threadKey, useReviewsStore } from "@/state/reviews";
import { spacing, useColors } from "@/theme";
import { EmptyState } from "@/ui/EmptyState";
import { Text } from "@/ui/Text";

export default function ReviewSlackScreen() {
  const colors = useColors();
  const router = useRouter();
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

  const channelName = thread?.channelName ?? item?.label ?? "Slack";
  const reference: ReviewRef = { kind: "slack", channel, threadTs };
  const composer = useReviewComposer(params.url, reference, { kind: "slack", channel, threadTs, channelName }, toast.show);

  const done = () => {
    void markReviewDone(params.url, item?.updatedAt ?? now).then((failure) => {
      if (failure !== null) toast.show(failure);
    });
    router.back();
  };

  const parts = slackParts(thread?.messages ?? [], threadTs);

  return (
    <ItemScreen
      stickToEnd
      toast={toast.message}
      header={<ItemHeader title={channelName} subtitle={item === undefined ? undefined : `${item.actor} ${item.reason}`} onDone={done} />}
      dock={
        <ComposerDock
          composer={composer}
          placeholder={threadTs === null ? "Reply" : "Reply in thread"}
          hint="Type @Astra to ask privately. Nothing posts until you send."
        />
      }
    >
      <View style={styles.page}>
        {thread === undefined || thread === null ? (
          reading ? null : <EmptyState symbol="number" title="Could not read Slack" body={error ?? "Your Mac has not read this thread yet."} actionLabel="Try again" onAction={read} />
        ) : (
          <>
            {parts.parent !== null && (
              <>
                <SlackBubble message={parts.parent} now={now} />
                {parts.replies.length > 0 && <RepliesDivider count={parts.replies.length} />}
              </>
            )}
            {parts.replies.map((message) => (
              <SlackBubble key={message.ts} message={message} now={now} />
            ))}
          </>
        )}
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
  page: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.lg },
  reading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm },
});
