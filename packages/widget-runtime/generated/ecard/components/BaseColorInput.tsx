// @ts-nocheck: copied verbatim from eCardSystems/react-client-reports-app@0f691613 src/design-system/components/BaseColorInput.tsx by scripts/sync-ecard-design.ts (CSS module import inlined as its class map); type-checked in its own repo.
// Base facade over Mantine ColorInput. Pages import BaseX from @design-system, never @mantine/core.
// Stock Mantine field chrome (6px radius from the theme) with the BaseTextInput label (so color labels
// match text-input labels), and description and error below the input. Mantine props passed explicitly win.
import {
  ColorInput, type ColorInputProps,
} from "@mantine/core";
const textInputStyles: Record<string, string> = {"label":"ecard-BaseTextInput-label"};

export type BaseColorInputProps = ColorInputProps;

export function BaseColorInput(props: BaseColorInputProps) {
  return (
    <ColorInput
      classNames={{ label: textInputStyles["label"] }}
      inputWrapperOrder={[
        "label",
        "input",
        "description",
        "error",
      ]}
      {...props}
    />
  );
}
