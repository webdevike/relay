/**
 * An assistant thread's card stack (Relay ask cards, Isaac 2026-11-24): what needs Isaac (the
 * session's tool approval or ask form, the thread's open asks) and what runs for the thread, as one
 * stack of cards. Collapsed, it is a tab on the composer (`CardStackTab`, `ui/StackTab`) showing the
 * front card's title; tapped, the cards rise to the middle of the screen as a looping carousel
 * (`CardStackCarousel`, `ui/CardCarousel`). Cards come from the thread's data (`lib/stackCards.ts`);
 * the stack's lifecycle and front card are `cardStackMachine`, which holds ids only.
 *
 * `CardStackProvider` reads the host's activity and sessions itself, so their frequent frames
 * redraw the stack, never the thread around it. It wraps the thread; the tab sits in the composer
 * stack and the carousel over the screen.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Keyboard, StyleSheet, View } from "react-native";
import { useActorRef, useSelector } from "@xstate/react";
import type { ActorRefFrom, SnapshotFrom } from "xstate";
import { MAX_ASK_ANSWER, type AgentApproval, type AgentAsk, type OpenAsk } from "@relay/protocol";
import { runClock } from "@evaos/chat-core/card-stack";
import { cardStackMachine } from "./cardStack.machine";
import { AskCard, type AskAnswer } from "./AskCard";
import { ApprovalCard } from "./ApprovalCard";
import { VendorLogo } from "./VendorLogo";
import { Button } from "@/ui/Button";
import { CardCarousel, type CarouselCard } from "@/ui/CardCarousel";
import { useComposerFill } from "@/ui/ComposerPill";
import { IconButton } from "@/ui/IconButton";
import { OptionRow } from "@/ui/OptionRow";
import { RunLog, RunMeta } from "@/ui/RunLog";
import { StackCard } from "@/ui/StackCard";
import { StackTab, type StackTabAction } from "@/ui/StackTab";
import { Text } from "@/ui/Text";
import { TextField } from "@/ui/TextField";
import { runningCards, type RunningCard } from "@/lib/activity";
import { stackCards, type StackCard as Card } from "@/lib/stackCards";
import { useSecondClock } from "@/lib/useSecondClock";
import { useApprovalDecision } from "@/inbox/useApprovalDecision";
import { useActivityStore } from "@/state/activity";
import { ownedBy, useAgentsStore } from "@/state/agents";
import { spacing, useColors } from "@/theme";

/** A card's head row and the room around it, taken from the card's height cap for its body. */
const HEAD = 38;
/** Answers and buttons in a card are 44 pt touch targets at least (the prototype's 46 for options). */
const OPTION_HEIGHT = 46;
const TARGET = 44;

type Stack = SnapshotFrom<typeof cardStackMachine>;
const selectOpen = (state: Stack): boolean => state.matches("expanded");
const selectFront = (state: Stack): string | null => state.context.front;
const selectAnswered = (state: Stack): string | null => state.context.answered;

export interface CardStackProps {
  agent: string;
  /** The thread key activity items are owned by (`assistant:<id>`). */
  thread: string;
  /** The thread's omp session; null while it is not running. */
  sessionId: string | null;
  /** False while offline: nothing could reach the host, so questions take no answers. */
  connected: boolean;
  /** The tool call the session waits on Isaac to approve. */
  approval: AgentApproval | undefined;
  /** The omp ask form the session is blocked on, with its answer and cancel (`usePendingAsk`). */
  form: AgentAsk | undefined;
  onFormSubmit: (results: AskAnswer[]) => void;
  onFormCancel: () => void;
  /** The open asks to show (`visibleAsks`). */
  asks: readonly OpenAsk[];
  /** Answers an open ask (a thread ask also goes out as Isaac's turn). */
  onAnswer: (ask: OpenAsk, reply: string) => void;
  onDismiss: (ask: OpenAsk) => void;
  onOpenSession: (sessionId: string) => void;
  /** A running card with no session: the Artifacts sheet's Working group. */
  onOpenWorking: () => void;
  children: ReactNode;
}

interface StackValue {
  props: Omit<CardStackProps, "children">;
  cards: readonly Card[];
  actor: ActorRefFrom<typeof cardStackMachine>;
}

const StackContext = createContext<StackValue | null>(null);

function useStack(): StackValue {
  const value = useContext(StackContext);
  if (value === null) throw new Error("CardStackTab and CardStackCarousel need a CardStackProvider");
  return value;
}

export function CardStackProvider({ children, ...props }: CardStackProps) {
  const { agent, thread, sessionId, approval, form, asks } = props;
  const items = useActivityStore((state) => state.items);
  const sessions = useAgentsStore((state) => state.sessions);
  const owned = useMemo(() => ownedBy(sessions, agent), [sessions, agent]);
  const running = useMemo(() => runningCards(items, thread, { threadSession: sessionId, sessions }, owned), [items, thread, sessionId, sessions, owned]);
  const cards = useMemo(
    () => stackCards({ approval: sessionId === null || approval === undefined ? null : { sessionId, approval }, form: form ?? null, asks, running }),
    [sessionId, approval, form, asks, running],
  );
  const actor = useActorRef(cardStackMachine, { input: { loop: true } });
  const ids = cards.map((card) => card.id).join("\n");
  useEffect(() => {
    actor.send({ type: "cards.changed", ids: ids === "" ? [] : ids.split("\n") });
  }, [actor, ids]);
  return <StackContext.Provider value={{ props, cards, actor }}>{children}</StackContext.Provider>;
}

/** Open session on a running card: the stack closes, then its transcript (or the Working group) opens. */
function openRun(value: StackValue, run: RunningCard): void {
  value.actor.send({ type: "stack.collapse" });
  if (run.sessionId === undefined) value.props.onOpenWorking();
  else value.props.onOpenSession(run.sessionId);
}

/**
 * Marks card `id` answered here, then acts on the next frame: the carousel draws it once as the
 * answered card first, so when the answer takes it away it lifts up instead of fading as a card the
 * chat resolved would.
 */
function answerThen(value: StackValue, id: string, act: () => void): void {
  value.actor.send({ type: "card.answered", id });
  requestAnimationFrame(act);
}

/** Dismisses an open ask: it leaves upward, as an answered card does. */
function dismissAsk(value: StackValue, card: Extract<Card, { kind: "question" }>): void {
  answerThen(value, card.id, () => {
    value.props.onDismiss(card.ask);
  });
}

/** The tab on the composer: the front card's title; nothing when no card needs Isaac or runs. */
export function CardStackTab() {
  const value = useStack();
  const { cards, actor, props } = value;
  const front = useSelector(actor, selectFront);
  const open = useSelector(actor, selectOpen);
  const card = cards.find((entry) => entry.id === front) ?? cards[0];
  if (card === undefined) return null;
  const action: StackTabAction =
    card.kind === "running"
      ? { kind: "link", label: "Open session", onPress: () => { openRun(value, card.run); } }
      : card.kind === "question" && props.connected
        ? { kind: "open", onDismiss: () => { dismissAsk(value, card); }, dismissLabel: `Dismiss: ${card.title}` }
        : { kind: "open" };
  return (
    <StackTab
      faceKey={card.id}
      title={card.title}
      behind={cards.length - 1}
      open={open}
      action={action}
      accessibilityLabel={`${card.title}, ${cards.length === 1 ? "1 card" : `${String(cards.length)} cards`}`}
      onPress={() => {
        Keyboard.dismiss();
        actor.send({ type: "stack.open", id: card.id });
      }}
    />
  );
}

/** The open stack over the screen, while the machine says it is open. */
export function CardStackCarousel() {
  const value = useStack();
  const { cards, actor } = value;
  const open = useSelector(actor, selectOpen);
  const front = useSelector(actor, selectFront);
  const answered = useSelector(actor, selectAnswered);
  if (!open || cards.length === 0) return null;
  const actions = cards.length > 1 ? CAROUSEL_ACTIONS : CLOSE_ONLY;
  const onAction = (name: string): void => {
    if (name === "next") actor.send({ type: "stack.step", by: 1 });
    else if (name === "previous") actor.send({ type: "stack.step", by: -1 });
    else actor.send({ type: "stack.collapse" });
  };
  const items: CarouselCard[] = cards.map((card) => ({
    key: card.id,
    exit: answered === card.id ? "lift" : "fade",
    label: `Show ${card.title}`,
    content: (maxHeight) => <CardView value={value} card={card} maxHeight={maxHeight} actions={actions} onAction={onAction} />,
  }));
  return (
    <CardCarousel
      cards={items}
      front={Math.max(0, cards.findIndex((card) => card.id === front))}
      onStep={(by) => {
        actor.send({ type: "stack.step", by });
      }}
      onShow={(index) => {
        const card = cards[index];
        if (card !== undefined) actor.send({ type: "stack.show", id: card.id });
      }}
      onCollapse={() => {
        Keyboard.dismiss();
        actor.send({ type: "stack.collapse" });
      }}
    />
  );
}

const CAROUSEL_ACTIONS = [
  { name: "next", label: "Next card" },
  { name: "previous", label: "Previous card" },
  { name: "close", label: "Close cards" },
] as const;
const CLOSE_ONLY = [{ name: "close", label: "Close cards" }] as const;

function CardView({ value, card, maxHeight, actions, onAction }: { value: StackValue; card: Card; maxHeight: number; actions: readonly { name: string; label: string }[]; onAction: (name: string) => void }) {
  const colors = useColors();
  const { props } = value;
  const answer = (act: () => void): void => {
    answerThen(value, card.id, act);
  };
  const body = maxHeight - HEAD;
  const head = { title: card.title, maxHeight, actions, onAction };
  switch (card.kind) {
    case "approval":
      return (
        <StackCard symbol="lock.shield" {...head}>
          <ApprovalBody sessionId={card.sessionId} approval={card.approval} maxHeight={body} decide={answer} />
        </StackCard>
      );
    case "form":
      return (
        <StackCard symbol="list.bullet" {...head}>
          <AskCard
            key={card.ask.id}
            ask={card.ask}
            embedded={{ maxHeight: body }}
            onSubmit={(results) => {
              answer(() => {
                props.onFormSubmit(results);
              });
            }}
            onCancel={() => {
              answer(props.onFormCancel);
            }}
          />
        </StackCard>
      );
    case "question":
      return (
        <StackCard
          symbol={card.ask.replies.length > 0 ? "list.bullet" : "pencil"}
          onDismiss={props.connected ? () => { dismissAsk(value, card); } : undefined}
          dismissLabel={`Dismiss: ${card.title}`}
          {...head}
        >
          <QuestionBody
            detail={card.detail}
            ask={card.ask}
            connected={props.connected}
            onAnswer={(reply) => {
              answer(() => {
                props.onAnswer(card.ask, reply);
              });
            }}
          />
        </StackCard>
      );
    case "running":
      return (
        <StackCard symbol={card.run.waiting ? "hand.raised" : "waveform.path.ecg"} symbolTint={card.run.waiting ? colors.warn : undefined} {...head}>
          <RunningBody
            run={card.run}
            onOpen={() => {
              openRun(value, card.run);
            }}
          />
        </StackCard>
      );
  }
}

/** The session's tool approval: Face ID for a destructive call, then `agent.approve`; a decision lets the card lift away once the host clears it. */
function ApprovalBody({ sessionId, approval, maxHeight, decide }: { sessionId: string; approval: AgentApproval; maxHeight: number; decide: (act: () => void) => void }) {
  const decision = useApprovalDecision(sessionId, approval);
  return (
    <ApprovalCard
      approval={approval}
      busy={decision.busy}
      error={decision.error}
      embedded={{ maxHeight }}
      onApprove={() => {
        decide(decision.approve);
      }}
      onDeny={() => {
        decide(decision.deny);
      }}
    />
  );
}

/** An open ask: its detail, its answers as rows and a field for another; with no answers, a field and Send answer. */
function QuestionBody({ detail, ask, connected, onAnswer }: { detail: string | null; ask: OpenAsk; connected: boolean; onAnswer: (reply: string) => void }) {
  const colors = useColors();
  const fill = useComposerFill();
  const [draft, setDraft] = useState("");
  const typed = draft.trim();
  const send = (): void => {
    if (typed !== "") onAnswer(typed.slice(0, MAX_ASK_ANSWER));
  };
  const free = ask.replies.length === 0;
  return (
    <View style={styles.body}>
      {detail !== null && (
        <Text color="textMuted" style={styles.detail}>
          {detail}
        </Text>
      )}
      {!free && (
        <View style={styles.options}>
          {ask.replies.map((reply) => (
            <OptionRow
              key={reply}
              label={reply}
              selected={false}
              disabled={!connected}
              minHeight={OPTION_HEIGHT}
              fill={fill}
              onPress={() => {
                onAnswer(reply);
              }}
            />
          ))}
        </View>
      )}
      {free ? (
        <View style={styles.typed}>
          <TextField value={draft} onChangeText={setDraft} placeholder="Type an answer" multiline editable={connected} maxLength={MAX_ASK_ANSWER} minHeight={64} fill={fill} accessibilityLabel={`Answer: ${ask.question}`} />
          <Button label="Send answer" height={TARGET} disabled={!connected || typed === ""} onPress={send} />
        </View>
      ) : (
        <View style={styles.other}>
          <TextField
            value={draft}
            onChangeText={setDraft}
            placeholder="Or type an answer"
            editable={connected}
            onSubmit={send}
            maxLength={MAX_ASK_ANSWER}
            minHeight={TARGET}
            fill={fill}
            accessibilityLabel={`Another answer: ${ask.question}`}
            trailing={
              <IconButton
                symbol="arrow.up"
                size={28}
                glyphSize={13}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                disabled={!connected || typed === ""}
                backgroundColor={typed === "" ? "transparent" : colors.accent}
                tintColor={typed === "" ? colors.textMuted : "#FFFFFF"}
                accessibilityLabel="Send answer"
                onPress={send}
              />
            }
          />
        </View>
      )}
    </View>
  );
}

/** A running session: its clock, model and recent work, and Open session. No dismiss: it goes when it stops. */
function RunningBody({ run, onOpen }: { run: RunningCard; onOpen: () => void }) {
  const now = useSecondClock(run.startedAt !== undefined);
  return (
    <View style={styles.body}>
      <View style={styles.runHead}>
        <RunMeta clock={run.startedAt === undefined ? null : runClock(now - run.startedAt)} logo={run.vendor === null ? null : <VendorLogo vendor={run.vendor} size={13} />} model={run.model} />
      </View>
      <RunLog lines={run.work} />
      <View style={styles.open}>
        <Button label="Open session" variant="secondary" height={TARGET} accessibilityLabel={`Open session: ${run.title}`} onPress={onOpen} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  detail: { marginTop: spacing.xs },
  options: { marginTop: spacing.md, gap: 6 },
  other: { marginTop: 10 },
  typed: { marginTop: spacing.md, gap: spacing.sm },
  runHead: { marginTop: spacing.xs },
  open: { marginTop: spacing.md },
});
