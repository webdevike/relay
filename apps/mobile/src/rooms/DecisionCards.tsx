/**
 * A chat room's decision cards on the phone (Relay Desktop draws the same cards in the room):
 * a poll with its tally (tap an option to vote), pros and cons stacked, a question for Isaac
 * with one-tap answers, and the decision record with Accept, an alternative instead, or Reopen.
 * The cards ride on room frames on any host; their buttons show only when the host relays the
 * actions (ROOMS_DECIDE_FEATURE), so `actions` is null otherwise.
 */
import { Pressable, View } from "react-native";
import type { RoomsCmd, RoomWire, RoomWireCard } from "@relay/protocol";
import { spacing, toneFill, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { ProgressBar } from "@/ui/ProgressBar";
import { Text } from "@/ui/Text";
import { authorOf, pollRows } from "./model";
import { Block, TAP, Tag } from "./primitives";
import { RequestNote } from "./RequestNote";
import { useRoomsAction, type RoomsAction } from "./useRoomsAction";

export type DecisionWireCard = Extract<RoomWireCard, { type: "poll" | "proscons" | "question" | "decision" }>;

export const isDecisionWireCard = (card: RoomWireCard | undefined): card is DecisionWireCard =>
  card !== undefined && (card.type === "poll" || card.type === "proscons" || card.type === "question" || card.type === "decision");

/** The commands Isaac's taps on a card send (`cardId`: the card's message); the card runs them through its request machine. */
export interface DecisionActions {
  vote: (cardId: string, option: string | null) => RoomsCmd;
  callPoll: (cardId: string) => RoomsCmd;
  reopenPoll: (cardId: string) => RoomsCmd;
  answer: (cardId: string, answer: string) => RoomsCmd;
  decide: (cardId: string, action: "accept" | "override" | "reopen", option?: string) => RoomsCmd;
}

type Of<T extends DecisionWireCard["type"]> = Extract<DecisionWireCard, { type: T }>;

/** One action at a time per card, busy until the card shows it took effect; its refusal or Not confirmed shows under the card. */
function useCardAction(card: DecisionWireCard): RoomsAction & { blocked: boolean } {
  const action = useRoomsAction(JSON.stringify(card));
  return { ...action, blocked: action.busy !== null || action.unconfirmed !== null };
}

const names = (room: RoomWire, ids: readonly string[]): string => ids.map((id) => authorOf(room, id).name).join(", ");

function PollCard({ room, card, actions }: { room: RoomWire; card: Of<"poll">; actions: DecisionActions | null }) {
  const action = useCardAction(card);
  const rows = pollRows(card);
  const voters = (room.chat?.setup.members.length ?? 0) + 1;
  const voted = Object.keys(card.votes).length;
  const called = card.state === "called";
  return (
    <Block>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="title" style={{ flex: 1 }}>{card.question}</Text>
        {called ? <Tag label="Decided" tone="ok" /> : <Text variant="label" color="textMuted" tabular>{`${String(voted)} of ${String(voters)}`}</Text>}
      </View>
      <View style={{ gap: spacing.xs }}>
        {rows.map((r) => (
          <Pressable
            key={r.id}
            accessibilityRole="button"
            accessibilityState={{ selected: r.mine, disabled: called || actions === null }}
            accessibilityLabel={r.mine ? `Take back your vote for ${r.label}` : `Vote for ${r.label}`}
            disabled={called || actions === null || action.blocked}
            onPress={() => { if (actions !== null) action.run(r.id, actions.vote(card.id, r.mine ? null : r.id)); }}
            style={({ pressed }) => ({ minHeight: TAP, justifyContent: "center", gap: spacing.xs, opacity: r.state === "lose" ? 0.5 : pressed ? 0.7 : 1 })}
          >
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
              <Text variant="body" style={{ flex: 1, fontWeight: r.mine || r.state === "win" ? "700" : "400" }}>{r.label}</Text>
              <Text variant="label" color="textMuted" tabular>{String(r.voters.length)}</Text>
            </View>
            <ProgressBar fraction={voters > 0 ? r.voters.length / voters : 0} tone={r.state === "win" ? "ok" : r.state === "lead" ? "accent" : "textMuted"} />
            {r.voters.length > 0 && <Text variant="label" color="textMuted">{names(room, r.voters)}</Text>}
          </Pressable>
        ))}
      </View>
      {actions !== null && (
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {called ? (
            <Button label="Reopen the vote" variant="secondary" height={TAP} loading={action.busy === "reopen"} disabled={action.blocked} onPress={() => { action.run("reopen", actions.reopenPoll(card.id)); }} />
          ) : (
            <Button label="Call it" variant="secondary" height={TAP} loading={action.busy === "call"} disabled={action.blocked || voted === 0} onPress={() => { action.run("call", actions.callPoll(card.id)); }} />
          )}
        </View>
      )}
      <RequestNote action={action} />
      {called && card.called !== undefined && (
        <Text variant="label" color="textMuted">{`Called by ${authorOf(room, card.called.by).name}`}</Text>
      )}
    </Block>
  );
}

function ProsConsCard({ room, card }: { room: RoomWire; card: Of<"proscons"> }) {
  const disputed = [...card.pros, ...card.cons].filter((p) => p.state === "disputed").length;
  const side = (title: string, points: Of<"proscons">["pros"]) => (
    <View style={{ gap: spacing.sm }}>
      <Text variant="label" color="textMuted">{title}</Text>
      {points.map((p) => (
        <View key={p.text} style={{ gap: 2 }}>
          <Text variant="body">{p.text}</Text>
          <Text variant="label" color={p.state === "disputed" ? "warn" : "textMuted"}>
            {[p.by.length > 0 ? names(room, p.by) : "", p.state === "disputed" ? `disputed by ${names(room, p.against ?? [])}` : ""].filter((s) => s !== "").join(" · ")}
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <Block>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="title" style={{ flex: 1 }}>{card.subject}</Text>
        {disputed > 0 && <Tag label={`${String(disputed)} disputed`} tone="warn" />}
      </View>
      {card.pros.length > 0 && side("For", card.pros)}
      {card.cons.length > 0 && side("Against", card.cons)}
    </Block>
  );
}

function QuestionCard({ room, card, actions }: { room: RoomWire; card: Of<"question">; actions: DecisionActions | null }) {
  const colors = useColors();
  const action = useCardAction(card);
  if (card.answered !== undefined) {
    return (
      <Text variant="label" color="textMuted">{`${authorOf(room, card.by).name} asked: ${card.text} You: ${card.answered}`}</Text>
    );
  }
  return (
    <Block style={{ backgroundColor: toneFill(colors, "accent", 0.1), borderColor: colors.accent }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="title" style={{ flex: 1 }}>{card.text}</Text>
        <Tag label="For you" tone="accent" />
      </View>
      {card.sub !== undefined && <Text variant="label" color="textMuted">{card.sub}</Text>}
      {actions !== null && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {card.answers.map((a) => (
            <Button key={a} label={a} variant="secondary" height={TAP} loading={action.busy === a} disabled={action.blocked} onPress={() => { action.run(a, actions.answer(card.id, a)); }} />
          ))}
        </View>
      )}
      <RequestNote action={action} />
    </Block>
  );
}

function DecisionCard({ room, card, actions }: { room: RoomWire; card: Of<"decision">; actions: DecisionActions | null }) {
  const colors = useColors();
  const action = useCardAction(card);
  const proposed = card.state === "proposed";
  return (
    <Block style={proposed ? { backgroundColor: toneFill(colors, "accent", 0.1), borderColor: colors.accent } : undefined}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="title" style={{ flex: 1 }}>{card.title}</Text>
        {proposed ? <Tag label="Your call" tone="accent" /> : <Tag label={card.state === "accepted" ? "Accepted" : card.state === "overridden" ? "Your call" : "Reopened"} tone={card.state === "reopened" ? "textMuted" : "ok"} />}
      </View>
      {card.why !== "" && <Text variant="body" color="textMuted">{card.why}</Text>}
      <Text variant="label" color="textMuted">
        {[
          card.agree.length > 0 ? `Agree: ${names(room, card.agree)}` : "",
          ...card.dissent.map((d) => `${authorOf(room, d.by).name} dissents${d.note === undefined ? "" : `: ${d.note}`}`),
        ].filter((s) => s !== "").join(" · ")}
      </Text>
      {card.next !== undefined && (
        <Text variant="label">{`Next: ${card.next.who === undefined ? "" : `${authorOf(room, card.next.who).name}, `}${card.next.text}`}</Text>
      )}
      {actions !== null && proposed && (
        <View style={{ gap: spacing.sm }}>
          <Button label="Accept" height={TAP} loading={action.busy === "accept"} disabled={action.blocked} onPress={() => { action.run("accept", actions.decide(card.id, "accept")); }} />
          {card.alternatives.map((a) => (
            <Button key={a.id} label={`${a.label} instead`} variant="secondary" height={TAP} loading={action.busy === a.id} disabled={action.blocked} onPress={() => { action.run(a.id, actions.decide(card.id, "override", a.id)); }} />
          ))}
          <Button label="Reopen" variant="ghost" height={TAP} loading={action.busy === "reopen"} disabled={action.blocked} onPress={() => { action.run("reopen", actions.decide(card.id, "reopen")); }} />
        </View>
      )}
      {actions !== null && !proposed && card.state !== "reopened" && (
        <View style={{ alignItems: "flex-start" }}>
          <Button label="Reopen" variant="secondary" height={TAP} loading={action.busy === "reopen"} disabled={action.blocked} onPress={() => { action.run("reopen", actions.decide(card.id, "reopen")); }} />
        </View>
      )}
      <RequestNote action={action} />
    </Block>
  );
}

export function DecisionCardView({ room, card, actions }: { room: RoomWire; card: DecisionWireCard; actions: DecisionActions | null }) {
  switch (card.type) {
    case "poll":
      return <PollCard room={room} card={card} actions={actions} />;
    case "proscons":
      return <ProsConsCard room={room} card={card} />;
    case "question":
      return <QuestionCard room={room} card={card} actions={actions} />;
    case "decision":
      return <DecisionCard room={room} card={card} actions={actions} />;
  }
}
