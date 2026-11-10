/**
 * The pages agent-made widgets run in, shared by the phone (`react-native-webview`) and the desktop
 * (sandboxed `<iframe srcdoc>`). Both are locked down: no network, no navigation, no zoom, no
 * callouts, transparent so they sit on the chat. Each page gets `window.relay` = `{ theme,
 * colorScheme, reply(text) }` and posts JSON messages to its host: its content height whenever it
 * changes, and `relay.reply` text (only during a user gesture).
 *
 * - ```html-widget: `htmlFrameDocument`, the agent's HTML fragment with the host palette as CSS
 *   variables (`--fg`, `--muted`, `--accent`, ...).
 * - ```mantine-widget: `mantineFrameDocument`, the agent's JSX evaluated by the bundled Mantine
 *   runtime (`runtime/index.tsx`) with the shared theme (`theme.ts`).
 * - a canvas `proto` node: `proto.ts`, built from the pieces exported here.
 */
import { WIDGET_RUNTIME_CSS, WIDGET_RUNTIME_JS } from "../generated/bundle";
import { defaultConfig, type ThemeConfig } from "./theme";

/** The host's palette and type, as CSS variables in the page and `relay.theme` in script. */
export interface FrameTheme {
  dark: boolean;
  colors: {
    fg: string;
    muted: string;
    faint: string;
    border: string;
    surface: string;
    raised: string;
    accent: string;
    ok: string;
    warn: string;
    danger: string;
    /** Always transparent: the page sits on the chat. */
    bg: string;
  };
  font: { family: string; mono: string; size: number; lineHeight: number };
  radius: { sm: number; md: number; lg: number };
}

export type FrameMessage =
  /** The content height in CSS pixels, sent on load and whenever it changes. */
  | { type: "height"; height: number }
  /** `relay.reply(text)` from a user gesture: send `text` as the next message. */
  | { type: "reply"; text: string };

/** No network, no frames, no plugins: only the page's own inline script, style and data: images. */
export const HTML_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

/**
 * The Mantine page also evaluates the agent's compiled JSX (`new Function`), hence `unsafe-eval`;
 * still nothing can load from or send to the network.
 */
export const MANTINE_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** JSON safe inside a <script> element: `<` and the JS line separators are escaped. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The page head every frame shares: charset, the CSP as a meta tag, a fixed viewport. */
export function head(csp: string): string {
  return `<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">`;
}

/**
 * Page chrome both kinds share: transparent, no callouts or selection outside inputs. Scrollbars
 * never take width: a classic (non-overlay) scrollbar that came and went while the frame sized
 * itself would narrow the page, shrink width-driven content (an AspectRatio, a `w="100%"` image),
 * change the height the page reports, and settle with a stray scrollbar. Wheel and touch still scroll.
 */
const CHROME_STYLE = `html, body { background: transparent !important; -webkit-text-size-adjust: 100%; scrollbar-width: none; }
::-webkit-scrollbar { display: none; }
body {
  margin: 0; padding: 0; display: flow-root;
  -webkit-touch-callout: none; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation; overflow-wrap: anywhere;
}
input, textarea, [contenteditable] { -webkit-user-select: text; user-select: text; }
img, svg, canvas, video { max-width: 100%; }`;

function paletteStyle(theme: FrameTheme): string {
  const { colors, font, radius } = theme;
  return `:root {
  color-scheme: ${theme.dark ? "dark" : "light"};
  --fg: ${colors.fg}; --muted: ${colors.muted}; --faint: ${colors.faint}; --border: ${colors.border};
  --surface: ${colors.surface}; --raised: ${colors.raised}; --accent: ${colors.accent};
  --ok: ${colors.ok}; --warn: ${colors.warn}; --danger: ${colors.danger}; --bg: ${colors.bg};
  --font: ${font.family}; --mono: ${font.mono};
  --radius-sm: ${radius.sm}px; --radius: ${radius.md}px; --radius-lg: ${radius.lg}px;
}`;
}

function htmlStyle(theme: FrameTheme): string {
  const { font } = theme;
  return `${paletteStyle(theme)}
${CHROME_STYLE}
body { color: var(--fg); font-family: var(--font); font-size: ${font.size}px; line-height: ${font.lineHeight}px; }
button, input, select, textarea { font: inherit; color: inherit; }
code, pre, kbd, samp { font-family: var(--mono); }`;
}

/**
 * The bridge runs before the agent's code. `relay.reply` only sends during a user gesture, so a
 * widget that calls it on load cannot send a message every time the transcript is shown. Messages
 * go to `ReactNativeWebView` on the phone and to the parent window (as a JSON string) on desktop.
 */
export function bridgeScript(theme: FrameTheme | null, dark: boolean): string {
  return `(function () {
  function post(message) {
    var data = JSON.stringify(message);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(data);
    else if (window.parent && window.parent !== window) window.parent.postMessage(data, "*");
  }
  var theme = ${scriptJson(theme)};
  window.relay = Object.freeze({
    theme: theme && Object.freeze(theme),
    colorScheme: ${scriptJson(dark ? "dark" : "light")},
    reply: function (text) {
      if (typeof text !== "string" || text.trim() === "") return false;
      if (navigator.userActivation && !navigator.userActivation.isActive) return false;
      post({ type: "reply", text: text });
      return true;
    },
  });
  var last = -1;
  function measure() {
    var body = document.body;
    if (!body) return;
    var height = Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight));
    if (height !== last) {
      last = height;
      post({ type: "height", height: height });
    }
  }
  document.addEventListener("DOMContentLoaded", function () {
    new ResizeObserver(measure).observe(document.body);
    measure();
  });
  window.addEventListener("load", measure);
})();`;
}

/** The full document for `body`, the agent's HTML fragment. */
export function htmlFrameDocument(body: string, theme: FrameTheme): string {
  return `<!doctype html>
<html><head>
${head(HTML_FRAME_CSP)}
<style>${htmlStyle(theme)}</style>
<script>${bridgeScript(theme, theme.dark)}</script>
</head><body>
${body}
</body></html>`;
}

/** How a Mantine page sits in its host. */
export interface MantineFrameOptions {
  /**
   * A fixed-size box (a dashboard tile with a height): the page, `#root` and so `h="100%"` fill it,
   * taller content scrolls inside. Otherwise the page is as tall as its content.
   */
  fill?: boolean;
}

/** A filled page: html, body and the root all take the frame's height. */
const FILL_STYLE = `html, body, #root { height: 100%; }
body { overflow: auto; }
#root { padding: 0; }`;

/**
 * The full document for `source`, the agent's JSX (a component body, or one JSX element), drawn by
 * the bundled Mantine runtime with the shared theme `config` (the Default preset unless the host has
 * its own, as the desktop theme editor does) in the host's light or dark scheme. The frame's
 * viewport is the box it sits in, so `useViewportSize()` in the JSX reads that box's width and height.
 */
export function mantineFrameDocument(
  source: string,
  theme: FrameTheme,
  config: ThemeConfig = defaultConfig,
  { fill = false }: MantineFrameOptions = {},
): string {
  const scheme = theme.dark ? "dark" : "light";
  const mount = { source, config, colorScheme: scheme };
  return `<!doctype html>
<html data-mantine-color-scheme="${scheme}"><head>
${head(MANTINE_FRAME_CSP)}
<style>${WIDGET_RUNTIME_CSS}</style>
<style>${paletteStyle(theme)}
${CHROME_STYLE}
#root { padding: 1px 0; }${fill ? `\n${FILL_STYLE}` : ""}</style>
<script>${bridgeScript(theme, theme.dark)}</script>
<script>${WIDGET_RUNTIME_JS}</script>
</head><body>
<div id="root"></div>
<script>RelayWidget.mount(document.getElementById("root"), ${scriptJson(mount)});</script>
</body></html>`;
}

/** A message the page posted (a JSON string), or null for anything else. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message["type"] === "height") {
    const height = message["height"];
    return typeof height === "number" && Number.isFinite(height) && height >= 0
      ? { type: "height", height }
      : null;
  }
  if (message["type"] === "reply") {
    const text = message["text"];
    return typeof text === "string" && text.trim() !== "" ? { type: "reply", text } : null;
  }
  return null;
}
