import { describe, expect, it } from "vitest";
import {
  HTML_FRAME_CSP,
  MANTINE_FRAME_CSP,
  htmlFrameDocument,
  mantineFrameDocument,
  parseFrameMessage,
  type FrameTheme,
} from "../src/frame";
import { THEME_PRESETS } from "../src/theme";

const THEME: FrameTheme = {
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
    const doc = htmlFrameDocument("", {
      ...THEME,
      font: { ...THEME.font, family: "</script><b>x" },
    });
    expect(doc).toContain("\\u003c/script>\\u003cb>x");
  });

  it("posts to the phone web view or the desktop parent window", () => {
    const doc = htmlFrameDocument("", THEME);
    expect(doc).toContain("window.ReactNativeWebView.postMessage(data)");
    expect(doc).toContain('window.parent.postMessage(data, "*")');
  });
});

describe("mantineFrameDocument", () => {
  it("runs the bundled runtime offline in the host's scheme with the shared theme", () => {
    const ocean = THEME_PRESETS.find((preset) => preset.value === "ocean");
    if (ocean === undefined) throw new Error("no ocean preset");
    const doc = mantineFrameDocument("return <Button>Hi</Button>;", THEME, ocean.config);
    expect(doc).toContain(MANTINE_FRAME_CSP);
    expect(doc).not.toContain("connect-src");
    expect(doc).toContain('data-mantine-color-scheme="dark"');
    expect(doc).toContain("RelayWidget.mount");
    expect(doc).toContain('"primaryColor":"cyan"');
    expect(doc.indexOf("window.relay")).toBeLessThan(doc.indexOf("RelayWidget.mount"));
  });

  it("keeps the agent's source from closing the mount script", () => {
    const doc = mantineFrameDocument("return <p>{'</script><b>x'}</p>;", THEME);
    const mount = doc.slice(doc.lastIndexOf("<script>"));
    expect(mount).toContain("\\u003c/script>\\u003cb>x");
    expect(mount.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("parseFrameMessage", () => {
  it("reads height and reply messages", () => {
    expect(parseFrameMessage('{"type":"height","height":212}')).toEqual({
      type: "height",
      height: 212,
    });
    expect(parseFrameMessage('{"type":"reply","text":"Count is 3"}')).toEqual({
      type: "reply",
      text: "Count is 3",
    });
  });

  it("drops anything else", () => {
    expect(parseFrameMessage("not json")).toBeNull();
    expect(parseFrameMessage({ type: "height", height: 1 })).toBeNull();
    expect(parseFrameMessage('{"type":"height","height":-1}')).toBeNull();
    expect(parseFrameMessage('{"type":"reply","text":"  "}')).toBeNull();
    expect(parseFrameMessage('{"type":"navigate","url":"https://x.test"}')).toBeNull();
  });
});
