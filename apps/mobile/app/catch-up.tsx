/**
 * Catch Up (`/catch-up`): the things that need Isaac, one card at a time, like Slack's Catch Up.
 * Throw a card right (or tap Mark as Read) and the host marks it read; throw it left (Keep Unread)
 * and it stays unread but goes to the back of this session's deck. The host owns the cards and their
 * read state (`useCatchUpStore`); the screen asks again on focus.
 */
import { useCallback, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import type { CatchUpCard } from "@relay/protocol";
import { CATCHUP_CARD_RADIUS, CatchUpCardView } from "@/catchup/CatchUpCardView";
import { markCatchUp, requestCatchUp } from "@/connection";
import { deckCards } from "@/lib/catchup";
import { useCatchUpStore } from "@/state/catchup";
import { useConnectionStore } from "@/state/connection";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { IconButton } from "@/ui/IconButton";
import { SwipeActionOverlay } from "@/ui/SwipeActionOverlay";
import type { SwipeDirection } from "@/ui/SwipeCard";
import { SwipeDeck, UNDER_DROP, type SwipeDeckHandle } from "@/ui/SwipeDeck";
import { Text } from "@/ui/Text";
import { spacing, useColors } from "@/theme";

const BUTTON_HEIGHT = 52;

export default function CatchUp() {
  const colors = useColors();
  const router = useRouter();
  const items = useCatchUpStore((state) => state.items);
  const deferred = useCatchUpStore((state) => state.deferred);
  const defer = useCatchUpStore((state) => state.defer);
  const connected = useConnectionStore((state) => state.status === "connected");
  const deck = useRef<SwipeDeckHandle>(null);
  const cards = items === null ? [] : deckCards(items, deferred);

  useFocusEffect(
    useCallback(() => {
      requestCatchUp();
    }, []),
  );

  const onSwipe = (card: CatchUpCard, direction: SwipeDirection) => {
    if (direction === "right") markCatchUp(card.id, true);
    else defer(card.id);
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
              renderCard={(card) => <CatchUpCardView card={card} />}
              renderOverlay={(progress) => (
                <>
                  <SwipeActionOverlay
                    side="right"
                    progress={progress}
                    color={colors.ok}
                    symbol="checkmark"
                    label="Mark as Read"
                    radius={CATCHUP_CARD_RADIUS}
                  />
                  <SwipeActionOverlay
                    side="left"
                    progress={progress}
                    color={colors.accent}
                    symbol="eye.slash"
                    label="Keep Unread"
                    radius={CATCHUP_CARD_RADIUS}
                  />
                </>
              )}
              onSwipe={onSwipe}
            />
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
    marginBottom: UNDER_DROP + spacing.lg,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  flex: { flex: 1 },
});
