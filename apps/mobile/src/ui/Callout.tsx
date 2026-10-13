import { View } from "react-native";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { radii, spacing, toneFill, useColors, withAlpha, type ToneToken } from "@/theme";
import { Text } from "./Text";

const icon: Record<ToneToken, SFSymbol> = {
  accent: "info.circle",
  ok: "checkmark.circle",
  warn: "exclamationmark.triangle",
  danger: "xmark.octagon",
  textMuted: "info.circle",
};

export interface CalloutProps {
  text: string;
  title?: string | undefined;
  tone?: ToneToken;
}

/** A note set apart on a low-alpha tone fill with a hairline in the tone, led by the tone's icon. */
export function Callout({ text, title, tone = "accent" }: CalloutProps) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        gap: spacing.sm,
        padding: spacing.md,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: tone === "textMuted" ? colors.hairline : withAlpha(colors[tone], 0.32),
        backgroundColor: toneFill(colors, tone, 0.1),
      }}
    >
      <SymbolView name={icon[tone]} size={16} tintColor={colors[tone]} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        {title !== undefined && title !== "" && <Text variant="label">{title}</Text>}
        <Text variant="body">{text}</Text>
      </View>
    </View>
  );
}
