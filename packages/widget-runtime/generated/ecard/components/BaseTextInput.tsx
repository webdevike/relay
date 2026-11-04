// @ts-nocheck: copied verbatim from eCardSystems/react-client-reports-app@0f691613 src/design-system/components/BaseTextInput.tsx by scripts/sync-ecard-design.ts (CSS module import inlined as its class map); type-checked in its own repo.
// Base facade over Mantine TextInput. Pages import BaseX from @design-system, never @mantine/core.
// Stock Mantine field chrome (1px border, primary focus border, error and disabled states; 6px radius
// from the theme) with the shared eCard field label, and description and error below the input.
// Mantine props passed explicitly win over the eCard defaults.
import { TextInput, type TextInputProps } from "@mantine/core";
const styles: Record<string, string> = { label: "ecard-BaseTextInput-label" };

export type BaseTextInputProps = TextInputProps;

export function BaseTextInput(props: BaseTextInputProps) {
  return (
    <TextInput
      classNames={{ label: styles["label"] }}
      inputWrapperOrder={["label", "input", "description", "error"]}
      {...props}
    />
  );
}
