/**
 * One meeting (`/meetings/<id>`). A recording Relay made, as the desktop Meeting tab shows it: the
 * title, a meta line (app, Live and how long so far, End meeting; the clock span once ended) and
 * underline tabs. Live: Now (who is talking, what they just said, the latest moments), Transcript
 * (follows the newest line until scrolled up; Jump to live resumes) and Moments (decisions,
 * actions and questions to Isaac from `detectMoments`; a tap lights its line in the transcript).
 * Ended: Summary leads (what waits on Isaac, actions, what was decided), then the same two.
 *
 * Opened from an assistant's meeting card (`?chat=<agent>`) it is that chat's full-screen meeting
 * view: one Ask control opens the three asks, and the picked one posts into that chat as Isaac's
 * turn (the host gives the assistant the transcript) and goes back to it; nothing is answered
 * here. Opened elsewhere, Ask is a question to Astra's session about the meeting (typed, or held
 * to talk), answered under Now or Summary and on the desktop too.
 *
 * A meeting Eva filed (a stem): its summary, decisions and what waits on Isaac.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  detectMoments,
  meetingIsLive,
  meetingRows,
  type MeetingDetail,
  type MeetingMoment,
} from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { meetingsRequest, sendCommand } from "@/connection";
import { DictationButton } from "@/dictation";
import { pushDictationTarget } from "@/dictation/deliver";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { recordingTitle, useMeetingsStore } from "@/state/meetings";
import { agentTitle, useAssistantStore } from "@/state/assistant";
import { newClientId, startTurn } from "@/state/turns";
import { AskMenu } from "@/meetings/AskMenu";
import { LiveCaret, MomentRow, TranscriptRow } from "@/meetings/MeetingRows";
import {
  blueRows,
  initialPanel,
  jumpVisible,
  meetingMeta,
  meetingTabs,
  momentScrollY,
  momentWho,
  nearBottom,
  newestFirst,
  nowView,
  panelReducer,
  rowSpeaker,
  summarySections,
} from "@/meetings/panel";
import { radii, spacing, tabularNumbers, useColors, useScheme } from "@/theme";
import { Button } from "@/ui/Button";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { Toast } from "@/ui/Toast";
import { UnderlineTabs } from "@/ui/UnderlineTabs";

const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long a moment's line stays lit after the jump. */
const HIGHLIGHT_MS = 2200;
/** The live meta line counts minutes; this refreshes it (and "20 min ago") often enough. */
const TICK_MS = 15_000;

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
  const [panel, dispatch] = useReducer(panelReducer, live, initialPanel);
  useEffect(() => {
    // The call started showing or ended under the view: it leads with Now, or with Summary.
    dispatch({ type: "lead", live });
  }, [live]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [live]);
  const lines = page?.lines;
  const rows = useMemo(() => meetingRows(lines ?? []), [lines]);
  const moments = useMemo(() => detectMoments(lines ?? []), [lines]);
  const blue = useMemo(() => blueRows(rows, moments), [rows, moments]);

  // The transcript: where each row sits, its viewport, and the moment row waiting to be shown
  // once both are measured (the transcript mounts with the jump).
  const transcript = useRef<ScrollView>(null);
  const rowY = useRef(new Map<string, number>());
  const viewport = useRef(0);
  const pendingJump = useRef<string | null>(null);
  const dragging = useRef(false);
  const showPendingJump = useCallback(() => {
    const target = pendingJump.current;
    const y = target === null ? undefined : rowY.current.get(target);
    if (y === undefined || viewport.current === 0) return;
    pendingJump.current = null;
    transcript.current?.scrollTo({ y: momentScrollY(y, viewport.current), animated: false });
  }, []);
  const openMoment = useCallback((m: MeetingMoment) => {
    pendingJump.current = m.rowId;
    dispatch({ type: "moment", rowId: m.rowId });
  }, []);
  useEffect(() => {
    if (panel.tab === "transcript") return;
    rowY.current.clear();
    viewport.current = 0;
  }, [panel.tab]);
  useEffect(() => {
    const lit = panel.highlight;
    if (lit === null) return;
    const timer = setTimeout(() => {
      dispatch({ type: "unhighlight", rowId: lit });
    }, HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [panel.highlight]);

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
  const meta = meetingMeta(r, live, now);
  const turns = page.astra?.turns.filter((t) => t.role !== "tool") ?? [];
  const momentRow = (m: MeetingMoment) => (
    <MomentRow
      key={m.id}
      moment={m}
      who={momentWho(m, live, now, r.startedAt)}
      onPress={() => {
        openMoment(m);
      }}
    />
  );
  // Opened outside a chat, Astra's answers sit under Now or Summary.
  const astra =
    chat === undefined && (turns.length > 0 || page.astra?.working === true) ? (
      <View style={styles.section}>
        <Text variant="caption" color="textMuted" style={styles.label}>
          Astra
        </Text>
        {turns.map((t) =>
          t.role === "user" ? (
            <Text key={t.id} variant="label">
              {t.text}
            </Text>
          ) : (
            <MessageText key={t.id} text={t.text} streaming={t.streaming} />
          ),
        )}
        {page.astra?.working === true ? <Text color="textMuted">Astra is thinking…</Text> : null}
        {page.astra?.error != null ? <Text color="danger">{page.astra.error}</Text> : null}
      </View>
    ) : null;

  let body;
  if (panel.tab === "now") {
    const current = nowView(rows);
    const latest = newestFirst(moments, 3);
    body = (
      <ScrollView key="now" contentContainerStyle={styles.tabBody}>
        {current === null ? (
          <Text color="textMuted">Listening. Lines show up a moment after someone speaks.</Text>
        ) : (
          <>
            <Text variant="caption" color="textMuted" style={styles.who} testID="meeting-speaker">
              {rowSpeaker(current.current)}
            </Text>
            <Text style={styles.say}>
              {current.current.text}
              <LiveCaret />
            </Text>
            {current.before !== null ? (
              <Text color="textMuted" style={styles.before}>
                Before that, {rowSpeaker(current.before)}: {current.before.text}
              </Text>
            ) : null}
          </>
        )}
        {latest.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" color="textMuted" style={styles.label}>
              Moments
            </Text>
            {latest.map(momentRow)}
          </View>
        ) : null}
        {astra}
      </ScrollView>
    );
  } else if (panel.tab === "summary") {
    const s = summarySections(r, moments, page.notes);
    body = (
      <ScrollView key="summary" contentContainerStyle={styles.tabBody} testID="meeting-summary">
        {s.paragraphs.map((p, i) => (
          <Text key={i} style={styles.paragraph}>
            {p}
          </Text>
        ))}
        {s.status !== null ? (
          <Text color={s.status.failed ? "danger" : "textMuted"} testID="meeting-stage">
            {s.status.text}
          </Text>
        ) : null}
        {s.forYou.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" color="textMuted" style={styles.label}>
              For you
            </Text>
            {s.forYou.map(({ moment, detail }) => (
              <Pressable
                key={moment.id}
                testID="meeting-moment"
                accessibilityRole="button"
                onPress={() => {
                  openMoment(moment);
                }}
                style={styles.item}
              >
                <Text color="accent" style={styles.yours}>
                  {moment.text}
                </Text>
                <Text variant="caption" color="textMuted">
                  {detail}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {s.actions.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" color="textMuted" style={styles.label}>
              Actions
            </Text>
            {s.actions.map((m) => (
              <Pressable
                key={m.id}
                testID="meeting-moment"
                accessibilityRole="button"
                onPress={() => {
                  openMoment(m);
                }}
                style={[styles.item, styles.action]}
              >
                <Text style={styles.fill}>{m.text}</Text>
                <Text variant="caption" color="textMuted">
                  {m.speaker}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {s.decided.length > 0 ? (
          <View style={styles.section}>
            <Text variant="caption" color="textMuted" style={styles.label}>
              Decided
            </Text>
            {s.decided.map((d, i) => (
              <Text key={i} style={styles.item}>
                {d}
              </Text>
            ))}
          </View>
        ) : null}
        {astra}
      </ScrollView>
    );
  } else if (panel.tab === "moments") {
    body = (
      <ScrollView key="moments" contentContainerStyle={styles.tabBody}>
        {moments.length === 0 ? (
          <Text variant="caption" color="textMuted">
            Nothing yet.
          </Text>
        ) : (
          newestFirst(moments).map(momentRow)
        )}
      </ScrollView>
    );
  } else {
    body = (
      <ScrollView
        key="transcript"
        ref={transcript}
        testID="meeting-transcript"
        contentContainerStyle={styles.tabBody}
        onLayout={(e) => {
          viewport.current = e.nativeEvent.layout.height;
          showPendingJump();
        }}
        onContentSizeChange={() => {
          if (panel.follow) transcript.current?.scrollToEnd({ animated: false });
        }}
        onScrollBeginDrag={() => {
          dragging.current = true;
        }}
        onScrollEndDrag={() => {
          dragging.current = false;
        }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const atBottom = nearBottom(contentSize.height, contentOffset.y, layoutMeasurement.height);
          // Only Isaac's own drag pauses following; the view's scrolls (to the end, to a moment)
          // never do, and reaching the bottom any way resumes it.
          if (atBottom || dragging.current) dispatch({ type: "scrolled", atBottom });
        }}
        scrollEventThrottle={100}
      >
        {rows.length === 0 ? (
          <Text color="textMuted">
            {live ? "Listening. Lines show up a moment after someone speaks." : "Nothing was transcribed."}
          </Text>
        ) : null}
        {rows.map((row) => (
          <TranscriptRow
            key={row.id}
            row={row}
            blue={blue.has(row.id)}
            lit={panel.highlight === row.id}
            onLayout={(e) => {
              rowY.current.set(row.id, e.nativeEvent.layout.y);
              if (pendingJump.current === row.id) showPendingJump();
            }}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.fill}
        keyboardVerticalOffset={90}
      >
        <View style={styles.fill} testID="meeting-tab">
          <View style={styles.head}>
            <Text variant="title">{recordingTitle(r)}</Text>
            <View style={styles.metaLine}>
              <Text variant="caption" color="textMuted" style={tabularNumbers} testID="meeting-tab-when">
                {meta.app} · {meta.live ? <Text variant="caption" color="danger">Live</Text> : meta.span} ·{" "}
                {meta.length}
              </Text>
              {live ? (
                <Pressable
                  accessibilityRole="button"
                  testID="meeting-end"
                  hitSlop={8}
                  onPress={() => {
                    void meetingsRequest({ kind: "stop", id }).then((res) => {
                      if (!res.ok) toast.show(res.error ?? "Could not end it.");
                    });
                  }}
                >
                  {({ pressed }) => (
                    <Text variant="caption" color={pressed ? "text" : "textMuted"}>
                      End meeting
                    </Text>
                  )}
                </Pressable>
              ) : null}
            </View>
            {live && r.health !== "ok" ? (
              <Text variant="caption" color="danger" testID="meeting-stage">
                {r.healthDetail}
              </Text>
            ) : null}
          </View>
          <UnderlineTabs
            tabs={meetingTabs(live)}
            value={panel.tab}
            onChange={(tab) => {
              dispatch({ type: "tab", tab });
            }}
            testID="meeting-tabs"
            testIDPrefix="meeting-tab-"
            barColor="accent"
          />
          <View style={styles.fill}>
            {body}
            {jumpVisible(panel, live) ? (
              <View style={styles.jumpRow} pointerEvents="box-none">
                <Pressable
                  accessibilityRole="button"
                  testID="meeting-jump-live"
                  onPress={() => {
                    dispatch({ type: "jumpLive" });
                    transcript.current?.scrollToEnd({ animated: true });
                  }}
                  style={({ pressed }) => [styles.jump, { backgroundColor: colors.text, opacity: pressed ? 0.8 : 1 }]}
                >
                  <Text variant="caption" style={{ color: colors.bg }}>
                    Jump to live
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
        {chat !== undefined ? (
          <View style={styles.ask}>
            <AskMenu assistant={agentTitle(agents, chat)} onAsk={(text) => void ask(text)} />
          </View>
        ) : (
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
        )}
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
  actions: { flexDirection: "row", gap: spacing.sm, paddingTop: spacing.xs },
  block: { gap: spacing.sm, paddingTop: spacing.lg },
  line: { gap: 2 },
  head: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.md, gap: 3 },
  metaLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  // The tabs' bodies line up with the tab labels.
  tabBody: { paddingHorizontal: spacing.xl, paddingTop: spacing.xxl, paddingBottom: spacing.xxxl },
  who: { marginBottom: spacing.xs },
  say: { fontSize: 19, lineHeight: 27 },
  before: { fontSize: 13, lineHeight: 19, marginTop: 14 },
  section: { marginTop: spacing.xxxl },
  label: { marginBottom: spacing.sm },
  paragraph: { lineHeight: 23, marginBottom: spacing.sm },
  item: { paddingVertical: 5 },
  action: { flexDirection: "row", alignItems: "baseline", gap: spacing.md },
  yours: { fontWeight: "500" },
  jumpRow: { position: "absolute", left: 0, right: 0, bottom: spacing.md, alignItems: "center" },
  jump: { paddingHorizontal: 13, paddingVertical: 6, borderRadius: radii.lg },
  ask: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.md },
  dock: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, minHeight: 40, borderRadius: 20, paddingHorizontal: spacing.md, fontSize: 16 },
  toast: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: spacing.xxxl * 3,
    alignItems: "center",
  },
});
