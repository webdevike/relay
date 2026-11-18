/**
 * Specialist agents a reply used (protocol `AgentRun`, the desktop chat's margin design): a small seal in the
 * left margin beside the reply, tinted while a run works, and one muted caption line under it
 * (`Answered with Web researcher · 29s · 3 sources`, `Web researcher is on it · 0:12`, ticking each second).
 * A tap on the caption opens each run in place: what was asked, the answer, its citations, an error.
 */
import { useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { agentLabel, agentsCaption, type AgentRun } from "@relay/protocol";
import { agentRunDetail, agentsTone, type AgentsTone, type Citation } from "@/lib/agentRuns";
import { tapHaptic } from "@/lib/haptics";
import { openChatLink } from "@/lib/links";
import { useSecondClock } from "@/lib/useSecondClock";
import { radii, spacing, type, useColors, type ColorToken } from "@/theme";
import { Text } from "@/ui/Text";
import { MessageText } from "./MessageText";

/** The seal's size: a margin glyph, smaller than the reply's text. */
const BADGE = 13;
/** The caption line's vertical padding. */
const CAPTION_PAD = 2;
/** From the top of the caption to the middle of its line: where the seal sits beside a caption with no reply above it. */
export const CAPTION_LINE_MIDDLE = CAPTION_PAD + type.caption.lineHeight / 2;
const TINT: Record<AgentsTone, ColorToken> = {
  running: "accent",
  failed: "danger",
  done: "textFaint",
};

export interface AgentsBadgeProps {
  runs: readonly AgentRun[];
  /** From the top of the row to the middle of the reply's first line. */
  lineMiddle: number;
  /** The row's left padding: the margin the seal sits centered in. */
  margin: number;
}

/** The seal in the margin beside a reply. Decorative for VoiceOver: the caption says it all. */
export function AgentsBadge({ runs, lineMiddle, margin }: AgentsBadgeProps) {
  const colors = useColors();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.badge, { top: lineMiddle - BADGE / 2, left: (margin - BADGE) / 2 }]}
      testID="agents-badge"
    >
      <SymbolView
        name="seal"
        size={BADGE}
        tintColor={colors[TINT[agentsTone(runs)]]}
        weight="medium"
      />
    </View>
  );
}

export interface AgentsCaptionProps {
  runs: readonly AgentRun[];
  /** The opened details' card fill: the thread's incoming bubble colour. */
  fill: string;
  style?: StyleProp<ViewStyle>;
}

/** The caption line under a reply, and its runs opened in place on a tap. */
export function AgentsCaption({ runs, fill, style }: AgentsCaptionProps) {
  const [open, setOpen] = useState(false);
  const colors = useColors();
  const now = useSecondClock(agentsTone(runs) === "running");
  const caption = agentsCaption(runs, now);
  return (
    <View style={style} testID="agents-caption">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={caption}
        accessibilityState={{ expanded: open }}
        accessibilityHint={
          open ? "Hides what the specialists said" : "Shows what was asked and what came back"
        }
        hitSlop={8}
        onPress={() => {
          tapHaptic();
          setOpen(!open);
        }}
        style={({ pressed }) => [styles.head, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text variant="caption" color="textMuted" tabular numberOfLines={1} style={styles.line}>
          {caption}
        </Text>
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={9}
          tintColor={colors.textFaint}
        />
      </Pressable>
      {open && (
        <Animated.View
          entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
          style={[styles.body, { backgroundColor: fill, borderColor: colors.hairline }]}
          testID="agents-details"
        >
          {runs.map((run, i) => (
            <RunDetail key={run.run ?? `${run.agent}-${String(i)}`} run={run} first={i === 0} />
          ))}
        </Animated.View>
      )}
    </View>
  );
}

/** One run opened: what was asked, the answer, its citations, an error. Also the specialist chip's sheet (`SpecialistRunSheet`). */
export function RunDetail({ run, first }: { run: AgentRun; first: boolean }) {
  const colors = useColors();
  const detail = agentRunDetail(run);
  return (
    <View
      style={[
        styles.run,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
      ]}
    >
      <View style={styles.runHead}>
        <Text variant="label" numberOfLines={1} style={styles.line}>
          {agentLabel(run.agent)}
        </Text>
        {detail.meta !== null && (
          <Text variant="caption" color="textFaint" tabular>
            {detail.meta}
          </Text>
        )}
      </View>
      {detail.model !== null && (
        <Text variant="caption" color="textMuted" numberOfLines={2} testID="agents-model">
          {`Model: ${detail.model}`}
        </Text>
      )}
      {detail.asked !== null && (
        <Text variant="caption" color="textMuted" numberOfLines={3}>
          {`Asked: ${detail.asked}`}
        </Text>
      )}
      {run.status === "failed" && (
        <Text variant="body" color="danger">
          {run.error ?? "The run failed."}
        </Text>
      )}
      {detail.answer !== null && <MessageText text={detail.answer} />}
      {detail.fields.map((field) => (
        <Text key={field} variant="caption" color="textMuted" numberOfLines={4}>
          {field}
        </Text>
      ))}
      {detail.citations.map((citation, i) => (
        <CitationLine key={`${citation.url}-${String(i)}`} citation={citation} />
      ))}
    </View>
  );
}

function CitationLine({ citation }: { citation: Citation }) {
  const colors = useColors();
  const host = hostOf(citation.url);
  const verified = citation.verified === true;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${verified ? "Verified source" : "Source"} ${host}${citation.quote === undefined ? "" : `: ${citation.quote}`}`}
      hitSlop={4}
      onPress={() => {
        openChatLink(citation.url);
      }}
      style={({ pressed }) => [styles.citation, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={styles.citationMark}>
        <SymbolView
          name={verified ? "checkmark.seal.fill" : "link"}
          size={12}
          tintColor={verified ? colors.ok : colors.textFaint}
        />
      </View>
      <View style={styles.citationText}>
        <Text variant="caption" color="accent" numberOfLines={1}>
          {host}
        </Text>
        {citation.quote !== undefined && (
          <Text variant="caption" color="textMuted" numberOfLines={3}>
            {`"${citation.quote}"`}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** `https://www.example.com/a/b` as `example.com/a/b`, what a source line shows. */
function hostOf(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

const styles = StyleSheet.create({
  badge: { position: "absolute", width: BADGE, height: BADGE },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    alignSelf: "flex-start",
    maxWidth: "100%",
    paddingVertical: CAPTION_PAD,
  },
  line: { flexShrink: 1 },
  body: {
    marginTop: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
  },
  run: { gap: spacing.xs, paddingVertical: spacing.sm },
  runHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  citation: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  citationMark: { width: 14, height: 16, alignItems: "center", justifyContent: "center" },
  citationText: { flex: 1, gap: 2 },
});
