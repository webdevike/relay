/**
 * Catch Up (`/catch-up`): the things that need Isaac, one card at a time, like Slack's Catch Up.
 * Throw a card right (or tap Mark as Read) and the host marks it read; throw it left (Keep Unread)
 * and it stays unread but goes to the back of this session's deck. Throw it up (from its header,
 * or anywhere on a short card), or tap the purple send button, and it goes to its assistant (Astra
 * for eCard work, Nova for the rest); a long press opens a sheet to pick the assistant and add a
 * note. A card an assistant bounced comes back first, with its reason. The note button on a card opens
 * a sheet where Isaac says why it does or doesn't need him (chips and/or text); the note goes to Nova,
 * who teaches the feed what is worth a card, and the card stays in the deck. The host owns the cards and
 * their state (`useCatchUpStore`); the screen asks again on focus.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import type { CatchUpCard } from "@relay/protocol";
import { CATCHUP_CARD_RADIUS, CatchUpCardView } from "@/catchup/CatchUpCardView";
import { HandoffSheet, type HandoffTarget } from "@/catchup/HandoffSheet";
import { NoteSheet } from "@/catchup/NoteSheet";
import { handoffCatchUp, markCatchUp, noteCatchUp, requestCatchUp } from "@/connection";
import { deckCards, defaultAssistant } from "@/lib/catchup";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { agentTitle, useAssistantStore } from "@/state/assistant";
import { useCatchUpStore } from "@/state/catchup";
import { useConnectionStore } from "@/state/connection";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { SwipeActionOverlay } from "@/ui/SwipeActionOverlay";
import { SwipeDeck, type SwipeDeckHandle } from "@/ui/SwipeDeck";
import { STACK_DROP, type SwipeDirection } from "@/ui/swipeDeckModel";
import { Text } from "@/ui/Text";
import { Toast } from "@/ui/Toast";
import { spacing, useColors } from "@/theme";

const BUTTON_HEIGHT = 52;
/** Who a card can go to before the host has listed its assistants. */
const FALLBACK_TARGETS: readonly HandoffTarget[] = [
  { id: "astra", title: "Astra", scope: "eCard Systems work" },
  { id: "nova", title: "Nova", scope: "Everything personal" },
];

export default function CatchUp() {
  const colors = useColors();
  const router = useRouter();
  const items = useCatchUpStore((state) => state.items);
  const deferred = useCatchUpStore((state) => state.deferred);
  const defer = useCatchUpStore((state) => state.defer);
  const agents = useAssistantStore((state) => state.agents);
  const connected = useConnectionStore((state) => state.status === "connected");
  const deck = useRef<SwipeDeckHandle>(null);
  const cards = items === null ? [] : deckCards(items, deferred);
  const top = cards[0];
  // The sheet's choice for the card it was opened on, used by the throw that follows. The throw's
  // callback was made before the choice, so it reads the ref; the overlay's label reads the state.
  const chosen = useRef<{ id: string; agent: string; note: string } | null>(null);
  const [choice, setChoice] = useState<{ id: string; agent: string } | null>(null);
  const [sheetCard, setSheetCard] = useState<CatchUpCard | null>(null);
  const [noteCard, setNoteCard] = useState<CatchUpCard | null>(null);
  const toast = useTransientMessage();
  const showToast = toast.show;
  const targets: readonly HandoffTarget[] =
    agents === null || agents.length === 0
      ? FALLBACK_TARGETS
      : agents.map((agent) => ({ id: agent.id, title: agent.title, scope: agent.scope, avatar: agent.avatar, portrait: agent.portrait, status: agent.status }));
  const titleOf = (agent: string): string => agentTitle(agents, agent).replace(/^./, (letter) => letter.toUpperCase());
  const upAgent = top === undefined ? null : choice?.id === top.id ? choice.agent : defaultAssistant(top);

  useFocusEffect(
    useCallback(() => {
      requestCatchUp();
    }, []),
  );

  const openSheet = useCallback((card: CatchUpCard) => {
    setSheetCard(card);
  }, []);

  const openNote = useCallback((card: CatchUpCard) => {
    setNoteCard(card);
  }, []);

  // Each host answer to a note while the screen is up (not one left from an earlier visit).
  useEffect(
    () =>
      useCatchUpStore.subscribe((state, previous) => {
        if (state.noteAnswer !== null && state.noteAnswer !== previous.noteAnswer) showToast(state.noteAnswer.ok ? "Noted for Nova" : "Note not saved");
      }),
    [showToast],
  );

  const onSwipe = (card: CatchUpCard, direction: SwipeDirection) => {
    if (direction === "right") markCatchUp(card.id, true);
    else if (direction === "left") defer(card.id);
    else {
      const pick = chosen.current?.id === card.id ? chosen.current : null;
      chosen.current = null;
      setChoice(null);
      const agent = pick?.agent ?? defaultAssistant(card);
      if (handoffCatchUp(card.id, agent, pick?.note)) toast.show(`Handed to ${titleOf(agent)}`);
      else {
        // Only the host can deliver it: keep the card for when the phone is back.
        defer(card.id);
        toast.show("Not connected: kept for later");
      }
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <IconButton
          symbol="chevron.left"
          accessibilityLabel="Back"
          backgroundColor="transparent"
          onPress={() => {
            router.back();
          }}
        />
        <Text variant="title" tabular>
          {items === null ? "Catch Up" : `${String(cards.length)} Left`}
        </Text>
      </View>
      {cards.length === 0 ? (
        <EmptyState
          symbol={items === null ? "rectangle.stack" : "checkmark.circle"}
          title={items === null ? (connected ? "Loading…" : "Not connected") : "All caught up"}
          body={
            items === null
              ? connected
                ? "Asking your Mac for what needs you."
                : "Catch Up comes from your Mac; connect to it to see what needs you."
              : "Nothing new needs you right now."
          }
        />
      ) : (
        <>
          <View style={styles.deck}>
            <SwipeDeck
              ref={deck}
              items={cards}
              keyOf={(card) => card.id}
              canSwipeUp={() => true}
              onLongPress={openSheet}
              renderCard={(card) => <CatchUpCardView card={card} onNote={openNote} />}
              renderOverlay={(signals) => (
                <>
                  <SwipeActionOverlay side="right" signals={signals} color={colors.ok} symbol="checkmark" label="Mark as Read" radius={CATCHUP_CARD_RADIUS} />
                  <SwipeActionOverlay side="left" signals={signals} color={colors.accent} symbol="eye.slash" label="Keep Unread" radius={CATCHUP_CARD_RADIUS} />
                  {upAgent !== null && (
                    <SwipeActionOverlay
                      side="up"
                      signals={signals}
                      color={colors.handoff}
                      initial={titleOf(upAgent).charAt(0)}
                      label={`Send to ${titleOf(upAgent)}`}
                      radius={CATCHUP_CARD_RADIUS}
                    />
                  )}
                </>
              )}
              onSwipe={onSwipe}
            />
            {toast.message !== null && (
              <View style={styles.toast} pointerEvents="none">
                <Toast message={toast.message} />
              </View>
            )}
          </View>
          <View style={styles.actions}>
            <View style={styles.flex}>
              <Button
                label="Keep Unread"
                variant="secondary"
                height={BUTTON_HEIGHT}
                onPress={() => {
                  deck.current?.swipe("left");
                }}
              />
            </View>
            <IconButton
              symbol="paperplane.fill"
              size={BUTTON_HEIGHT}
              backgroundColor={colors.handoff}
              tintColor="#FFFFFF"
              accessibilityLabel={upAgent === null ? "Hand off" : `Send to ${titleOf(upAgent)}`}
              onPress={() => {
                deck.current?.swipe("up");
              }}
            />
            <View style={styles.flex}>
              <Button
                label="Mark as Read"
                tone="ok"
                height={BUTTON_HEIGHT}
                onPress={() => {
                  deck.current?.swipe("right");
                }}
              />
            </View>
          </View>
        </>
      )}
      <HandoffSheet
        card={sheetCard}
        targets={targets}
        onClose={() => {
          setSheetCard(null);
        }}
        onSend={(card, agent, note) => {
          setSheetCard(null);
          chosen.current = { id: card.id, agent, note };
          setChoice({ id: card.id, agent });
          // The sheet opens on the top card, so throwing the top card sends this one.
          if (top?.id === card.id) deck.current?.swipe("up");
          else onSwipe(card, "up");
        }}
      />
      <NoteSheet
        card={noteCard}
        onClose={() => {
          setNoteCard(null);
        }}
        onSave={(card, signal, text) => {
          setNoteCard(null);
          if (!noteCatchUp(card.id, signal, text)) toast.show("Not connected: note not sent");
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    minHeight: 52,
  },
  deck: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: STACK_DROP + spacing.lg,
  },
  toast: { position: "absolute", left: 0, right: 0, bottom: spacing.xl },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  flex: { flex: 1 },
});
