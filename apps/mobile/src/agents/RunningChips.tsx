import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { etaView } from "@relay/protocol";
import { Chip } from "@/ui/Chip";
import { ProgressFill } from "@/ui/ProgressFill";
import { ChipEtaPopover } from "@/agents/ChipEtaPopover";
import type { PopoverAnchor } from "@/agents/ThinkingPopover";
import type { RunningChip } from "@/lib/activity";
import { chipFill } from "@/lib/chipFill";
import { LINGER_MS, lingerLeft, settleChips, type ShownChip } from "@/lib/chipLinger";
import { spacing, useColors } from "@/theme";

/** How often the estimates are read again: the fill creeps, so a frame every few seconds is plenty. */
const TICK_MS = 5000;
/** A finished chip's fill runs to full in this long, then it fades over the rest of `LINGER_MS`. */
const DONE_FILL_MS = 500;

/**
 * What runs for an assistant thread right now (`lib/activity.ts` `runningChips`), one sideways row
 * of chips in the thread's header: a spinner while it works, a hand while it waits on Isaac. A chip
 * with a session opens that transcript (`onOpenSession`; a helper opens its own transcript, else
 * the session it runs under); the rest open the Artifacts sheet's Working group (`onOpenWorking`).
 *
 * A chip the host has an estimate for (`eta`) draws it as its own background, under the label and
 * spinner: a fill from the left in the assistant's `tint` (solid when sure, soft stripes when rough,
 * amber once it runs long), re-read every few seconds. Its tap first shows a small card (what is
 * left, how sure, Open); a long press opens straight away. When such a chip's run ends it fills up
 * and fades out over `LINGER_MS` instead of vanishing. Chip size never changes. Nothing renders when
 * nothing runs; keep it mounted so the send-off can play.
 */
export function RunningChips({ chips, tint, style, onOpenSession, onOpenWorking }: { chips: readonly RunningChip[]; tint: string; style?: StyleProp<ViewStyle>; onOpenSession: (sessionId: string) => void; onOpenWorking: () => void }) {
  const shown = useShownChips(chips);
  const hasEta = shown.some((entry) => entry.chip.eta !== undefined);
  const now = useNow(hasEta);
  const [card, setCard] = useState<{ id: string; anchor: PopoverAnchor } | null>(null);
  const open = (chip: RunningChip): void => {
    setCard(null);
    if (chip.sessionId === undefined) onOpenWorking();
    else onOpenSession(chip.sessionId);
  };
  const cardChip = card === null ? undefined : shown.find((entry) => !entry.done && entry.chip.id === card.id)?.chip;
  const cardView = cardChip?.eta === undefined ? null : etaView(cardChip.eta, now);
  if (shown.length === 0) return null;
  return (
    <View style={style}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.row} accessibilityRole="toolbar" accessibilityLabel="Running now">
        {shown.map((entry) => (
          <ChipItem
            key={entry.chip.id}
            entry={entry}
            now={now}
            tint={tint}
            onOpen={open}
            onExplain={(id, anchor) => {
              setCard({ id, anchor });
            }}
          />
        ))}
      </ScrollView>
      <ChipEtaPopover
        anchor={cardView === null || card === null ? null : card.anchor}
        label={cardView?.label ?? ""}
        detail={cardView?.detail ?? ""}
        onOpen={() => {
          if (cardChip !== undefined) open(cardChip);
        }}
        onClose={() => {
          setCard(null);
        }}
      />
    </View>
  );
}

function ChipItem({ entry, now, tint, onOpen, onExplain }: { entry: ShownChip; now: number; tint: string; onOpen: (chip: RunningChip) => void; onExplain: (id: string, anchor: PopoverAnchor) => void }) {
  const colors = useColors();
  const { chip, done } = entry;
  const box = useRef<View>(null);
  const fade = useSharedValue(1);
  useEffect(() => {
    if (done) fade.value = withDelay(DONE_FILL_MS, withTiming(0, { duration: LINGER_MS - DONE_FILL_MS }));
    else fade.value = 1;
  }, [done, fade]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const fill = chip.eta === undefined ? null : chipFill(etaView(chip.eta, now), tint, colors.warn);
  const explain = (): void => {
    box.current?.measureInWindow((x, y, width, height) => {
      onExplain(chip.id, { x, y, width, height });
    });
  };
  return (
    <Animated.View style={fadeStyle} pointerEvents={done ? "none" : "auto"}>
      <View ref={box} collapsable={false}>
        <Chip
          label={chip.label}
          accessibilityLabel={chip.waiting ? `${chip.label}, waiting on you` : `${chip.label}, running`}
          leading={chip.waiting ? <SymbolView name="hand.raised" size={12} tintColor={colors.warn} /> : <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />}
          {...(fill === null ? {} : { background: done ? <ProgressFill fraction={1} color={tint} texture="solid" growMs={DONE_FILL_MS} /> : <ProgressFill fraction={fill.fraction} color={fill.color} texture={fill.texture} /> })}
          onPress={chip.eta === undefined ? () => { onOpen(chip); } : explain}
          {...(chip.eta === undefined ? {} : { onLongPress: () => { onOpen(chip); } })}
        />
      </View>
    </Animated.View>
  );
}

/** `chips` plus, for `LINGER_MS`, each chip with an estimate that just left them (`lib/chipLinger`). */
function useShownChips(chips: readonly RunningChip[]): ShownChip[] {
  const [shown, setShown] = useState<ShownChip[]>(() => settleChips([], chips, Date.now()));
  useEffect(() => {
    setShown((previous) => settleChips(previous, chips, Date.now()));
  }, [chips]);
  useEffect(() => {
    const left = lingerLeft(shown, Date.now());
    if (left === null) return;
    const timer = setTimeout(() => {
      setShown((previous) => settleChips(previous, chips, Date.now()));
    }, left + 20);
    return () => {
      clearTimeout(timer);
    };
  }, [shown, chips]);
  return shown;
}

/** The time, moved forward every `TICK_MS` while `active` (some chip has an estimate), else frozen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.lg },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
});
