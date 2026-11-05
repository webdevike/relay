/**
 * A preset's own inputs under the model row: a choice as the composer's chip row (a sheet past six
 * options), a number as a stepper clamped to its range. Shows `params[id] ?? default`; a change
 * goes back as a new `params` for the draft.
 */
import { useState } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { StudioInput } from "@relay/protocol";
import { spacing, useColors } from "@/theme";
import { ChipRow } from "@/ui/ChipRow";
import { IconButton } from "@/ui/IconButton";
import { OptionRow } from "@/ui/OptionRow";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { stepParam, type StudioParams } from "./draft";

/** Up to this many options show as chips; more open a sheet. */
const CHIP_LIMIT = 6;

export interface PresetInputsProps {
  inputs: readonly StudioInput[];
  params: StudioParams | undefined;
  onChange: (params: StudioParams) => void;
}

export function PresetInputs({ inputs, params, onChange }: PresetInputsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const colors = useColors();
  const set = (id: string, value: string | number) => {
    onChange({ ...params, [id]: value });
  };
  const picking = inputs.find((input) => input.id === open && input.kind === "choice");

  return (
    <>
      {inputs.map((input) => {
        const value = params?.[input.id] ?? input.default;
        if (input.kind === "number") {
          const current = Number(value);
          return (
            <View key={input.id} style={{ paddingHorizontal: spacing.xl, gap: spacing.xs }}>
              <Text variant="caption" color="textMuted">
                {input.label}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <IconButton
                  symbol="minus"
                  size={36}
                  disabled={current <= input.min}
                  accessibilityLabel={`Lower ${input.label}`}
                  onPress={() => {
                    set(input.id, stepParam(input, current, -1));
                  }}
                />
                <Text variant="title" tabular style={{ minWidth: 48, textAlign: "center" }}>
                  {String(current)}
                </Text>
                <IconButton
                  symbol="plus"
                  size={36}
                  disabled={current >= input.max}
                  accessibilityLabel={`Raise ${input.label}`}
                  onPress={() => {
                    set(input.id, stepParam(input, current, 1));
                  }}
                />
              </View>
            </View>
          );
        }
        if (input.options.length <= CHIP_LIMIT) {
          return (
            <ChipRow
              key={input.id}
              label={input.label}
              options={input.options.map((option) => ({ key: option.id, label: option.label }))}
              value={String(value)}
              onChange={(id) => {
                set(input.id, id);
              }}
            />
          );
        }
        const chosen = input.options.find((option) => option.id === value)?.label ?? String(value);
        return (
          <Pressable
            key={input.id}
            accessibilityRole="button"
            accessibilityLabel={`${input.label}, ${chosen}`}
            onPress={() => {
              setOpen(input.id);
            }}
            style={({ pressed }) => ({
              minHeight: 52,
              flexDirection: "row",
              alignItems: "center",
              gap: spacing.md,
              paddingHorizontal: spacing.xl,
              backgroundColor: pressed ? colors.surfaceRaised : "transparent",
            })}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="caption" color="textMuted">
                {input.label}
              </Text>
              <Text variant="title" numberOfLines={1}>
                {chosen}
              </Text>
            </View>
            <SymbolView name="chevron.right" size={13} tintColor={colors.textFaint} />
          </Pressable>
        );
      })}
      <Sheet
        visible={picking !== undefined}
        onClose={() => {
          setOpen(null);
        }}
      >
        {picking?.kind === "choice" && (
          <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
            <Text variant="title">{picking.label}</Text>
            {picking.options.map((option) => (
              <OptionRow
                key={option.id}
                label={option.label}
                selected={option.id === (params?.[picking.id] ?? picking.default)}
                onPress={() => {
                  set(picking.id, option.id);
                  setOpen(null);
                }}
              />
            ))}
          </View>
        )}
      </Sheet>
    </>
  );
}
