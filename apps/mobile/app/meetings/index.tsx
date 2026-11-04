/**
 * Meetings (`/meetings`): a call Relay is recording right now on top (red dot, elapsed time), then
 * what waits on Isaac from past meetings (Accept / Dismiss), Relay's own recordings and the recent
 * meetings Eva filed. A row opens `/meetings/<id>`: a recording's live transcript and Ask, or a
 * meeting's notes. The same list as Relay desktop's Meetings page, read from the host.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  MEETING_STAGE_LABEL,
  meetingClock,
  type MeetingProposal,
  type MeetingRecording,
  type MeetingSummary,
} from "@relay/protocol";
import { meetingsRequest, requestMeetings } from "@/connection";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { useConnectionStore } from "@/state/connection";
import { recordingTitle, useMeetingsStore } from "@/state/meetings";
import { spacing, tabularNumbers, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { Toast } from "@/ui/Toast";

type Row =
  | { kind: "recording"; r: MeetingRecording }
  | { kind: "waiting"; stem: string; title: string; proposal: MeetingProposal }
  | { kind: "record"; m: MeetingSummary };

const WHEN = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const RECENT = 30;

export default function Meetings() {
  const colors = useColors();
  const router = useRouter();
  const state = useMeetingsStore((s) => s.state);
  const connected = useConnectionStore((s) => s.status === "connected");
  const [now, setNow] = useState(() => Date.now());
  const [pulled, setPulled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useTransientMessage();

  useFocusEffect(
    useCallback(() => {
      requestMeetings();
    }, []),
  );
  const recording = state?.recordings.some((r) => r.stage === "recording") === true;
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [recording]);

  const sections = useMemo(() => {
    if (state === null) return [];
    const live = state.recordings.filter((r) => r.stage !== "done" && r.stage !== "failed");
    const past = state.recordings.filter((r) => r.stage === "done" || r.stage === "failed");
    const out: { title: string; data: Row[] }[] = [];
    if (live.length > 0)
      out.push({ title: "Live", data: live.map((r) => ({ kind: "recording", r })) });
    if (state.digest.waiting.length > 0)
      out.push({
        title: "Waiting on you",
        data: state.digest.waiting.map((w) => ({ kind: "waiting", ...w })),
      });
    if (past.length > 0)
      out.push({
        title: "Recorded by Relay",
        data: past.slice(0, RECENT).map((r) => ({ kind: "recording", r })),
      });
    const records = state.meetings.filter((m) => !m.skipped).slice(0, RECENT);
    if (records.length > 0)
      out.push({ title: "Recent meetings", data: records.map((m) => ({ kind: "record", m })) });
    return out;
  }, [state]);

  const decide = (stem: string, proposalId: string, kind: "accept" | "dismiss") => {
    setBusy(proposalId);
    void meetingsRequest({ kind, stem, proposalId }).then((result) => {
      setBusy(null);
      if (!result.ok) toast.show(result.error ?? "Could not update the meeting.");
      else toast.show(kind === "accept" ? `Added ${result.todoId ?? "a todo"}` : "Dismissed");
      requestMeetings();
    });
  };

  const render = (row: Row) => {
    if (row.kind === "waiting") {
      return (
        <View
          style={[styles.row, { borderColor: colors.hairline }]}
          testID={`meetings-waiting-${row.proposal.id}`}
        >
          <Text>{row.proposal.text}</Text>
          <Text variant="caption" color="textMuted">
            From {row.title}
          </Text>
          <View style={styles.actions}>
            <Button
              label="Accept"
              onPress={() => {
                decide(row.stem, row.proposal.id, "accept");
              }}
              loading={busy === row.proposal.id}
              height={32}
            />
            <Button
              label="Dismiss"
              variant="ghost"
              onPress={() => {
                decide(row.stem, row.proposal.id, "dismiss");
              }}
              disabled={busy === row.proposal.id}
              height={32}
            />
          </View>
        </View>
      );
    }
    const id = row.kind === "recording" ? row.r.id : row.m.stem;
    const title = row.kind === "recording" ? recordingTitle(row.r) : row.m.title;
    const live = row.kind === "recording" && row.r.stage === "recording";
    const sub =
      row.kind === "recording"
        ? live
          ? `${row.r.app} · ${meetingClock(now - row.r.startedAt)}`
          : row.r.stage === "done"
            ? `${row.r.app} · ${WHEN.format(new Date(row.r.startedAt))}`
            : MEETING_STAGE_LABEL[row.r.stage]
        : row.m.start === null
          ? "Undated"
          : WHEN.format(new Date(row.m.start));
    return (
      <Pressable
        onPress={() => {
          router.push({ pathname: "/meetings/[id]", params: { id } });
        }}
        style={[styles.row, { borderColor: colors.hairline }]}
        accessibilityRole="button"
        accessibilityLabel={live ? `${title}, recording` : title}
        testID={`meetings-row-${id}`}
      >
        <View style={styles.titleLine}>
          {live ? <View style={[styles.dot, { backgroundColor: colors.danger }]} /> : null}
          <Text variant="title" numberOfLines={1} style={{ flex: 1 }}>
            {title}
          </Text>
          {row.kind === "record" && row.m.pending > 0 ? (
            <Text variant="label" color="accent">
              {row.m.pending}
            </Text>
          ) : null}
        </View>
        <Text variant="caption" color="textMuted" style={tabularNumbers}>
          {sub}
        </Text>
      </Pressable>
    );
  };

  return (
    <Screen>
      <SectionList
        sections={sections}
        keyExtractor={(row) =>
          row.kind === "recording" ? row.r.id : row.kind === "record" ? row.m.stem : row.proposal.id
        }
        stickySectionHeadersEnabled={false}
        renderItem={({ item }) => render(item)}
        renderSectionHeader={({ section }) => (
          <Text variant="label" color="textMuted" style={styles.section}>
            {section.title}
          </Text>
        )}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            tintColor={colors.textMuted}
            onRefresh={() => {
              setPulled(true);
              requestMeetings();
              setTimeout(() => {
                setPulled(false);
              }, 600);
            }}
          />
        }
        ListHeaderComponent={
          <View style={styles.head}>
            <Text variant="largeTitle">Meetings</Text>
            <Text color="textMuted">
              {state === null
                ? connected
                  ? "Asking your Mac…"
                  : "Not connected"
                : `${String(state.digest.recentCount)} this week, ${String(state.digest.waiting.length)} waiting on you`}
            </Text>
          </View>
        }
        ListEmptyComponent={
          state === null ? null : (
            <Text color="textMuted" style={styles.empty}>
              No meetings yet. Relay records Teams, Zoom, Webex and Slack calls on your Macs.
            </Text>
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
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  head: { gap: spacing.xs, paddingTop: spacing.md, paddingBottom: spacing.md },
  section: { paddingTop: spacing.lg, paddingBottom: spacing.xs },
  row: {
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actions: { flexDirection: "row", gap: spacing.sm, paddingTop: spacing.xs },
  empty: { paddingTop: spacing.xl },
  toast: { position: "absolute", left: 0, right: 0, bottom: spacing.xxxl, alignItems: "center" },
});
