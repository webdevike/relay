/**
 * The global CSS a prototype page loads after Mantine's own styles, per design system: the
 * product's stylesheet, its token names and its fonts (inlined, the page has no network). The
 * Mantine theme and the scheme-dependent variables come from the runtime (runtime/systems.tsx).
 */
import { ECARD_FONT_CSS } from "../../generated/ecard/font";
import { ECARD_CSS } from "../../generated/ecard/styles";
import type { DesignSystem } from "./index";

/**
 * Relay Desktop's shell names for the Mantine variables (apps/desktop renderer/styles/tokens.css,
 * the color, type and radius aliases) and its body: small type on the theme's body color.
 */
const RELAY_CSS = `:root {
  --eva-font-ui: var(--mantine-font-family);
  --eva-font-code: var(--mantine-font-family-monospace);
  --eva-font-size: var(--mantine-font-size-sm);
  --eva-radius: var(--mantine-radius-default);
  --eva-radius-lg: var(--mantine-radius-lg);
  --eva-card-radius: 10px;
  --eva-space-xs: 4px; --eva-space-sm: 8px; --eva-space-md: 16px; --eva-space-lg: 24px; --eva-space-xl: 32px;
  --eva-fz-caption: calc(var(--eva-font-size) * 11 / 14);
  --eva-fz-label: calc(var(--eva-font-size) * 12 / 14);
  --eva-fz-heading: calc(var(--eva-font-size) * 16 / 14);
  --eva-chat-header-h: 44px;
  --eva-c-background: var(--mantine-color-body);
  --eva-c-foreground: var(--mantine-color-text);
  --eva-c-muted-foreground: var(--mantine-color-dimmed);
  --eva-c-border: var(--mantine-color-default-border);
  --eva-c-accent: var(--mantine-primary-color-filled);
  --eva-c-accent-background: var(--mantine-color-default-hover);
  --eva-c-secondary-background: var(--eva-color-surface);
  --eva-c-muted-background: var(--eva-color-muted);
  --eva-c-popover-background: var(--eva-color-popover);
  --eva-c-primary-background: var(--mantine-primary-color-filled);
  --eva-c-primary-foreground: var(--mantine-primary-color-contrast);
  --eva-c-danger: var(--mantine-color-red-text);
  --eva-c-success: var(--mantine-color-green-text);
  --eva-c-warning: var(--mantine-color-yellow-text);
  --eva-c-sidebar-background: var(--eva-color-surface);
  --eva-c-sidebar-primary-background: var(--mantine-primary-color-light);
  --eva-c-sidebar-primary-foreground: var(--mantine-primary-color-light-color);
  --eva-bg: var(--eva-c-background);
  --eva-surface: var(--eva-c-secondary-background);
  --eva-border: var(--eva-c-border);
  --eva-text: var(--eva-c-foreground);
  --eva-text-dim: var(--eva-c-muted-foreground);
  --eva-accent: var(--eva-c-primary-background);
  --eva-hover: var(--eva-c-accent-background);
  --eva-chrome: var(--eva-c-sidebar-background);
  --eva-nav-active-bg: var(--eva-c-sidebar-primary-background);
  --eva-nav-active-fg: var(--eva-c-sidebar-primary-foreground);
}
body {
  background: var(--eva-bg);
  color: var(--eva-text);
  font-family: var(--eva-font-ui);
  font-size: var(--eva-font-size);
  line-height: 1.45;
}`;

/**
 * eCard ships light only (its ThemeProvider starts light and its tokens are light values), so a
 * dark prototype maps its page tokens onto Mantine's dark palette. Relay's adaptation, not eCard's.
 * `:root[...]` outranks the `:root` block eCard's resolver injects after this sheet.
 */
const ECARD_DARK_CSS = `:root[data-mantine-color-scheme="dark"] {
  --color-background-main: var(--mantine-color-dark-8);
  --color-primary-main: var(--mantine-color-text);
  --color-secondary-main: var(--mantine-color-dimmed);
  --color-stroke-main: var(--mantine-color-dark-4);
  --color-shell: var(--mantine-color-dark-7);
  --color-shell-hover: var(--mantine-color-dark-6);
  --color-shell-edge: var(--mantine-color-dark-4);
  --color-shell-rule: var(--mantine-color-dark-5);
  --primary-main: var(--mantine-color-text);
}`;

export function systemCss(system: DesignSystem): string {
  switch (system) {
    case "relay":
      return RELAY_CSS;
    case "ecard":
      return `${ECARD_FONT_CSS}\n${ECARD_CSS}\n${ECARD_DARK_CSS}`;
    case "mantine":
      return "";
  }
}
