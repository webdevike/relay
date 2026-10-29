import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { Chip } from "./Chip";
import { Text } from "./Text";
import { spacing } from "@/theme";

/** Lifts a 28pt chip to a 44pt touch target. */
const HIT_SLOP = { top: 8, bottom: 8, left: 2, right: 2 } as const;

export interface ChipRowOption<K extends string | number> {
  key: K;
  label: string;
  /** VoiceOver label when it should say more than `label`. */
  accessibilityLabel?: string | undefined;
}

export interface ChipRowProps<K extends string | number> {
  /** Small muted name of the choice, above the chips. */
  label?: string;
  options: readonly ChipRowOption<K>[];
  value: K | undefined;
  onChange: (key: K) => void;
  /** Trailing chips after the options, e.g. a "Random" toggle. */
  trailing?: ReactNode;
  /** Horizontal inset of the first and last chip, so the row scrolls edge to edge. */
  inset?: number;
}

/** One pick from a short finite set: a single row of chips that scrolls sideways, the chosen one tinted. */
export function ChipRow<K extends string | number>({ label, options, value, onChange, trailing, inset = spacing.xl }: ChipRowProps<K>) {
  return (
    <View style={{ gap: spacing.xs }}>
      {label !== undefined && (
        <Text variant="caption" color="textMuted" style={{ paddingHorizontal: inset }}>
          {label}
        </Text>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: inset, paddingVertical: spacing.sm }}
      >
        {options.map((option) => (
          <Chip
            key={String(option.key)}
            label={option.label}
            accessibilityLabel={option.accessibilityLabel}
            selected={option.key === value}
            hitSlop={HIT_SLOP}
            onPress={() => {
              onChange(option.key);
            }}
          />
        ))}
        {trailing}
      </ScrollView>
    </View>
  );
}
