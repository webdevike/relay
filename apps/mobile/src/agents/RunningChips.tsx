import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { SymbolView } from "expo-symbols";
import { etaView } from "@relay/protocol";
import { Chip } from "@/ui/Chip";
import { ChipEtaPopover } from "@/agents/ChipEtaPopover";
import type { PopoverAnchor } from "@/ui/popoverAnchor";
import type { RunningChip } from "@/lib/activity";
import { spacing, useColors } from "@/theme";

/** How often the estimates are read again; a frame every few seconds is plenty. */
const TICK_MS = 5000;

/**
 * What runs for an assistant thread right now (`lib/activity.ts` `runningChips`), one sideways row
 * of chips in the thread's header: a spinner while it works, a hand while it waits on Isaac. A chip
 * with a session opens that transcript (`onOpenSession`; a helper opens its own transcript, else
 * the session it runs under); the rest open the Artifacts sheet's Working group (`onOpenWorking`).
 *
 * A chip the host has an estimate for (`eta`) shows a small card on tap (what is left, how sure,
 * Open), re-read every few seconds; a long press opens straight away. Chips draw no progress fill.
 * Nothing renders when nothing runs.
 */
export function RunningChips({ chips, style, onOpenSession, onOpenWorking }: { chips: readonly RunningChip[]; style?: StyleProp<ViewStyle>; onOpenSession: (sessionId: string) => void; onOpenWorking: () => void }) {
  const hasEta = chips.some((chip) => chip.eta !== undefined);
  const now = useNow(hasEta);
  const [card, setCard] = useState<{ id: string; anchor: PopoverAnchor } | null>(null);
  const open = (chip: RunningChip): void => {
    setCard(null);
    if (chip.sessionId === undefined) onOpenWorking();
    else onOpenSession(chip.sessionId);
  };
  const cardChip = card === null ? undefined : chips.find((chip) => chip.id === card.id);
  const cardView = cardChip?.eta === undefined ? null : etaView(cardChip.eta, now);
  if (chips.length === 0) return null;
  return (
    <View style={style}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.row} accessibilityRole="toolbar" accessibilityLabel="Running now">
        {chips.map((chip) => (
          <ChipItem
            key={chip.id}
            chip={chip}
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

function ChipItem({ chip, onOpen, onExplain }: { chip: RunningChip; onOpen: (chip: RunningChip) => void; onExplain: (id: string, anchor: PopoverAnchor) => void }) {
  const colors = useColors();
  const box = useRef<View>(null);
  const explain = (): void => {
    box.current?.measureInWindow((x, y, width, height) => {
      onExplain(chip.id, { x, y, width, height });
    });
  };
  return (
    <View ref={box} collapsable={false}>
      <Chip
        label={chip.label}
        accessibilityLabel={chip.waiting ? `${chip.label}, waiting on you` : `${chip.label}, running`}
        leading={chip.waiting ? <SymbolView name="hand.raised" size={12} tintColor={colors.warn} /> : <ActivityIndicator size="small" color={colors.accent} style={styles.spinner} />}
        onPress={chip.eta === undefined ? () => { onOpen(chip); } : explain}
        {...(chip.eta === undefined ? {} : { onLongPress: () => { onOpen(chip); } })}
      />
    </View>
  );
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
