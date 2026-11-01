/**
 * A PR in Reviews (`/reviews/pr?url&repo&number`): its title, state and size, then Conversation
 * (the description, comments and reviews as cards, pushes and bare verdicts as lines, Astra's
 * cards among them by time), Files (unified diff per file), Checks and the Guide. The ⋯ menu opens
 * it on GitHub or approves / requests changes, each through the confirm sheet like every comment;
 * `@Astra` asks her privately (an ask from another tab brings Conversation up to show it).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { reviewAgo, type ReviewRef } from "@relay/protocol";
import { reviewsRequest } from "@/connection";
import { openExternal } from "@/lib/links";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { useMarkSeen } from "@/reviews/actions";
import { ItemDock } from "@/reviews/ItemDock";
import { ItemHeader } from "@/reviews/ItemHeader";
import { ItemScreen } from "@/reviews/ItemScreen";
import { mergeTimeline, prBadge, prEntries } from "@/reviews/model";
import { PrGuide } from "@/reviews/PrGuide";
import { DiffStat, PrChecks, PrFiles, PrPostCard } from "@/reviews/PrTabs";
import { PrGlyph } from "@/reviews/SourceGlyph";
import { Timeline } from "@/reviews/Timeline";
import { useReviewComposer } from "@/reviews/useReviewComposer";
import { prKey, useReviewsStore } from "@/state/reviews";
import { spacing, useColors } from "@/theme";
import { EmptyState } from "@/ui/EmptyState";
import { ActivityLine } from "@/ui/FeedCard";
import { Pill } from "@/ui/Pill";
import { Row } from "@/ui/Row";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { UnderlineTabs } from "@/ui/UnderlineTabs";

type Tab = "conversation" | "files" | "checks" | "guide";

export default function ReviewPrScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ url: string; repo: string; number: string }>();
  const repo = params.repo;
  const number = Number(params.number);
  const key = prKey(repo, number);
  const pr = useReviewsStore((state) => state.prs[key]);
  const guide = useReviewsStore((state) => state.guides[key]);
  const item = useReviewsStore((state) => state.queue?.items.find((i) => i.url === params.url));
  const [tab, setTab] = useState<Tab>("guide");
  const [menu, setMenu] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const toast = useTransientMessage();
  const now = Date.now();

  const load = useCallback(() => {
    setLoading(true);
    void reviewsRequest({ kind: "pr", repo, number }).then((result) => {
      setLoading(false);
      setError(result.ok ? null : (result.error ?? "Could not read the PR."));
    });
  }, [repo, number]);

  const loadGuide = useCallback(() => {
    setGuideLoading(true);
    void reviewsRequest({ kind: "guide", repo, number }).then((result) => {
      setGuideLoading(false);
      setGuideError(result.ok ? null : (result.error ?? "Could not write the guide."));
    });
  }, [repo, number]);

  useEffect(() => {
    load();
    loadGuide();
  }, [load, loadGuide]);

  const updatedAt = item?.updatedAt ?? pr?.updatedAt;
  useMarkSeen(params.url, item?.updatedAt);

  const reference: ReviewRef = { kind: "github", repo, number };
  const composer = useReviewComposer(params.url, reference, { kind: "github", repo, number }, toast.show, toast.show);

  // Astra's cards live in Conversation: an ask sent from another tab brings it up.
  const asked = useRef(composer.revealKey);
  useEffect(() => {
    if (asked.current === composer.revealKey) return;
    asked.current = composer.revealKey;
    setTab("conversation");
  }, [composer.revealKey]);

  const review = (event: "approve" | "request-changes") => {
    setMenu(false);
    const body = composer.draft.trim();
    composer.confirm({
      op: { kind: "review", repo, number, event, body },
      destination: `${event === "approve" ? "Approve" : "Request changes on"} GitHub ${repo}#${String(number)}`,
      text: body,
      action: event === "approve" ? "Approve" : "Request changes",
    });
  };

  const badge = pr === undefined ? null : prBadge(pr);
  const conversationCount = pr?.timeline.length ?? 0;
  const label = `${repo.split("/")[1] ?? repo}#${String(number)}`;
  const title = pr?.title ?? item?.title ?? "";
  const people = pr === undefined ? [] : [pr.author.login, ...pr.reviewers.map((r) => r.login), ...pr.assignees, ...pr.timeline.map((t) => t.author)];

  return (
    <ItemScreen
      toast={toast.message}
      followKey={tab === "conversation" ? composer.followKey : ""}
      revealKey={composer.revealKey}
      header={
        <ItemHeader
          label={label}
          title={title}
          editLabel="Open in GitHub"
          onEdit={() => {
            openExternal(pr?.url ?? params.url);
          }}
          onMenu={() => {
            setMenu(true);
          }}
        />
      }
      refreshControl={<RefreshControl refreshing={loading && pr !== undefined} tintColor={colors.textMuted} onRefresh={load} />}
      dock={<ItemDock composer={composer} url={params.url} updatedAt={updatedAt} placeholder="Comment" people={people} notify={toast.show} />}
    >
      <View style={styles.head}>
        <View style={styles.meta}>
          <PrGlyph size={16} />
          <Text color="textMuted" numberOfLines={1}>{`${repo.split("/")[1] ?? repo} #${String(number)}`}</Text>
        </View>
        <Text variant="largeTitle" style={styles.title}>
          {title}
        </Text>
        {pr !== undefined && badge !== null && (
          <View style={styles.meta}>
            <Pill label={badge.label} tone={badge.tone} />
            <Text color="textMuted">{`${pr.author.login}, ${reviewAgo(pr.createdAt, now)}`}</Text>
            <DiffStat additions={pr.additions} deletions={pr.deletions} />
          </View>
        )}
      </View>
      {pr === undefined ? (
        <EmptyState symbol="arrow.triangle.pull" title={error === null ? "Reading the PR…" : "Could not read the PR"} body={error ?? "Asking your Mac for its conversation, files and checks."} {...(error === null ? {} : { actionLabel: "Try again", onAction: load })} />
      ) : (
        <>
          <UnderlineTabs
            tabs={[
              { key: "conversation", label: "Conversation", count: conversationCount },
              { key: "files", label: "Files", count: pr.files.length },
              { key: "checks", label: "Checks", count: pr.checks.length },
              { key: "guide", label: "Guide" },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === "conversation" && (
            <View style={styles.conversation}>
              <Timeline
                rows={mergeTimeline(prEntries(pr), composer.astra)}
                astra={composer.astra}
                now={now}
                onUseAsReply={composer.takeAnswer}
                onStop={composer.stop}
                renderEntry={(entry, at) =>
                  entry.kind === "post" ? <PrPostCard post={entry} at={at} now={now} /> : <ActivityLine actor={entry.actor} text={entry.text} highlights={entry.highlights} at={at} />
                }
              />
            </View>
          )}
          {tab === "files" && <PrFiles pr={pr} />}
          {tab === "checks" && <PrChecks pr={pr} />}
          {tab === "guide" && <PrGuide pr={pr} guide={guide} loading={guideLoading} error={guideError} onRetry={loadGuide} />}
        </>
      )}
      <Sheet
        visible={menu}
        onClose={() => {
          setMenu(false);
        }}
      >
        <Row
          title="Open in GitHub"
          onPress={() => {
            setMenu(false);
            openExternal(pr?.url ?? params.url);
          }}
        />
        <Row
          title="Approve"
          subtitle="Asks before it posts"
          onPress={() => {
            review("approve");
          }}
        />
        <Row
          title="Request changes"
          subtitle="Uses the comment you typed; asks before it posts"
          onPress={() => {
            review("request-changes");
          }}
        />
      </Sheet>
    </ItemScreen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: spacing.xl, paddingBottom: spacing.md, gap: spacing.sm },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  conversation: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
});
