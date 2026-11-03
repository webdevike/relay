// @ts-nocheck: copied verbatim from eCardSystems/react-client-reports-app@0f691613 src/design-system/components/BaseTextarea.tsx by scripts/sync-ecard-design.ts (CSS module import inlined as its class map); type-checked in its own repo.
// Base facade over Mantine Textarea. Pages import BaseX from @design-system, never @mantine/core.
// Adds the eCard field look on top of the Mantine API: the BaseTextInput label (so single- and
// multi-line labels match), description and error below the input, and wrapped text. Mantine props
// passed explicitly win.
import {
  Textarea, type TextareaProps,
} from "@mantine/core";
const textInputStyles: Record<string, string> = {"label":"ecard-BaseTextInput-label"};

export type BaseTextareaProps = TextareaProps;

export function BaseTextarea(props: BaseTextareaProps) {
  return (
    <Textarea
      classNames={{ label: textInputStyles["label"] }}
      inputWrapperOrder={[
        "label",
        "input",
        "description",
        "error",
      ]}
      styles={{ input: { whiteSpace: "pre-wrap" } }}
      {...props}
    />
  );
}
