import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { agentBadge, agentRunKey, etaView, type AgentRun } from "@relay/protocol";
import { ChefHatIcon } from "@/ui/ChefHatIcon";
import { Chip, CHIP_HEIGHT } from "@/ui/Chip";
import { ProgressFill } from "@/ui/ProgressFill";
import { Text } from "@/ui/Text";
import { ChipEtaPopover } from "@/agents/ChipEtaPopover";
import type { PopoverAnchor } from "@/ui/popoverAnchor";
import type { RunningChip } from "@/lib/activity";
import { chipFill, doneFill } from "@/lib/chipFill";
import { LINGER_MS, lingerLeft, settleChips, type ShownChip } from "@/lib/chipLinger";
import { tapHaptic } from "@/lib/haptics";
import { useSecondClock } from "@/lib/useSecondClock";
import { radii, spacing, toneFill, useColors, useScheme, withAlpha, type ColorToken } from "@/theme";

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
 * spinner: a faint neutral fill from the left (solid when sure, soft stripes when rough,
 * a slow pulse once it runs long; `lib/chipFill`), re-read every few seconds. Its tap first shows a small card (what is
 * left, how sure, Open); a long press opens straight away. When such a chip's run ends it fills up
 * and fades out over `LINGER_MS` instead of vanishing. Chip size never changes. Nothing renders when
 * nothing runs; keep it mounted so the send-off can play.
 *
 * The thread's specialist runs (`specialists`, `lib/specialistChips`) lead the row, newest first, as chips of
 * their own shape: squared corners, accent tint with a spinner and a ticking clock while running, quiet grey
 * with a check when done, a soft danger tint when failed. A tap opens that run (`onOpenRun`, its `agentRunKey`).
 */
export function RunningChips({ chips, specialists, style, onOpenSession, onOpenWorking, onOpenRun }: { chips: readonly RunningChip[]; specialists: readonly AgentRun[]; style?: StyleProp<ViewStyle>; onOpenSession: (sessionId: string) => void; onOpenWorking: () => void; onOpenRun: (key: string) => void }) {
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
  if (shown.length === 0 && specialists.length === 0) return null;
  return (
    <View style={style}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.row} accessibilityRole="toolbar" accessibilityLabel="Running now">
        <SpecialistChips runs={specialists} onOpen={onOpenRun} />
        {shown.map((entry) => (
          <ChipItem
            key={entry.chip.id}
            entry={entry}
            now={now}
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

function ChipItem({ entry, now, onOpen, onExplain }: { entry: ShownChip; now: number; onOpen: (chip: RunningChip) => void; onExplain: (id: string, anchor: PopoverAnchor) => void }) {
  const colors = useColors();
  const scheme = useScheme();
  const { chip, done } = entry;
  const box = useRef<View>(null);
  const fade = useSharedValue(1);
  useEffect(() => {
    if (done) fade.value = withDelay(DONE_FILL_MS, withTiming(0, { duration: LINGER_MS - DONE_FILL_MS }));
    else fade.value = 1;
  }, [done, fade]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const fill = chip.eta === undefined ? null : chipFill(etaView(chip.eta, now), scheme);
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
          {...(fill === null ? {} : { background: done ? <ProgressFill {...doneFill(scheme)} growMs={DONE_FILL_MS} /> : <ProgressFill {...fill} /> })}
          onPress={chip.eta === undefined ? () => { onOpen(chip); } : explain}
          {...(chip.eta === undefined ? {} : { onLongPress: () => { onOpen(chip); } })}
        />
      </View>
    </Animated.View>
  );
}

/** The specialist chips, their own component so only they redraw on each second's tick (while one runs). */
function SpecialistChips({ runs, onOpen }: { runs: readonly AgentRun[]; onOpen: (key: string) => void }) {
  const now = useSecondClock(runs.some((run) => run.status === "running"));
  return runs.map((run) => <SpecialistChip key={agentRunKey(run)} run={run} now={now} onOpen={onOpen} />);
}

function SpecialistChip({ run, now, onOpen }: { run: AgentRun; now: number; onOpen: (key: string) => void }) {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const badge = agentBadge(run, now);
  // Running: accent tint. Done: the raised surface. Failed: a danger tint, much fainter in the dark.
  const tone: ColorToken = badge.state === "running" ? "accent" : badge.state === "failed" ? "danger" : "textMuted";
  const fill = badge.state === "running" ? toneFill(colors, "accent", 0.12) : badge.state === "failed" ? toneFill(colors, "danger", dark ? 0.08 : 0.1) : colors.surfaceRaised;
  const border = badge.state === "done" ? colors.hairline : withAlpha(colors[tone], dark ? 0.2 : 0.28);
  const said = badge.state === "running" ? "running" : badge.state === "failed" ? "failed" : "done";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${badge.label}, ${said}${badge.clock === null ? "" : `, ${badge.clock}`}`}
      accessibilityHint="Shows what was asked and what came back"
      onPress={() => {
        tapHaptic();
        onOpen(agentRunKey(run));
      }}
      style={({ pressed }) => [styles.specialist, { backgroundColor: fill, borderColor: border, opacity: pressed ? 0.7 : 1 }]}
      testID="specialist-chip"
    >
      {badge.state === "running" ? (
        <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />
      ) : (
        <SymbolView name={badge.state === "failed" ? "exclamationmark.triangle.fill" : "checkmark"} size={11} tintColor={colors[tone]} />
      )}
      <ChefHatIcon size={12} color={colors[tone]} />
      <Text variant="caption" color={tone} numberOfLines={1} style={styles.specialistLabel}>
        {badge.label}
      </Text>
      {badge.clock !== null && (
        <Text variant="caption" color={badge.state === "done" ? "textFaint" : tone} tabular style={styles.clock}>
          {badge.clock}
        </Text>
      )}
    </Pressable>
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
  specialist: {
    height: CHIP_HEIGHT,
    maxWidth: 240,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
  },
  specialistLabel: { flexShrink: 1 },
  clock: { opacity: 0.75 },
});
