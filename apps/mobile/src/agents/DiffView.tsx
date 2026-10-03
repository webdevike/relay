/**
 * The ```ui "diff" widget, styled after Zed's inline diff: a collapsible file header (name, then the
 * dimmed directory), one line-number column (removed lines have none), a colored gutter bar per
 * change block (green added, yellow modified, red deleted), softly tinted rows, and syntax colors
 * from the file extension. No +/- markers. Rows never wrap; the body scrolls sideways as one block.
 */
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text as RNText, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { Highlight } from "prism-react-renderer";
import { tapHaptic } from "@/lib/haptics";
import { colors, radii, spacing } from "@/theme";
import { Text } from "@/ui/Text";
import { codeTheme, prismLanguage } from "./CodeBlock";
import { parseDiff, type DiffChange, type DiffRow } from "./diff";
import type { DiffSpec } from "./widget";

const mono = Platform.select({ ios: "Menlo", default: "monospace" });
const FONT_SIZE = 12;
const LINE_HEIGHT = 20;
const BAR = 3;
/** Rows shown before the "Show all" toggle. */
const PREVIEW_ROWS = 60;

const barColor: Record<DiffChange, string> = { added: colors.ok, modified: colors.warn, deleted: colors.danger };
const tint = { add: "rgba(74,222,128,0.10)", del: "rgba(248,113,113,0.10)" } as const;

export function DiffView({ spec }: { spec: DiffSpec }) {
  const diff = useMemo(() => parseDiff(spec.patch), [spec.patch]);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? diff.rows : diff.rows.slice(0, PREVIEW_ROWS);
  const hidden = diff.rows.length - rows.length;
  // One number column, the new file's; removed lines have no new line, so they show none (Zed's look).
  const gutter = String(Math.max(0, ...diff.rows.map((r) => r.newLine ?? r.oldLine ?? 0))).length;
  const numbered = diff.rows.some((r) => r.newLine !== null || r.oldLine !== null);
  const slash = spec.file?.lastIndexOf("/") ?? -1;
  const name = spec.file === undefined ? "Diff" : spec.file.slice(slash + 1);
  const dir = spec.file === undefined || slash < 0 ? "" : spec.file.slice(0, slash + 1);
  const ext = name.includes(".") ? (name.split(".").pop() ?? null) : null;

  return (
    <View style={{ borderRadius: radii.sm, borderWidth: 1, borderColor: colors.hairline, overflow: "hidden", backgroundColor: colors.surface }}>
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen((v) => !v);
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          paddingHorizontal: spacing.sm,
          height: 34,
          backgroundColor: colors.surfaceRaised,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <SymbolView name={open ? "chevron.down" : "chevron.right"} size={11} tintColor={colors.textMuted} />
        <Text variant="label" numberOfLines={1} style={{ color: colors.warn, fontFamily: mono, fontSize: FONT_SIZE }}>
          {name}
        </Text>
        <Text variant="caption" color="textFaint" numberOfLines={1} style={{ flexShrink: 1, fontFamily: mono }}>
          {dir}
        </Text>
      </Pressable>
      {open && (
        <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
          <Highlight code={rows.map((r) => (r.kind === "hunk" || r.kind === "meta" ? "" : r.text)).join("\n")} language={prismLanguage(ext)} theme={codeTheme}>
            {({ tokens, getTokenProps }) => (
              <View style={{ paddingVertical: spacing.xs, minWidth: "100%" }}>
                {rows.map((row, i) => {
                  if (row.kind === "hunk" || row.kind === "meta") {
                    return (
                      <View key={i} style={{ flexDirection: "row", alignItems: "center", height: LINE_HEIGHT, paddingLeft: BAR + spacing.sm }}>
                        <SymbolView name="arrow.up.and.down" size={10} tintColor={colors.textFaint} />
                        <RNText style={[cell, { color: colors.textFaint, marginLeft: spacing.sm }]}>{row.text}</RNText>
                      </View>
                    );
                  }
                  const line = row.kind === "del" ? null : row.newLine;
                  return (
                    <View
                      key={i}
                      style={{ flexDirection: "row", backgroundColor: row.kind === "add" ? tint.add : row.kind === "del" ? tint.del : "transparent" }}
                    >
                      <View style={{ width: BAR, backgroundColor: row.change === null ? "transparent" : barColor[row.change] }} />
                      {numbered && (
                        <RNText style={[cell, { color: colors.textFaint, textAlign: "right", paddingHorizontal: spacing.sm }]}>
                          {(line === null ? "" : String(line)).padStart(gutter, " ")}
                        </RNText>
                      )}
                      <RNText style={[cell, { paddingLeft: numbered ? 0 : spacing.sm, paddingRight: spacing.md, color: colors.text }]}>
                        {(tokens[i] ?? []).map((token, j) => {
                          const { style, children } = getTokenProps({ token });
                          return (
                            <RNText key={j} style={{ color: typeof style?.color === "string" ? style.color : colors.text }}>
                              {children}
                            </RNText>
                          );
                        })}
                      </RNText>
                    </View>
                  );
                })}
              </View>
            )}
          </Highlight>
        </ScrollView>
      )}
      {open && hidden > 0 && (
        <Pressable
          hitSlop={8}
          onPress={() => {
            tapHaptic();
            setExpanded(true);
          }}
          style={({ pressed }) => ({ padding: spacing.sm, opacity: pressed ? 0.6 : 1 })}
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
