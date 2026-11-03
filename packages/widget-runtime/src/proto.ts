/**
 * Prototypes: a canvas `proto` node's page and the check its JSX passes before it lands. The JSX
 * contract is ```mantine-widget's (a component body or one element, every Mantine name in scope,
 * `relay.reply`); the page draws it as a screen of a real product in a design system (`systems/`):
 * its theme, components, global CSS and fonts, opaque, scrolling inside its card, light or dark.
 * `relay.theme` is null there. Its own module so the phone and chat widgets don't carry the eCard
 * snapshot, its font or Sucrase's checker.
 */
import { WIDGET_RUNTIME_CSS, WIDGET_RUNTIME_JS } from "../generated/bundle";
import { SYSTEM_SCOPE_NAMES, WIDGET_SCOPE_NAMES } from "../generated/scope";
import { MANTINE_FRAME_CSP, bridgeScript, head, scriptJson } from "./frame";
import { checkWidgetSource } from "./runtime/compile";
import type { DesignSystem } from "./systems";
import { systemCss } from "./systems/css";
import { defaultConfig } from "./theme";

/** A prototype page's CSP: the Mantine page's (inline script, eval, data: images and fonts, no network). */
export const PROTO_FRAME_CSP = MANTINE_FRAME_CSP;

/** A prototype's design system and scheme. */
export interface ProtoFrameOptions {
  system: DesignSystem;
  dark: boolean;
}

/** Opaque page chrome: the product's own body color, scrolling inside the frame. */
const PROTO_STYLE = `html, body { margin: 0; min-height: 100%; -webkit-text-size-adjust: 100%; }
body { overflow-wrap: anywhere; -webkit-tap-highlight-color: transparent; }
#root { min-height: 100vh; }`;

/** The full document for a prototype: `source` drawn by the bundled runtime in `system`, after its CSS and fonts. */
export function protoFrameDocument(source: string, { system, dark }: ProtoFrameOptions): string {
  const scheme = dark ? "dark" : "light";
  const mount = { source, config: defaultConfig, colorScheme: scheme, system };
  return `<!doctype html>
<html data-mantine-color-scheme="${scheme}" data-design-system="${system}"><head>
${head(PROTO_FRAME_CSP)}
<style>${WIDGET_RUNTIME_CSS}</style>
<style>${systemCss(system).replaceAll("</style", "<\\/style")}</style>
<style>${PROTO_STYLE}</style>
<script>${bridgeScript(null, dark)}</script>
<script>${WIDGET_RUNTIME_JS}</script>
</head><body>
<div id="root"></div>
<script>RelayWidget.mount(document.getElementById("root"), ${scriptJson(mount)});</script>
</body></html>`;
}

/** The most JSX a prototype may hold. */
export const PROTO_SOURCE_MAX = 60_000;

/**
 * Why a prototype's `source` would not draw in `system`, or null: empty, too long, does not compile,
 * or names a component that is in neither Mantine nor the system (nor defined in the code).
 */
export function protoSourceRefusal(source: string, system: DesignSystem): string | null {
  if (source.trim() === "") return "the prototype has no JSX";
  if (source.length > PROTO_SOURCE_MAX)
    return `the prototype is ${String(source.length)} characters; keep it under ${String(PROTO_SOURCE_MAX)}`;
  return checkWidgetSource(source, new Set([...WIDGET_SCOPE_NAMES, ...SYSTEM_SCOPE_NAMES[system]]));
}
