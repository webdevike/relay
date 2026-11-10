/**
 * The small pieces every Rooms screen builds from, sized for a phone: 13pt secondary text at the
 * smallest, 44pt tap targets. Flat bordered blocks and hairline rows, no shadows.
 */
import type { ReactNode } from "react";
import { Pressable, TextInput, View, type StyleProp, type ViewStyle } from "react-native";
import { selectHaptic } from "@/lib/haptics";
import { radii, spacing, toneFill, useColors, useScheme, withAlpha, type ToneToken } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { Text } from "@/ui/Text";

export const TAP = 44;

/** A short label on a tinted capsule (role, part, status). 13pt. */
export function Tag({ label, tone = "textMuted", tint }: { label: string; tone?: ToneToken; tint?: string | undefined }) {
  const colors = useColors();
  return (
    <View
      style={{
        backgroundColor: tint === undefined ? toneFill(colors, tone) : withAlpha(tint, 0.18),
        borderRadius: radii.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        alignSelf: "flex-start",
        flexShrink: 1,
      }}
    >
      <Text variant="label" color={tone === "textMuted" ? "textMuted" : tone} numberOfLines={1} style={tint === undefined ? undefined : { color: tint }}>
        {label}
      </Text>
    </View>
  );
}

/** A bordered block on the surface; the one container cards and sections use. */
export function Block({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  return (
    <View style={[{ backgroundColor: colors.surface, borderColor: colors.hairline, borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md }, style]}>
      {children}
    </View>
  );
}

/** Equal-width choice of 44pt segments on a raised track. */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  disabled = false,
  label,
}: {
  options: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  disabled?: boolean;
  label: string;
}) {
  const colors = useColors();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flexDirection: "row", backgroundColor: colors.surfaceRaised, borderRadius: radii.md, padding: 2, opacity: disabled ? 0.5 : 1 }}
    >
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              if (selected) return;
              selectHaptic();
              onChange(option.key);
            }}
            style={{
              flex: 1,
              minHeight: TAP - 4,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radii.sm + 2,
              backgroundColor: selected ? colors.bg : "transparent",
            }}
          >
            <Text variant="label" color={selected ? "text" : "textMuted"} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A section title with a muted line under it. */
export function SectionHead({ title, note }: { title: string; note?: string | undefined }) {
  return (
    <View style={{ gap: 2 }}>
      <Text variant="title">{title}</Text>
      {note !== undefined && <Text variant="label" color="textMuted">{note}</Text>}
    </View>
  );
}

/** One round provider badge: "A" for Anthropic, "O" for OpenAI. */
export const PROVIDER_TINT = { anthropic: "#D97757", openai: "#10A37F" } as const;
export const PROVIDER_LETTER = { anthropic: "A", openai: "O" } as const;
export const PROVIDER_NAME = { anthropic: "Anthropic", openai: "OpenAI" } as const;

/** A bordered text input, at least 48pt tall, 16pt text (no iOS zoom, readable at arm's length). */
export function Field({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  lines = 1,
  mono = false,
}: {
  label: string;
  hint?: string | undefined;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string | undefined;
  lines?: number;
  mono?: boolean;
}) {
  const colors = useColors();
  const scheme = useScheme();
  return (
    <View style={{ gap: spacing.xs + 2 }}>
      <Text variant="body" style={{ fontWeight: "600" }}>{label}</Text>
      {hint !== undefined && <Text variant="label" color="textMuted">{hint}</Text>}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        multiline={lines > 1}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance={scheme}
        selectionColor={colors.accent}
        accessibilityLabel={label}
        textAlignVertical={lines > 1 ? "top" : "center"}
        style={{
          minHeight: lines > 1 ? 24 * lines + spacing.md * 2 : 48,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.md,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.hairline,
          backgroundColor: colors.surface,
          color: colors.text,
          fontSize: 16,
          lineHeight: 22,
          ...(mono ? { fontFamily: "Menlo", fontSize: 14 } : {}),
        }}
      />
    </View>
  );
}

/** The top bar of a Rooms screen: a 44pt back button, the title, and a right-hand slot. */
export function Bar({ title, onBack, right, sub }: { title: string; onBack: () => void; right?: ReactNode; sub?: string | undefined }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingLeft: spacing.sm, paddingRight: spacing.lg, minHeight: 56 }}>
      <IconButton symbol="chevron.left" size={TAP} accessibilityLabel="Back" onPress={onBack} />
      <View style={{ flex: 1, paddingHorizontal: spacing.xs }}>
        <Text variant="title" numberOfLines={1} accessibilityRole="header">{title}</Text>
        {sub !== undefined && <Text variant="label" color="textMuted" numberOfLines={1}>{sub}</Text>}
      </View>
      {right}
    </View>
  );
}
