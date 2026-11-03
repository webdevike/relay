/**
 * Relay's design system for prototypes: the theme Relay Desktop runs with. Desktop ships the shared
 * presets (../theme.ts) with the focus ring off (apps/desktop renderer/theme/theme-config.tsx) and
 * Isaac's install runs the Attio preset (theme.json `preset: attio`, dark: body #17181b). The shell's
 * own `--eva-c-*` names (apps/desktop renderer/styles/tokens.css) are in `css.ts`.
 */
import { THEME_PRESETS, type ThemeConfig } from "../theme";

const attio = THEME_PRESETS.find((p) => p.value === "attio");
if (attio === undefined) throw new Error("the attio preset is missing");

export const RELAY_SYSTEM_CONFIG: ThemeConfig = { ...attio.config, focusRing: "never" };
