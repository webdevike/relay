/**
 * The ```ui "diff" widget: a file header with +/- counts, then gutter line numbers and tinted
 * add/remove rows. Rows never wrap; the body scrolls sideways as one block so columns stay aligned.
 * Long diffs show the first rows and a "Show all" toggle.
 */
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text as RNText, View } from "react-native";
import { tapHaptic } from "@/lib/haptics";
import { colors, radii, spacing } from "@/theme";
import { Text } from "@/ui/Text";
import { parseDiff, type DiffRow } from "./diff";
import type { DiffSpec } from "./widget";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const FONT_SIZE = 12;
const LINE_HEIGHT = 18;
/** Rows shown before the "Show all" toggle. */
const PREVIEW_ROWS = 60;

const rowStyle: Record<DiffRow["kind"], { bg: string; marker: string; color: string }> = {
  add: { bg: "rgba(74,222,128,0.12)", marker: "+", color: colors.text },
  del: { bg: "rgba(248,113,113,0.12)", marker: "-", color: colors.text },
  context: { bg: "transparent", marker: " ", color: colors.textMuted },
  hunk: { bg: colors.surfaceRaised, marker: " ", color: colors.accent },
  meta: { bg: "transparent", marker: " ", color: colors.textFaint },
};

export function DiffView({ spec }: { spec: DiffSpec }) {
  const diff = useMemo(() => parseDiff(spec.patch), [spec.patch]);
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? diff.rows : diff.rows.slice(0, PREVIEW_ROWS);
  const hidden = diff.rows.length - rows.length;
  const width = String(Math.max(...diff.rows.map((r) => Math.max(r.oldLine ?? 0, r.newLine ?? 0)), 0)).length;
  const numbered = diff.rows.some((r) => r.oldLine !== null || r.newLine !== null);

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1, fontFamily: mono }}>
          {spec.file ?? "Diff"}
        </Text>
        <Text variant="caption" color="ok" tabular>
          +{diff.additions}
        </Text>
        <Text variant="caption" color="danger" tabular>
          -{diff.deletions}
        </Text>
      </View>
      <View style={{ borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surface }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ paddingVertical: spacing.xs, minWidth: "100%" }}>
            {rows.map((row, i) => {
              const style = rowStyle[row.kind];
              return (
                <View key={i} style={{ flexDirection: "row", backgroundColor: style.bg, paddingRight: spacing.md }}>
                  {numbered && (
                    <RNText style={[cell, { color: colors.textFaint, textAlign: "right", paddingLeft: spacing.sm }]}>
                      {pad(row.oldLine, width)} {pad(row.newLine, width)}
                    </RNText>
                  )}
                  <RNText style={[cell, { color: row.kind === "add" ? colors.ok : row.kind === "del" ? colors.danger : colors.textFaint, paddingHorizontal: spacing.sm }]}>
                    {style.marker}
                  </RNText>
                  <RNText style={[cell, { color: style.color }]}>{row.text}</RNText>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
      {hidden > 0 && (
        <Pressable
          hitSlop={8}
          onPress={() => {
            tapHaptic();
            setExpanded(true);
          }}
          style={({ pressed }) => ({ alignSelf: "flex-start", opacity: pressed ? 0.6 : 1 })}
        >
          <Text variant="caption" color="accent">
            Show {hidden} more lines
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const cell = { fontFamily: mono, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT } as const;

/** Right-aligns a line number in a fixed-width gutter column; blank when the side has no line. */
function pad(line: number | null, width: number): string {
  return (line === null ? "" : String(line)).padStart(width, " ");
}
