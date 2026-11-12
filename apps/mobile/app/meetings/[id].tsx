/**
 * One meeting (`/meetings/<id>`). A recording Relay made: the live transcript while the call runs
 * (drafts dimmed, follows the newest line), the stage after it, then its notes; Ask sends a question
 * to Astra's session about the meeting (typed, or held to talk), answers inline and on the desktop
 * too. A meeting Eva filed (a stem): its summary, decisions and what waits on Isaac.
 *
 * Opened from an assistant's meeting card (`?chat=<agent>`) it is that chat's full-screen meeting
 * view: no Astra dock; one swipeable row of quick asks posts into that chat as Isaac's turn (the
 * host gives the assistant the transcript) and goes back to it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  MEETING_STAGE_LABEL,
  meetingClock,
  meetingIsLive,
  meetingRows,
  type MeetingDetail,
} from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { meetingsRequest, sendCommand } from "@/connection";
import { DictationButton } from "@/dictation";
import { pushDictationTarget } from "@/dictation/deliver";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { recordingTitle, useMeetingsStore } from "@/state/meetings";
import { agentTitle, useAssistantStore } from "@/state/assistant";
import { newClientId, startTurn } from "@/state/turns";
import { QuickAsks } from "@/meetings/QuickAsks";
import { spacing, tabularNumbers, useColors, useScheme } from "@/theme";
import { Button } from "@/ui/Button";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { Toast } from "@/ui/Toast";

const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default function MeetingScreen() {
  const { id, chat } = useLocalSearchParams<{ id: string; chat?: string }>();
  if (!RECORDING_ID.test(id)) return <RecordScreen stem={id} />;
  return chat === undefined || chat === "" ? <RecordingScreen id={id} /> : <RecordingScreen id={id} chat={chat} />;
}

function RecordingScreen({ id, chat }: { id: string; chat?: string }) {
  const colors = useColors();
  const scheme = useScheme();
  const router = useRouter();
  const agents = useAssistantStore((state) => state.agents);
  const page = useMeetingsStore((s) => s.pages[id]);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scroll = useRef<ScrollView>(null);
  const following = useRef(true);
  const toast = useTransientMessage();

  const ask = useCallback(
    async (text: string): Promise<void> => {
      const q = text.trim();
      if (q === "") return;
      if (chat !== undefined) {
        // From a chat: the words go into it as Isaac's turn (the command its composer sends; the
        // host adds the transcript), then back to it.
        const clientId = newClientId();
        const command = { kind: "assistant.turn" as const, agent: chat, text: q, clientId };
        startTurn({
          agent: chat,
          clientId,
          text: q,
          images: [],
          delivery: sendCommand(command),
          command,
          // The thread's echo marks a refusal and offers Try again.
          onRefused: () => undefined,
        });
        if (router.canGoBack()) router.back();
        else router.replace({ pathname: "/eva", params: { agent: chat } });
        return;
      }
      setAsking(true);
      const result = await meetingsRequest({ kind: "ask", id, question: q });
      setAsking(false);
      if (result.ok) setQuestion("");
      else toast.show(result.error ?? "Astra could not be asked.");
    },
    [id, toast, chat, router],
  );

  useFocusEffect(
    useCallback(() => {
      void meetingsRequest({ kind: "open", id }).then((result) => {
        setError(result.ok ? null : (result.error ?? "Could not open the meeting."));
      });
      // Held to talk on this screen, the words are a question for Astra (from a chat, for that
      // assistant in its chat); leaving releases only this claim.
      return pushDictationTarget({ kind: "local", onText: ask });
    }, [id, ask]),
  );

  const live = page !== undefined && meetingIsLive(page.recording);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [live]);
  const rows = useMemo(() => meetingRows(page?.lines ?? []), [page?.lines]);

  if (page === undefined) {
    return (
      <Screen>
        <View style={styles.center}>
          {error === null ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <Text color="textMuted">{error}</Text>
          )}
        </View>
      </Screen>
    );
  }
  const r = page.recording;
  const elapsed = live ? now - r.startedAt : (r.endedAt ?? r.startedAt) - r.startedAt;
  const turns = page.astra?.turns.filter((t) => t.role !== "tool") ?? [];

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.fill}
        keyboardVerticalOffset={90}
      >
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.body}
          onContentSizeChange={() => {
            if (following.current) scroll.current?.scrollToEnd({ animated: false });
          }}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            following.current =
              contentSize.height - contentOffset.y - layoutMeasurement.height < 60;
          }}
          scrollEventThrottle={100}
        >
          <Text variant="largeTitle">{recordingTitle(r)}</Text>
          <View style={styles.titleLine}>
            {live ? <View style={[styles.dot, { backgroundColor: colors.danger }]} /> : null}
            <Text color="textMuted" style={tabularNumbers}>
              {r.app} · {r.device} · {meetingClock(elapsed)}
            </Text>
          </View>
          <Text
            color={r.health === "ok" && r.stage !== "failed" ? "textMuted" : "danger"}
            testID="meeting-stage"
          >
            {live
              ? r.healthDetail
              : r.stage === "failed"
                ? `Failed: ${r.error ?? "no reason given"}`
                : MEETING_STAGE_LABEL[r.stage]}
          </Text>
          {live ? (
            <View style={styles.actions}>
              <Button
                label="Stop recording"
                variant="secondary"
                height={32}
                onPress={() => {
                  void meetingsRequest({ kind: "stop", id }).then((res) => {
                    if (!res.ok) toast.show(res.error ?? "Could not stop it.");
                  });
                }}
              />
            </View>
          ) : null}

          {page.notes !== null ? (
            <View style={styles.block}>
              <Text variant="title">Summary</Text>
              {page.notes.summary.map((p, i) => (
                <Text key={i}>{p}</Text>
              ))}
              {page.notes.decisions.length > 0 ? <Text variant="title">Decisions</Text> : null}
              {page.notes.decisions.map((d, i) => (
                <Text key={i}>• {d}</Text>
              ))}
            </View>
          ) : null}

          <View style={styles.block}>
            <Text variant="title">Transcript</Text>
            {rows.length === 0 ? (
              <Text color="textMuted">
                {live
                  ? "Listening. Lines show up a moment after someone speaks."
                  : "Nothing was transcribed."}
              </Text>
            ) : null}
            {rows.map((row) => (
              <View key={row.id} style={styles.line} testID="meeting-line">
                <Text variant="caption" color={row.track === "mic" ? "accent" : "textMuted"}>
                  {row.speaker} · {meetingClock(row.startMs)}
                </Text>
                <Text color={row.draft ? "textMuted" : "text"}>{row.text}</Text>
              </View>
            ))}
          </View>

          {turns.length > 0 || page.astra?.working === true ? (
            <View style={styles.block}>
              <Text variant="title">Astra</Text>
              {turns.map((t) =>
                t.role === "user" ? (
                  <Text key={t.id} variant="label">
                    {t.text}
                  </Text>
                ) : (
                  <MessageText key={t.id} text={t.text} streaming={t.streaming} />
                ),
              )}
              {page.astra?.working === true ? (
                <Text color="textMuted">Astra is thinking…</Text>
              ) : null}
              {page.astra?.error != null ? <Text color="danger">{page.astra.error}</Text> : null}
            </View>
          ) : null}
        </ScrollView>
        {chat === undefined ? (
          <View style={[styles.dock, { borderColor: colors.hairline, backgroundColor: colors.bg }]}>
            <TextInput
              value={question}
              onChangeText={setQuestion}
              placeholder="Ask Astra about this meeting"
              placeholderTextColor={colors.textFaint}
              keyboardAppearance={scheme}
              editable={!asking}
              returnKeyType="send"
              onSubmitEditing={() => void ask(question)}
              style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceRaised }]}
              testID="meeting-question"
            />
            <DictationButton size={40} backgroundColor={colors.surfaceRaised} />
          </View>
        ) : live ? (
          <View style={[styles.asks, { borderColor: colors.hairline, backgroundColor: colors.bg }]} testID="meeting-quick-asks">
            <Text variant="caption" color="textMuted" style={styles.asksLabel}>
              Ask {agentTitle(agents, chat)} in the chat
            </Text>
            <QuickAsks onAsk={(text) => void ask(text)} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
      {toast.message !== null && (
        <View style={styles.toast} pointerEvents="none">
          <Toast message={toast.message} />
        </View>
      )}
    </Screen>
  );
}

function RecordScreen({ stem }: { stem: string }) {
  const colors = useColors();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useTransientMessage();
  const load = useCallback(() => {
    void meetingsRequest({ kind: "get", stem }).then((result) => {
      if (result.ok && result.detail !== undefined) setDetail(result.detail);
      else setError(result.error ?? "Could not open the meeting.");
    });
  }, [stem]);
  useFocusEffect(load);

  if (detail?.meeting == null) {
    return (
      <Screen>
        <View style={styles.center}>
          {error === null && detail === null ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <Text color="textMuted">{error ?? "No such meeting."}</Text>
          )}
        </View>
      </Screen>
    );
  }
  const m = detail.meeting;
  const decide = (proposalId: string, kind: "accept" | "dismiss") => {
    setBusy(proposalId);
    void meetingsRequest({ kind, stem, proposalId }).then((result) => {
      setBusy(null);
      toast.show(
        result.ok
          ? kind === "accept"
            ? `Added ${result.todoId ?? "a todo"}`
            : "Dismissed"
          : (result.error ?? "Could not update the meeting."),
      );
      load();
    });
  };
  return (
    <Screen scroll>
      <View style={styles.body}>
        <Text variant="largeTitle">{m.title}</Text>
        {detail.protocol !== null ? (
          <View style={styles.block}>
            <Text variant="title">Summary</Text>
            {detail.protocol.summary.map((p, i) => (
              <Text key={i}>{p}</Text>
            ))}
          </View>
        ) : (
          <Text color="textMuted">
            {detail.notes === "missing" ? "Notes file not found" : "No notes"}
          </Text>
        )}
        {m.proposals.some((p) => p.status === "proposed") ? (
          <View style={styles.block}>
            <Text variant="title">For you</Text>
            {m.proposals
              .filter((p) => p.status === "proposed")
              .map((p) => (
                <View key={p.id} style={styles.line}>
                  <Text>{p.text}</Text>
                  <View style={styles.actions}>
                    <Button
                      label="Accept"
                      height={32}
                      loading={busy === p.id}
                      onPress={() => {
                        decide(p.id, "accept");
                      }}
                    />
                    <Button
                      label="Dismiss"
                      variant="ghost"
                      height={32}
                      disabled={busy === p.id}
                      onPress={() => {
                        decide(p.id, "dismiss");
                      }}
                    />
                  </View>
                </View>
              ))}
          </View>
        ) : null}
        {detail.protocol !== null && detail.protocol.decisions.length > 0 ? (
          <View style={styles.block}>
            <Text variant="title">Decisions</Text>
            {detail.protocol.decisions.map((d, i) => (
              <Text key={i}>• {d}</Text>
            ))}
          </View>
        ) : null}
      </View>
      {toast.message !== null && (
        <View style={styles.toast} pointerEvents="none">
          <Toast message={toast.message} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  body: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxxl },
  titleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actions: { flexDirection: "row", gap: spacing.sm, paddingTop: spacing.xs },
  block: { gap: spacing.sm, paddingTop: spacing.lg },
  line: { gap: 2 },
  dock: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, minHeight: 40, borderRadius: 20, paddingHorizontal: spacing.md, fontSize: 16 },
  asks: {
    gap: spacing.sm,
    // The pill row pads itself so pills scroll to the screen's edge.
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  asksLabel: { paddingHorizontal: spacing.lg },
  toast: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: spacing.xxxl * 3,
    alignItems: "center",
  },
});
