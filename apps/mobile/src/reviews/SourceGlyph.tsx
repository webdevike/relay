/** The glyph that says where a Reviews item comes from: a PR, a Linear status circle, a Slack channel or DM. */
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { ReviewItem } from "@relay/protocol";
import { useColors, type ColorToken } from "@/theme";

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
  // A DM channel (`D...`) reads as a conversation whatever the kind; a mention there is still a DM.
  const dm = item.slackKind === "dm" || item.ref.channel.startsWith("D");
  return <SymbolView name={dm ? "bubble.left" : "number"} size={size} tintColor={colors.textMuted} />;
}
