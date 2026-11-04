// @ts-nocheck: copied verbatim from eCardSystems/react-client-reports-app@0f691613 src/design-system/components/BaseNumberInput.tsx by scripts/sync-ecard-design.ts (CSS module import inlined as its class map); type-checked in its own repo.
// Base facade over Mantine NumberInput. Pages import BaseX from @design-system, never @mantine/core.
// Stock Mantine field chrome and up/down stepper controls (6px radius from the theme) with the shared
// eCard field label, and Mantine's loader in place of the controls while loading. Mantine props passed
// explicitly win over the eCard defaults.
import { NumberInput, type NumberInputProps } from "@mantine/core";
const textInputStyles: Record<string, string> = { label: "ecard-BaseTextInput-label" };

export type BaseNumberInputProps = NumberInputProps & {
  /** Shows Mantine's loader instead of the stepper controls and "Loading..." as the placeholder. */
  isLoading?: boolean;
};

export function BaseNumberInput({
  isLoading = false,
  placeholder = "Enter a number",
  hideControls = false,
  ...props
}: BaseNumberInputProps) {
  return (
    <NumberInput
      placeholder={isLoading ? "Loading..." : placeholder}
      hideControls={hideControls || isLoading}
      loading={isLoading}
      classNames={{ label: textInputStyles["label"] }}
      inputWrapperOrder={["label", "input", "description", "error"]}
      {...props}
    />
  );
}
