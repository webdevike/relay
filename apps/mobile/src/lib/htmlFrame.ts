/**
 * The page an `HtmlFrame` loads: agent-written HTML wrapped in a locked-down document (no network,
 * no zoom, no callouts, transparent, system font), the app's palette as CSS variables, and the
 * `window.relay` bridge. The page reports its content height and replies back as JSON messages.
 */
import { z } from "zod";

export interface HtmlFrameTheme {
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

const HtmlFrameMessageSchema = z.discriminatedUnion("type", [
  /** The content height in points, sent on load and whenever it changes. */
  z.object({ type: z.literal("height"), height: z.number().finite().nonnegative() }),
  /** `relay.reply(text)` from a user gesture: send `text` as the next message. */
  z.object({ type: z.literal("reply"), text: z.string().refine((text) => text.trim() !== "") }),
]);
export type HtmlFrameMessage = z.infer<typeof HtmlFrameMessageSchema>;

/** No network, no frames, no plugins: only the page's own inline script, style and data: images. */
export const HTML_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

function baseStyle(theme: HtmlFrameTheme): string {
  const { colors, font, radius } = theme;
  return `:root {
  color-scheme: ${theme.dark ? "dark" : "light"};
  --fg: ${colors.fg}; --muted: ${colors.muted}; --faint: ${colors.faint}; --border: ${colors.border};
  --surface: ${colors.surface}; --raised: ${colors.raised}; --accent: ${colors.accent};
  --ok: ${colors.ok}; --warn: ${colors.warn}; --danger: ${colors.danger}; --bg: ${colors.bg};
  --font: ${font.family}; --mono: ${font.mono};
  --radius-sm: ${radius.sm}px; --radius: ${radius.md}px; --radius-lg: ${radius.lg}px;
}
html { background: transparent; -webkit-text-size-adjust: 100%; }
body {
  margin: 0; padding: 0; display: flow-root; background: transparent; color: var(--fg);
  font-family: var(--font); font-size: ${font.size}px; line-height: ${font.lineHeight}px;
  -webkit-touch-callout: none; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation; overflow-wrap: anywhere;
}
input, textarea, [contenteditable] { -webkit-user-select: text; user-select: text; }
button, input, select, textarea { font: inherit; color: inherit; }
code, pre, kbd, samp { font-family: var(--mono); }
img, svg, canvas, video { max-width: 100%; }`;
}

/**
 * The bridge runs before the agent's markup. `relay.reply` only sends during a user gesture, so a
 * widget that calls it on load cannot send a message every time the transcript is shown. The theme
 * JSON escapes `<` (and the JS line separators) so it cannot close the script element.
 */
function bridgeScript(theme: HtmlFrameTheme): string {
  const themeJson = JSON.stringify(theme).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `(function () {
  function post(message) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }
  window.relay = Object.freeze({
    theme: Object.freeze(${themeJson}),
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
export function htmlFrameDocument(body: string, theme: HtmlFrameTheme): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<style>${baseStyle(theme)}</style>
<script>${bridgeScript(theme)}</script>
</head><body>
${body}
</body></html>`;
}

/** A message the page posted, or null for anything else. */
export function parseHtmlFrameMessage(data: string): HtmlFrameMessage | null {
  try {
    const parsed = HtmlFrameMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
