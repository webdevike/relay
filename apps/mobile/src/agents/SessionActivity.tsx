/**
 * What the focused session is busy with besides its turn, pinned to the bottom of the chat card
 * above the composer: the handoff banner while it summarizes itself and compacts in place, and one
 * chip per background job (`bg_N` bash commands, eval cells). Tapping a chip shows what it runs,
 * how it stands and for how long; tapping it again hides that. Mirrors EvaOS's handoff banner and
 * background-jobs strip (apps/evaos/src/chat_view.rs).
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { AgentBackgroundJobState, AgentSession } from "@relay/protocol";
import { Banner } from "@/ui/Banner";
import { Chip } from "@/ui/Chip";
import { Text } from "@/ui/Text";
import { elapsed } from "@/lib/format";
import { spacing, useColors, type ColorToken } from "@/theme";

const stateWord: Record<AgentBackgroundJobState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** The glyph an ended job's chip leads with; a running one shows a spinner. */
const endedGlyph: Record<Exclude<AgentBackgroundJobState, "running">, { symbol: SFSymbol; color: ColorToken }> = {
  done: { symbol: "checkmark", color: "ok" },
  failed: { symbol: "xmark", color: "danger" },
  cancelled: { symbol: "minus", color: "textMuted" },
};

export interface SessionActivityProps {
  session: AgentSession;
  /** Room left under the strip, clear of whatever bites into the card's bottom edge (the mic seam). */
  bottomInset: number;
}

export function SessionActivity({ session, bottomInset }: SessionActivityProps) {
  const colors = useColors();
  const jobs = session.backgroundJobs ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const open = jobs.find((job) => job.id === openId);
  // The open job's running time ticks while it runs.
  const [now, setNow] = useState(Date.now());
  const ticking = open?.state === "running";
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [ticking]);

  if (session.handingOff !== true && jobs.length === 0) return null;
  return (
    <View style={[styles.strip, { paddingBottom: bottomInset }]}>
      {session.handingOff === true && (
        <Banner tone="info" busy message="Generating handoff" detail="Summarizing this session, then compacting in place" />
      )}
      {jobs.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {jobs.map((job) => (
            <Chip
              key={job.id}
              label={job.label}
              accessibilityLabel={`Background job ${job.label}, ${stateWord[job.state]}`}
              selected={job.id === openId}
              leading={
                job.state === "running" ? (
                  <ActivityIndicator size="small" color={colors.working} style={styles.spinner} />
                ) : (
                  <SymbolView name={endedGlyph[job.state].symbol} size={11} tintColor={colors[endedGlyph[job.state].color]} />
                )
              }
              onPress={() => {
                setOpenId((current) => (current === job.id ? null : job.id));
              }}
            />
          ))}
        </ScrollView>
      )}
      {open !== undefined && (
        <View style={styles.detail}>
          <Text variant="caption" color="text" numberOfLines={3} selectable>
            {open.label}
          </Text>
          <Text variant="caption" color="textMuted" tabular>
            {`${stateWord[open.state]} · ${open.type} ${open.id}${open.state === "running" ? ` · ${elapsed(now - open.startedAt)}` : ""}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { gap: spacing.sm, paddingTop: spacing.sm },
  chips: { gap: spacing.xs, paddingHorizontal: spacing.md },
  /** The small spinner is 20pt; the chip's glyph slot is about 12. */
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  detail: { gap: 2, paddingHorizontal: spacing.lg },
});
