/**
 * A PR's Guide: its changed files in sections read top to bottom ("1 of 4", title, why, file
 * cards), with "k of N files reviewed" over a progress bar. Ticking a file's circle marks it
 * reviewed for this head commit (kept on the phone). Writing the Guide takes a model a while the
 * first time per head; the folders fallback says why the walkthrough is missing.
 */
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { ReviewGuide, ReviewPr } from "@relay/protocol";
import { MessageText } from "@/agents/MessageText";
import { prKey, ticksOf, useReviewTicksStore } from "@/state/reviews";
import { radii, spacing, useColors } from "@/theme";
import { Button } from "@/ui/Button";
import { ProgressBar } from "@/ui/ProgressBar";
import { Text } from "@/ui/Text";
import { guideProgress, splitPath } from "./model";
import { DiffStat } from "./PrTabs";

export interface PrGuideProps {
  pr: ReviewPr;
  guide: ReviewGuide | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function PrGuide({ pr, guide, loading, error, onRetry }: PrGuideProps) {
  const colors = useColors();
  const key = prKey(pr.repo, pr.number);
  const reviewed = useReviewTicksStore((state) => ticksOf(state.ticks, key, pr.headSha));
  const toggle = useReviewTicksStore((state) => state.toggle);
  if (guide === undefined) {
    return (
      <View style={[styles.tab, styles.waiting]}>
        {loading ? (
          <>
            <ActivityIndicator color={colors.textMuted} />
            <Text color="textMuted">Writing the guide…</Text>
          </>
        ) : (
          <>
            <Text color="textMuted">{error ?? "No guide yet."}</Text>
            <Button label="Try again" variant="secondary" onPress={onRetry} />
          </>
        )}
      </View>
    );
  }
  const progress = guideProgress(guide, reviewed);
  const stats = new Map(pr.files.map((file) => [file.path, file]));
  return (
    <View style={styles.tab}>
      <View style={styles.progress}>
        <Text color="textMuted" tabular>{`${String(progress.done)} of ${String(progress.total)} files reviewed`}</Text>
        <View style={styles.bar}>
          <ProgressBar fraction={progress.total === 0 ? 0 : progress.done / progress.total} tone="ok" />
        </View>
      </View>
      {guide.source === "folders" && (
        <Text variant="caption" color="textFaint">{`Grouped by folder${guide.error === null ? "" : `: ${guide.error}`}`}</Text>
      )}
      {guide.headSha !== pr.headSha && (
        <Text variant="caption" color="textFaint">
          Written for an older push.
        </Text>
      )}
      {guide.sections.map((section, i) => (
        <View key={`${String(i)}-${section.title}`} style={[styles.section, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline }]}>
          <Text variant="label" color="textFaint">{`${String(i + 1)} of ${String(guide.sections.length)}`}</Text>
          <Text variant="title" style={styles.sectionTitle}>
            {section.title}
          </Text>
          {section.why.trim() !== "" && <MessageText text={section.why} />}
          <View style={[styles.card, { borderColor: colors.hairline }]}>
            {section.files.map((path, j) => {
              const { dir, name } = splitPath(path);
              const file = stats.get(path);
              const done = reviewed.includes(path);
              return (
                <View key={path} style={[styles.fileRow, j > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline }]}>
                  <SymbolView name="doc.text" size={18} tintColor={colors.textMuted} />
                  <View style={styles.fileName}>
                    <Text numberOfLines={1}>{name}</Text>
                    {dir !== "" && (
                      <Text variant="caption" color="textFaint" numberOfLines={1}>
                        {dir}
                      </Text>
                    )}
                  </View>
                  {file !== undefined && <DiffStat additions={file.additions} deletions={file.deletions} />}
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: done }}
                    accessibilityLabel={`Reviewed ${name}`}
                    hitSlop={10}
                    onPress={() => {
                      toggle(key, pr.headSha, path);
                    }}
                  >
                    <SymbolView name={done ? "checkmark.circle.fill" : "circle"} size={26} tintColor={done ? colors.ok : colors.textFaint} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tab: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.md },
  waiting: { alignItems: "center", paddingTop: spacing.xxxl, gap: spacing.md },
  progress: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  bar: { flex: 1, maxWidth: 180, marginLeft: "auto" },
  section: { gap: spacing.sm, paddingTop: spacing.lg },
  sectionTitle: { fontSize: 20, lineHeight: 26 },
  card: { borderWidth: 1, borderRadius: radii.lg, marginTop: spacing.xs },
  fileRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  fileName: { flex: 1 },
});
