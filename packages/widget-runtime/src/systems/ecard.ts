/**
 * The shape of the eCard design-system snapshot (generated/ecard/design.ts), written by
 * scripts/sync-ecard-design.ts from eCard's `src/design-system` (theme.ts, tokens.ts, cssTokens.ts,
 * variantColorResolver.ts, components/Base*.tsx). Values are eCard's own, evaluated by the script:
 * Button vars per variant come from calling its theme's `vars` function, the variant mapping from
 * calling its `variantColorResolver`. Types only.
 */
import type { MantineColorsTuple } from "@mantine/core";

export interface EcardDesign {
  source: {
    repo: string;
    ref: string;
    commit: string;
    committedAt: string;
    files: string[];
    /** Components not copied, with the import that kept them out. */
    skipped: Record<string, string>;
  };
  theme: {
    colors: Record<string, MantineColorsTuple>;
    primaryColor: string;
    fontFamily: string;
    fontFamilyMonospace: string;
    headingsFontFamily: string;
    radius: Record<string, string>;
    fontSizes: Record<string, string>;
  };
  /** eCard's `cssVariablesResolver()` output. */
  cssVariables: {
    variables: Record<string, string>;
    light: Record<string, string>;
    dark: Record<string, string>;
  };
  button: {
    /** Button root vars by variant (`(none)` unset, `(other)` any variant not listed), for the primary color and for any other. */
    vars: {
      primary: Record<string, Record<string, string>>;
      other: Record<string, Record<string, string>>;
    };
    rootStyles: Record<string, string | number>;
    classNames: Record<string, string>;
  };
  scrollArea: { vars: Record<string, string>; classNames: Record<string, string> };
  inputDefaultRadius: string;
  variants: {
    /** eCard variant names drawn as a Mantine variant (`contained` -> `filled`). */
    map: Record<string, string>;
    /** Variants eCard draws itself (`quiet`): Mantine's variant colors. */
    custom: Record<
      string,
      { background: string; hover: string; color: string; border: string; hoverColor?: string }
    >;
  };
  /** `BaseX` facades that are plain Mantine components: Base name -> Mantine name. */
  facades: Record<string, string>;
}
