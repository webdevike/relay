/**
 * Another assistant in this thread (the desktop chat's design): "Penny joined the chat" as a quiet
 * centered line with her face; what she said as a guest bubble (her face, her name in her color, a
 * guest pill, a left bar and a faint tint); the work she took on as one row (her face, the title
 * while it runs and her result once done, the time on the right) that opens her thread on a tap.
 */
import { useEffect, useState } from "react";
import { Keyboard, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { GuestEntry } from "@relay/protocol";
import { tapHaptic } from "@/lib/haptics";
import { workTarget, workTime } from "@/lib/guests";
import { agentPortrait, useAssistantStore } from "@/state/assistant";
import { radii, spacing, useColors, withAlpha } from "@/theme";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { MessageText } from "./MessageText";

/** The guest's color: the one its row carries, else its portrait's accent, else the app accent. */
function useGuestColor(entry: GuestEntry): string {
  const colors = useColors();
  const accent = useAssistantStore((state) => agentPortrait(state.agents, entry.agent.id).colors?.accent);
  return entry.agent.color ?? accent ?? colors.accent;
}

function GuestFace({ entry, size }: { entry: GuestEntry; size: number }) {
  const portrait = useAssistantStore((state) => agentPortrait(state.agents, entry.agent.id));
  return <Portrait name={entry.agent.title} portrait={portrait} size={size} />;
}

export function GuestLine({ entry }: { entry: GuestEntry }) {
  return (
    <View style={styles.line} testID="guest-line">
      <GuestFace entry={entry} size={16} />
      <Text variant="caption" color="textMuted">
        {entry.agent.title} {entry.kind === "join" ? "joined the chat" : "left the chat"}
      </Text>
    </View>
  );
}

export function GuestBubble({ entry }: { entry: GuestEntry }) {
  const colors = useColors();
  const color = useGuestColor(entry);
  return (
    <View style={[styles.say, { borderLeftColor: withAlpha(color, 0.55), backgroundColor: withAlpha(color, 0.08) }]} testID="guest-say">
      <GuestFace entry={entry} size={32} />
      <View style={styles.sayBody}>
        <View style={styles.sayHead}>
          <Text variant="label" style={{ color }}>
            {entry.agent.title}
          </Text>
          <View style={[styles.pill, { backgroundColor: colors.surfaceRaised }]}>
            <Text variant="caption" color="textMuted">
              guest
            </Text>
          </View>
        </View>
        <MessageText text={entry.text ?? ""} />
      </View>
    </View>
  );
}

/** Now, every second while `on`. */
function useSecond(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function WorkCardRow({ entry }: { entry: GuestEntry }) {
  const router = useRouter();
  const colors = useColors();
  const color = useGuestColor(entry);
  const work = entry.work!;
  const working = work.state === "working";
  const now = useSecond(working);
  const line = work.state === "done" ? (entry.text ?? work.title) : work.state === "failed" ? (entry.text ?? `Stopped ${work.title}`) : work.title;
  const time = workTime(work, now);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${entry.agent.title}'s chat: ${line}`}
      onPress={() => {
        tapHaptic();
        Keyboard.dismiss();
        router.push(workTarget(entry));
      }}
      style={({ pressed }) => [
        styles.work,
        { backgroundColor: colors.surfaceRaised, borderColor: working ? withAlpha(color, 0.6) : colors.hairline, opacity: pressed ? 0.7 : 1 },
      ]}
      testID="work-card"
    >
      <GuestFace entry={entry} size={22} />
      <Text variant="body" color={work.state === "done" ? "text" : "textMuted"} numberOfLines={2} style={styles.workLine}>
        {line}
      </Text>
      {time === null ? (
        <View style={styles.meta}>
          <SymbolView name="exclamationmark.triangle" size={12} tintColor={colors.danger} />
          <Text variant="caption" color="textMuted">
            Stopped
          </Text>
        </View>
      ) : (
        <Text variant="caption" color="textMuted" tabular>
          {time}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, paddingHorizontal: spacing.xxxl },
  say: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderLeftWidth: 2,
    borderTopRightRadius: radii.sm,
    borderBottomRightRadius: radii.sm,
  },
  sayBody: { flex: 1, minWidth: 0, gap: spacing.xs },
  sayHead: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  pill: { paddingHorizontal: spacing.sm, borderRadius: 999 },
  work: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  workLine: { flex: 1, minWidth: 0 },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
});
