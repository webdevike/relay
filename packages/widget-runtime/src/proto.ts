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
import { defaultConfig, type ThemeConfig } from "./theme";

/** A prototype page's CSP: the Mantine page's (inline script, eval, data: and https images, data: fonts, nothing else from the network). */
export const PROTO_FRAME_CSP = MANTINE_FRAME_CSP;

/** A prototype's design system and scheme. */
export interface ProtoFrameOptions {
  system: DesignSystem;
  dark: boolean;
  /** The `relay` system as the host runs it (Relay Desktop's Settings > Theme), not the snapshot. */
  relayConfig?: ThemeConfig | undefined;
  /**
   * A live page (a canvas card on desktop): it takes new source from its parent window
   * (frame.ts `liveSourceMessage`) without reloading, keeps the last good render, and answers each
   * revision with a `render` frame message. It is a frame of a fixed size: what does not fit is
   * clipped, not scrolled, and the page reports its content size (`content` frame messages).
   */
  live?: boolean | undefined;
  /** The assistant registry, so the `relay` kit's `agent="nova"` draws Nova's real portrait. */
  assistants?: Readonly<Record<string, ProtoAssistant>> | undefined;
}

/**
 * One registry assistant as a prototype page gets it: its name and its avatar (a notionists seed
 * or a designed portrait, @evaos/contract AssistantPortrait), drawn by the kit (relay-kit.tsx).
 */
export interface ProtoAssistant {
  title: string;
  avatar: string | Readonly<Record<string, unknown>>;
}

/**
 * Opaque page chrome: the product's own body color, scrolling inside the frame. `#root` is a flow
 * root so a first child's top margin (the badge strip's 10px) stays inside the frame, as in the app.
 */
const PROTO_STYLE = `html, body { margin: 0; min-height: 100%; -webkit-text-size-adjust: 100%; }
body { overflow-wrap: anywhere; -webkit-tap-highlight-color: transparent; }
#root { min-height: 100vh; display: flow-root; }`;

/** A live page is a fixed frame: it clips, like an artboard. */
const LIVE_STYLE = `html, body { overflow: hidden; }`;

/** The full document for a prototype: `source` drawn by the bundled runtime in `system`, after its CSS and fonts. */
export function protoFrameDocument(
  source: string,
  { system, dark, relayConfig, live, assistants }: ProtoFrameOptions,
): string {
  const scheme = dark ? "dark" : "light";
  const mount = {
    source,
    config: defaultConfig,
    colorScheme: scheme,
    system,
    ...(system === "relay" && relayConfig !== undefined ? { systemConfig: relayConfig } : {}),
    ...(live === true ? { live: true } : {}),
    ...(system === "relay" && assistants !== undefined ? { assistants } : {}),
  };
  return `<!doctype html>
<html data-mantine-color-scheme="${scheme}" data-design-system="${system}"><head>
${head(PROTO_FRAME_CSP)}
<style>${WIDGET_RUNTIME_CSS}</style>
<style>${systemCss(system).replaceAll("</style", "<\\/style")}</style>
<style>${PROTO_STYLE}${live === true ? LIVE_STYLE : ""}</style>
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
