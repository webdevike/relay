import { describe, expect, it } from "vitest";
import { HTML_FRAME_CSP, htmlFrameDocument, parseHtmlFrameMessage, type HtmlFrameTheme } from "./htmlFrame";

const THEME: HtmlFrameTheme = {
  dark: true,
  colors: {
    fg: "#EDEDED",
    muted: "#9A9AA3",
    faint: "#6B6B75",
    border: "rgba(255,255,255,0.08)",
    surface: "#141416",
    raised: "#1C1C1F",
    accent: "#7C9CFF",
    ok: "#4ADE80",
    warn: "#FBBF24",
    danger: "#F87171",
    bg: "transparent",
  },
  font: { family: "-apple-system", mono: "Menlo", size: 17, lineHeight: 26 },
  radius: { sm: 6, md: 10, lg: 14 },
};

describe("htmlFrameDocument", () => {
  it("locks the page down and themes it before the agent's markup", () => {
    const doc = htmlFrameDocument("<p>hi</p>", THEME);
    const csp = doc.indexOf(HTML_FRAME_CSP);
    const content = doc.indexOf("<p>hi</p>");
    expect(csp).toBeGreaterThan(0);
    expect(doc.indexOf("--accent: #7C9CFF")).toBeLessThan(content);
    expect(doc.indexOf("window.relay")).toBeLessThan(content);
    expect(doc).toContain("user-scalable=no");
    expect(doc).toContain("color-scheme: dark");
    expect(csp).toBeLessThan(content);
  });

  it("keeps theme strings from closing the bridge script", () => {
    const doc = htmlFrameDocument("", { ...THEME, font: { ...THEME.font, family: "</script><b>x" } });
    expect(doc).toContain("\\u003c/script>\\u003cb>x");
  });
});

describe("parseHtmlFrameMessage", () => {
  it("reads height and reply messages", () => {
    expect(parseHtmlFrameMessage('{"type":"height","height":212}')).toEqual({ type: "height", height: 212 });
    expect(parseHtmlFrameMessage('{"type":"reply","text":"Count is 3"}')).toEqual({ type: "reply", text: "Count is 3" });
  });

  it("drops anything else", () => {
    expect(parseHtmlFrameMessage("not json")).toBeNull();
    expect(parseHtmlFrameMessage('{"type":"height","height":-1}')).toBeNull();
    expect(parseHtmlFrameMessage('{"type":"reply","text":"  "}')).toBeNull();
    expect(parseHtmlFrameMessage('{"type":"navigate","url":"https://x.test"}')).toBeNull();
  });
});
