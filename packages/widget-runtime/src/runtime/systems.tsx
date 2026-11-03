/**
 * The Mantine side of each design system (../systems): its theme override, CSS variables resolver
 * and the components it adds to a widget's scope. Bundled into the runtime; the page's global CSS
 * and fonts come from ../systems/css.ts.
 */
import * as MantineCore from "@mantine/core";
import {
  Button,
  ScrollArea,
  defaultVariantColorsResolver,
  type CSSVariablesResolver,
  type MantineThemeOverride,
  type VariantColorsResolver,
} from "@mantine/core";
import { ECARD_COMPONENTS } from "../../generated/ecard/components";
import { ECARD_DESIGN } from "../../generated/ecard/design";
import type { DesignSystem } from "../systems";
import { RELAY_SYSTEM_CONFIG } from "../systems/relay";
import { cssVariablesFor, themeOverrideFor } from "../theme";

export interface SystemTheme {
  theme: MantineThemeOverride;
  resolver: CSSVariablesResolver | undefined;
}

/** eCard's theme.ts rebuilt from the snapshot: its palettes, type and radius scales, Button, ScrollArea and Input. */
function ecardTheme(): MantineThemeOverride {
  const d = ECARD_DESIGN;
  const variantColorResolver: VariantColorsResolver = (input) => {
    const custom = d.variants.custom[input.variant];
    if (custom !== undefined) return custom;
    const mapped = d.variants.map[input.variant];
    return defaultVariantColorsResolver(
      mapped === undefined ? input : { ...input, variant: mapped },
    );
  };
  return {
    colors: d.theme.colors,
    primaryColor: d.theme.primaryColor,
    fontFamily: d.theme.fontFamily,
    fontFamilyMonospace: d.theme.fontFamilyMonospace,
    headings: { fontFamily: d.theme.headingsFontFamily },
    radius: d.theme.radius,
    fontSizes: d.theme.fontSizes,
    variantColorResolver,
    components: {
      Button: Button.extend({
        vars: (_theme, props) => {
          const table =
            props.color === undefined || props.color === "primary"
              ? d.button.vars.primary
              : d.button.vars.other;
          return { root: table[props.variant ?? "(none)"] ?? table["(other)"] ?? {} };
        },
        styles: { root: d.button.rootStyles },
        classNames: d.button.classNames,
      }),
      ScrollArea: ScrollArea.extend({
        vars: () => ({ root: d.scrollArea.vars }),
        classNames: d.scrollArea.classNames,
      }),
      Input: { defaultProps: { radius: d.inputDefaultRadius } },
    },
  };
}

export function systemTheme(system: DesignSystem): SystemTheme {
  switch (system) {
    case "relay":
      return {
        theme: themeOverrideFor(RELAY_SYSTEM_CONFIG),
        resolver: () => cssVariablesFor(RELAY_SYSTEM_CONFIG),
      };
    case "ecard":
      return { theme: ecardTheme(), resolver: () => ECARD_DESIGN.cssVariables };
    case "mantine":
      return { theme: {}, resolver: undefined };
  }
}

/** Names a system adds to a widget's scope: eCard's `Base*` facades and copied components. */
export function systemScope(system: DesignSystem | undefined): Record<string, unknown> {
  if (system !== "ecard") return {};
  const mantine = MantineCore as unknown as Record<string, unknown>;
  const scope: Record<string, unknown> = {};
  for (const [base, name] of Object.entries(ECARD_DESIGN.facades))
    if (mantine[name] !== undefined) scope[base] = mantine[name];
  return { ...scope, ...ECARD_COMPONENTS };
}
