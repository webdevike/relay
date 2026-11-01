/**
 * A Linear ticket in Reviews (`/reviews/linear?url&key`): status, assignee, priority, project and
 * linked PR, the description folded, then the comments as threads. "Reply in thread" points the
 * composer at that thread; a post goes out only from the confirm sheet.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { LinearComment, ReviewRef } from "@relay/protocol";
import { hostBaseUrl, reviewsRequest } from "@/connection";
import { openExternal } from "@/lib/links";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { markReviewDone, openReviewItem } from "@/reviews/actions";
import { ComposerDock } from "@/reviews/ComposerDock";
import { ItemHeader } from "@/reviews/ItemHeader";
import { ItemScreen } from "@/reviews/ItemScreen";
import { FoldedMarkdown, LinearComments, PropertyRow } from "@/reviews/LinearParts";
import { githubPrOf, withHostMedia } from "@/reviews/model";
import { LinearStateGlyph, PrGlyph } from "@/reviews/SourceGlyph";
import { useReviewComposer } from "@/reviews/useReviewComposer";
import { useReviewsStore } from "@/state/reviews";
import { spacing, useColors } from "@/theme";
import { Avatar } from "@/ui/Avatar";
import { EmptyState } from "@/ui/EmptyState";
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
  );

  const done = () => {
    void markReviewDone(params.url, item?.updatedAt ?? ticket?.updatedAt ?? now).then((failure) => {
      if (failure !== null) toast.show(failure);
    });
    router.back();
  };

  const linkedPr = ticket?.links.find((link) => githubPrOf(link.url) !== null);
  const linkedRef = linkedPr === undefined ? null : githubPrOf(linkedPr.url);

  return (
    <ItemScreen
      toast={toast.message}
      header={<ItemHeader onDone={done} onMenu={() => {
        setMenu(true);
      }} />}
      refreshControl={<RefreshControl refreshing={loading && ticket !== undefined} tintColor={colors.textMuted} onRefresh={load} />}
      dock={
        <ComposerDock
          url={params.url}
          composer={composer}
          replyingTo={reply?.author.name ?? null}
          onClearReply={() => {
            setReply(null);
          }}
        />
      }
    >
      <View style={styles.page}>
        <View style={styles.meta}>
          <LinearStateGlyph type={ticket?.state.type ?? item?.stateType} color={ticket?.state.color} size={16} />
          <Text color="textMuted">{params.key}</Text>
        </View>
        <Text variant="largeTitle" style={styles.title}>
          {ticket?.title ?? item?.title ?? ""}
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
            {ticket.description.trim() !== "" && <FoldedMarkdown text={withHostMedia(ticket.description, base)} />}
            <LinearComments
              comments={ticket.comments}
              now={now}
              body={(markdown) => withHostMedia(markdown, base)}
              onReply={setReply}
            />
          </>
        )}
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
  page: { paddingHorizontal: spacing.xl, gap: spacing.sm },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { fontSize: 24, lineHeight: 30 },
  properties: { marginTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  linked: { flexShrink: 1 },
});
