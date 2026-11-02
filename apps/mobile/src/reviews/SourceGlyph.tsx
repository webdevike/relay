/**
 * Where a Reviews item comes from: its status glyph (a PR, a Linear status circle, a Slack channel
 * or DM), its source's brand mark, and its id as that source writes it.
 */
import { Platform, StyleSheet, View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { ReviewItem, ReviewSource } from "@relay/protocol";
import { spacing, useColors, type ColorToken, type TypeToken } from "@/theme";
import { BrandIcon } from "@/ui/BrandIcon";
import { Text } from "@/ui/Text";
import { reviewItemId } from "./model";

const LINEAR_STATE: Record<string, { symbol: SFSymbol; color: ColorToken }> = {
  triage: { symbol: "circle.dashed", color: "warn" },
  backlog: { symbol: "circle.dashed", color: "textMuted" },
  unstarted: { symbol: "circle", color: "textMuted" },
  started: { symbol: "circle.lefthalf.filled", color: "accent" },
  completed: { symbol: "checkmark.circle.fill", color: "ok" },
  canceled: { symbol: "xmark.circle.fill", color: "textFaint" },
};

/** A Linear workflow state's circle; `color` (the team's own `#RRGGBB`) wins over the type's tone. */
export function LinearStateGlyph({ type, color, size = 20 }: { type: string | undefined; color?: string | undefined; size?: number }) {
  const colors = useColors();
  const state = LINEAR_STATE[type ?? ""] ?? LINEAR_STATE["unstarted"];
  return <SymbolView name={state?.symbol ?? "circle"} size={size} tintColor={color ?? colors[state?.color ?? "textMuted"]} />;
}

export function PrGlyph({ size = 20 }: { size?: number }) {
  const colors = useColors();
  return <SymbolView name="arrow.triangle.pull" size={size} tintColor={colors.ok} />;
}

export function SourceGlyph({ item, size = 20 }: { item: Pick<ReviewItem, "ref" | "slackKind" | "stateType">; size?: number }) {
  const colors = useColors();
  if (item.ref.kind === "github") return <PrGlyph size={size} />;
  if (item.ref.kind === "linear") return <LinearStateGlyph type={item.stateType} size={size} />;
  // The host's label rule: a thread outside a DM channel (`D...`) is its channel, anything else a conversation.
  const dm = item.slackKind === "dm" || item.ref.threadTs === null || item.ref.channel.startsWith("D");
  return <SymbolView name={dm ? "bubble.left" : "number"} size={size} tintColor={colors.textMuted} />;
}

export const SOURCE_NAME: Record<ReviewSource, string> = { github: "GitHub", linear: "Linear", slack: "Slack" };

/** The source's monochrome brand mark (GitHub, Linear, Slack) in `color`, faint by default. */
export function SourceMark({ source, size = 12, color = "textFaint" }: { source: ReviewSource; size?: number; color?: ColorToken }) {
  const colors = useColors();
  return (
    <View accessible accessibilityLabel={SOURCE_NAME[source]} accessibilityRole="image">
      <BrandIcon name={source} size={size} color={colors[color]} />
    </View>
  );
}

const mono = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * The brand mark, then the item's id as its source writes it (`reviewItemId`): a Linear key in mono
 * (`ENG-6693`), a PR as `repo#246`, a Slack channel as `#ui-ux` or `DM`.
 */
export function ReviewId({ item, variant = "caption", color = "textFaint" }: { item: Pick<ReviewItem, "ref" | "label">; variant?: TypeToken; color?: ColorToken }) {
  const linear = item.ref.kind === "linear";
  return (
    <View style={styles.id}>
      <SourceMark source={item.ref.kind} size={variant === "caption" ? 11 : 12} color={color} />
      <Text variant={variant} color={color} numberOfLines={1} style={linear ? styles.mono : undefined}>
        {reviewItemId(item)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  id: { flexDirection: "row", alignItems: "center", gap: spacing.xs, flexShrink: 1 },
  mono: { fontFamily: mono, letterSpacing: -0.3 },
});
