/**
 * A Linear ticket in Reviews (`/reviews/linear?url&key`), laid out like Linear's iOS issue view:
 * status, assignee, priority, project and linked PR, the description card, then comment threads,
 * history lines and Astra's cards in time order. "Reply in thread" points the composer at that
 * thread; a post goes out only from the confirm sheet.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { LinearComment, ReviewRef } from "@relay/protocol";
import { hostBaseUrl, reviewsRequest } from "@/connection";
import { openExternal } from "@/lib/links";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { openReviewItem, useMarkSeen } from "@/reviews/actions";
import { ItemDock } from "@/reviews/ItemDock";
import { ItemHeader } from "@/reviews/ItemHeader";
import { ItemScreen } from "@/reviews/ItemScreen";
import { FoldedMarkdown, LinearThreadCard, PropertyRow } from "@/reviews/LinearParts";
import { githubPrOf, linearEntries, mergeTimeline, withHostMedia } from "@/reviews/model";
import { LinearStateGlyph, PrGlyph } from "@/reviews/SourceGlyph";
import { Timeline } from "@/reviews/Timeline";
import { useReviewComposer } from "@/reviews/useReviewComposer";
import { useReviewsStore } from "@/state/reviews";
import { spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { EmptyState } from "@/ui/EmptyState";
import { ActivityLine, FeedCard } from "@/ui/FeedCard";
import { Row } from "@/ui/Row";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";

export default function ReviewLinearScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ url: string; key: string }>();
  const ticket = useReviewsStore((state) => state.tickets[params.key]);
  const item = useReviewsStore((state) => state.queue?.items.find((i) => i.url === params.url));
  const [reply, setReply] = useState<LinearComment | null>(null);
  const [menu, setMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useTransientMessage();
  const now = Date.now();
  const base = hostBaseUrl();

  const load = useCallback(() => {
    setLoading(true);
    void reviewsRequest({ kind: "linear", key: params.key }).then((result) => {
      setLoading(false);
      setError(result.ok ? null : (result.error ?? "Could not read the ticket."));
    });
  }, [params.key]);

  useEffect(() => {
    load();
  }, [load]);

  const updatedAt = item?.updatedAt ?? ticket?.updatedAt;
  useMarkSeen(params.url, item?.updatedAt);

  const reference: ReviewRef = { kind: "linear", key: params.key };
  const composer = useReviewComposer(
    params.url,
    reference,
    ticket === undefined ? null : { kind: "linear", issueId: ticket.id, key: ticket.key, reply: reply === null ? null : { parentId: reply.id, name: reply.author.name } },
    (message) => {
      toast.show(message);
      setReply(null);
      load();
    },
    toast.show,
  );

  const linkedPr = ticket?.links.find((link) => githubPrOf(link.url) !== null);
  const linkedRef = linkedPr === undefined ? null : githubPrOf(linkedPr.url);
  const rows = mergeTimeline(ticket === undefined ? [] : linearEntries(ticket.comments, ticket.activity), composer.astra);
  const people = ticket === undefined ? [] : ticket.people.filter((p) => p.handle !== ticket.me.handle).map((p) => p.name);
  const title = ticket?.title ?? item?.title ?? "";

  return (
    <ItemScreen
      toast={toast.message}
      followKey={composer.followKey}
      revealKey={composer.revealKey}
      header={
        <ItemHeader
          label={params.key}
          title={title}
          editLabel="Open in Linear"
          onEdit={() => {
            openExternal(ticket?.url ?? params.url);
          }}
          onMenu={() => {
            setMenu(true);
          }}
        />
      }
      refreshControl={<RefreshControl refreshing={loading && ticket !== undefined} tintColor={colors.textMuted} onRefresh={load} />}
      dock={
        <ItemDock
          composer={composer}
          url={params.url}
          updatedAt={updatedAt}
          placeholder="Comment"
          people={people}
          replyingTo={reply?.author.name ?? null}
          onClearReply={() => {
            setReply(null);
          }}
          notify={toast.show}
        />
      }
    >
      <View style={styles.page}>
        <View style={styles.meta}>
          <LinearStateGlyph type={ticket?.state.type ?? item?.stateType} color={ticket?.state.color} size={16} />
          <Text color="textMuted">{params.key}</Text>
        </View>
        <Text variant="largeTitle" style={styles.title}>
          {title}
        </Text>
        {ticket === undefined ? (
          <EmptyState symbol="circle.lefthalf.filled" title={error === null ? "Reading the ticket…" : "Could not read the ticket"} body={error ?? "Asking your Mac for it from Linear."} actionLabel="Try again" onAction={load} />
        ) : (
          <>
            <View style={[styles.properties, { borderTopColor: colors.hairline }]}>
              <PropertyRow label="Status">
                <LinearStateGlyph type={ticket.state.type} color={ticket.state.color} size={16} />
                <Text>{ticket.state.name}</Text>
              </PropertyRow>
              <PropertyRow label="Assignee">
                {ticket.assignee !== null && <Avatar name={ticket.assignee} size={22} />}
                <Text color={ticket.assignee === null ? "textMuted" : "text"}>{ticket.assignee ?? "Unassigned"}</Text>
              </PropertyRow>
              <PropertyRow label="Priority">
                <Text>{ticket.priority}</Text>
              </PropertyRow>
              {ticket.project !== null && (
                <PropertyRow label="Project">
                  <Text numberOfLines={1}>{ticket.project}</Text>
                </PropertyRow>
              )}
              {linkedPr !== undefined && linkedRef !== null && (
                <PropertyRow
                  label="Linked PR"
                  onPress={() => {
                    openReviewItem(router, { url: linkedPr.url, ref: { kind: "github", repo: linkedRef.repo, number: linkedRef.number } });
                  }}
                >
                  <PrGlyph size={16} />
                  <Text numberOfLines={1} style={styles.linked}>{`#${String(linkedRef.number)} ${linkedPr.title}`}</Text>
                </PropertyRow>
              )}
            </View>
            {ticket.description.trim() !== "" && (
              <FeedCard>
                <FoldedMarkdown text={withHostMedia(ticket.description, base)} />
              </FeedCard>
            )}
          </>
        )}
        <Timeline
          rows={rows}
          astra={composer.astra}
          now={now}
          onUseAsReply={composer.takeAnswer}
          onStop={composer.stop}
          renderEntry={(entry, at) =>
            entry.kind === "thread" ? (
              <LinearThreadCard
                thread={entry.thread}
                now={now}
                body={(markdown) => withHostMedia(markdown, base)}
                onReply={(comment) => {
                  setReply(comment);
                  composer.compose();
                }}
              />
            ) : (
              <ActivityLine actor={entry.actor} text={entry.text} highlights={entry.highlights} at={at} />
            )
          }
        />
      </View>
      <Sheet
        visible={menu}
        onClose={() => {
          setMenu(false);
        }}
      >
        <Row
          title="Open in Linear"
          onPress={() => {
            setMenu(false);
            openExternal(ticket?.url ?? params.url);
          }}
        />
      </Sheet>
    </ItemScreen>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: spacing.lg, gap: spacing.md },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xs },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700", paddingHorizontal: spacing.xs },
  properties: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.xs },
  linked: { flexShrink: 1 },
});
