/**
 * The thread's turn rail: a thin column of ticks on the left edge, one per turn (a run of turns per
 * tick when they do not fit, like a scrollbar map), vertically centred in the thread's free area. The
 * tick of the turn on screen is the longest and brightest. A dot marks a turn that wants Isaac (an
 * unanswered question, or something shipped he never reacted to); a heavier tick is a bookmarked turn.
 * The icon above the ticks keeps only flagged and bookmarked turns.
 *
 * Press and hold a tick, then drag: a card by the finger previews the turn (his message in bold, the
 * start of the reply, what it wants), the haptics tick on each turn, and lifting jumps there. A quick
 * tap on a tick jumps straight to it. The hold keeps a quick swipe from the edge for going back. For
 * VoiceOver the rail is one adjustable element: swipe up and down to step between turns.
 *
 * The turn model (`@evaos/chat-core/turns`, shared with Relay desktop) and the geometry (`rail.ts`)
 * are pure and tested; this file only draws them and reads the finger.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import { compressTicks, marked, tickAtY, type Turn } from "@evaos/chat-core/turns";
import { Text } from "@/ui/Text";
import { impactHaptic, selectHaptic, tapHaptic } from "@/lib/haptics";
import { radii, spacing, useColors } from "@/theme";
import {
  FILTER_ROOM,
  MIN_TURNS,
  RAIL_WIDTH,
  TICK_PITCH,
  cardTop,
  railView,
  slotsFor,
  tickLength,
} from "./rail";

/** How long a finger holds still on the rail before a drag scrubs (a quicker swipe is the edge-back gesture's). */
const HOLD_MS = 180;
const CARD_MARGIN = spacing.sm;
const CARD_MAX_WIDTH = 320;

const FLAG_LABEL = { ask: "Asked you something", shipped: "Said something shipped" } as const;

export interface TurnRailProps {
  turns: readonly Turn[];
  bookmarks: ReadonlySet<string>;
  /** Chronological positions of the rows on screen, or null while unknown. */
  rows: { top: number; bottom: number } | null;
  /** The reader follows the newest message. */
  following: boolean;
  /** Brings a turn to the top of the thread. */
  onJump: (turn: Turn) => void;
  /** Free space above the thread's visible area to keep the rail out of (the header), and below it (the composer). */
  top: number;
  bottom: number;
}

export function TurnRail({
  turns,
  bookmarks,
  rows,
  following,
  onJump,
  top,
  bottom,
}: TurnRailProps) {
  const colors = useColors();
  const window = useWindowDimensions();
  const [only, setOnly] = useState(false);
  const [area, setArea] = useState(0);
  const shown = useMemo(() => (only ? marked(turns, bookmarks) : turns), [only, turns, bookmarks]);
  const view = useMemo(() => railView(shown, rows, following), [shown, rows, following]);
  const ticks = useMemo(
    () => compressTicks(shown, bookmarks, slotsFor(area), view.active, view.range),
    [shown, bookmarks, area, view],
  );
  // The finger's tick while scrubbing; null otherwise.
  const [scrub, setScrub] = useState<{ tick: number; y: number } | null>(null);
  const scrubbing = useRef<number | null>(null);
  const [cardHeight, setCardHeight] = useState(96);
  const column = ticks.length * TICK_PITCH;

  const move = useCallback(
    (y: number) => {
      const tick = tickAtY(y, column, ticks.length);
      if (tick < 0) return;
      if (scrubbing.current !== tick) {
        scrubbing.current = tick;
        selectHaptic();
      }
      setScrub({ tick, y: Math.min(column, Math.max(0, y)) });
    },
    [column, ticks.length],
  );
  const begin = useCallback(
    (y: number) => {
      impactHaptic("medium");
      scrubbing.current = null;
      move(y);
    },
    [move],
  );
  const end = useCallback(() => {
    const tick = scrubbing.current === null ? undefined : ticks[scrubbing.current];
    scrubbing.current = null;
    setScrub(null);
    const turn = tick === undefined ? undefined : shown[tick.rep];
    if (turn !== undefined) {
      tapHaptic();
      onJump(turn);
    }
  }, [ticks, shown, onJump]);
  const tap = useCallback(
    (y: number) => {
      const tick = ticks[tickAtY(y, column, ticks.length)];
      const turn = tick === undefined ? undefined : shown[tick.rep];
      if (turn === undefined) return;
      tapHaptic();
      onJump(turn);
    },
    [ticks, shown, column, onJump],
  );
  const step = useCallback(
    (dir: 1 | -1) => {
      const to = shown[view.active + dir];
      if (to === undefined) return;
      selectHaptic();
      onJump(to);
    },
    [shown, view.active, onJump],
  );

  const cancel = useCallback(() => {
    scrubbing.current = null;
    setScrub(null);
  }, []);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activateAfterLongPress(HOLD_MS)
      .onStart((event) => {
        scheduleOnRN(begin, event.y);
      })
      .onUpdate((event) => {
        scheduleOnRN(move, event.y);
      })
      .onFinalize((_event, success) => {
        // A hold that never became a drag leaves nothing to jump to; a cancelled one is dropped.
        if (success) scheduleOnRN(end);
        else scheduleOnRN(cancel);
      });
    const tapGesture = Gesture.Tap()
      .maxDuration(HOLD_MS)
      .onEnd((event, success) => {
        if (success) scheduleOnRN(tap, event.y);
      });
    return Gesture.Exclusive(pan, tapGesture);
  }, [begin, move, end, tap, cancel]);

  if (turns.length < MIN_TURNS) return null;
  const hovered = scrub === null ? undefined : ticks[scrub.tick];
  const hoveredTurn = hovered === undefined ? undefined : shown[hovered.rep];
  const cardWidth = Math.min(CARD_MAX_WIDTH, window.width - RAIL_WIDTH - spacing.lg * 2);
  // The column sits in the middle of the free area; the card follows the finger down it.
  const railTop = Math.max(0, (area - column) / 2 - FILTER_ROOM);
  const zoneTop = railTop + FILTER_ROOM;
  const cardY = scrub === null ? 0 : cardTop(zoneTop + scrub.y, cardHeight, 0, area, CARD_MARGIN);
  const onLayout = (event: LayoutChangeEvent): void => {
    setArea(event.nativeEvent.layout.height);
  };

  return (
    <View pointerEvents="box-none" style={[styles.area, { top, bottom }]} onLayout={onLayout}>
      <View
        pointerEvents="box-none"
        style={[styles.rail, { top: railTop, height: column + FILTER_ROOM }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={only ? "Show all turns" : "Only flagged and bookmarked turns"}
          accessibilityState={{ selected: only }}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 12 }}
          onPress={() => {
            tapHaptic();
            setOnly((value) => !value);
          }}
          style={styles.filter}
        >
          <SymbolView
            name="line.3.horizontal.decrease"
            size={12}
            tintColor={only ? colors.text : colors.textFaint}
          />
        </Pressable>
        <GestureDetector gesture={gesture}>
          <View
            style={[styles.zone, { height: column }]}
            collapsable={false}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Turns"
            accessibilityValue={{ text: `${String(view.active + 1)} of ${String(shown.length)}` }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(event) => {
              step(event.nativeEvent.actionName === "increment" ? 1 : -1);
            }}
          >
            {ticks.map((tick, index) => {
              const state = tick.state;
              const marked = tick.bookmarked;
              return (
                <View key={index} style={styles.slot}>
                  {tick.flag === null ? null : (
                    <View style={[styles.dot, { backgroundColor: colors.accent }]} />
                  )}
                  <View
                    style={{
                      width: tickLength(state),
                      height: marked ? 3 : 2,
                      borderRadius: 1.5,
                      backgroundColor: state === "active" ? colors.text : colors.textMuted,
                      opacity:
                        state === "active" ? 1 : state === "visible" ? 0.7 : marked ? 0.8 : 0.4,
                    }}
                  />
                </View>
              );
            })}
            {ticks.length === 0 ? (
              <Text variant="caption" color="textFaint" style={styles.empty}>
                Nothing flagged
              </Text>
            ) : null}
          </View>
        </GestureDetector>
      </View>
      {hoveredTurn === undefined ? null : (
        <View
          pointerEvents="none"
          onLayout={(event) => {
            setCardHeight(event.nativeEvent.layout.height);
          }}
          style={[
            styles.card,
            {
              top: cardY,
              left: RAIL_WIDTH + spacing.xs,
              width: cardWidth,
              backgroundColor: colors.surfaceRaised,
              borderColor: colors.hairline,
            },
          ]}
        >
          <View style={styles.cardHead}>
            <Text variant="label" numberOfLines={1} style={styles.cardTitle}>
              {hoveredTurn.title === "" ? "Turn" : hoveredTurn.title}
            </Text>
            {bookmarks.has(hoveredTurn.key) ? (
              <SymbolView name="bookmark.fill" size={13} tintColor={colors.text} />
            ) : null}
          </View>
          {hoveredTurn.reply === "" ? null : (
            <Text variant="caption" color="textMuted" numberOfLines={3}>
              {hoveredTurn.reply}
            </Text>
          )}
          {hoveredTurn.flag === null && (hovered?.last ?? 0) <= (hovered?.first ?? 0) ? null : (
            <View style={styles.cardFoot}>
              {hoveredTurn.flag === null ? null : (
                <View style={styles.flag}>
                  <View style={[styles.dot, styles.flagDot, { backgroundColor: colors.accent }]} />
                  <Text variant="caption" color="textFaint">
                    {FLAG_LABEL[hoveredTurn.flag]}
                  </Text>
                </View>
              )}
              {hovered !== undefined && hovered.last > hovered.first ? (
                <Text
                  variant="caption"
                  color="textFaint"
                >{`${String(hovered.last - hovered.first)} more turns here`}</Text>
              ) : null}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  area: { position: "absolute", left: 0, width: "100%" },
  rail: { position: "absolute", left: 0, width: RAIL_WIDTH, alignItems: "flex-start" },
  filter: {
    width: RAIL_WIDTH,
    height: FILTER_ROOM,
    alignItems: "center",
    justifyContent: "center",
  },
  zone: { width: RAIL_WIDTH, justifyContent: "flex-start" },
  slot: { height: TICK_PITCH, width: RAIL_WIDTH, justifyContent: "center", paddingLeft: 10 },
  dot: { position: "absolute", left: 2, width: 5, height: 5, borderRadius: 2.5 },
  flagDot: { position: "relative", left: 0 },
  empty: { position: "absolute", left: 10, width: 120 },
  card: {
    position: "absolute",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cardTitle: { flex: 1, fontWeight: "600" },
  cardFoot: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  flag: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
});
