// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeScript, parseFrameMessage, type FrameTheme } from "../src/frame";

const THEME: FrameTheme = {
  dark: false,
  colors: {
    fg: "#000",
    muted: "#666",
    faint: "#999",
    border: "#ddd",
    surface: "#f8f8f8",
    raised: "#fff",
    accent: "#27f",
    ok: "#0a0",
    warn: "#fa0",
    danger: "#f00",
    bg: "transparent",
  },
  font: { family: "sans-serif", mono: "monospace", size: 14, lineHeight: 20 },
  radius: { sm: 4, md: 8, lg: 12 },
};

/** Messages the page posts to the phone web view. */
const posts: { type: string; url?: string; gesture?: boolean; text?: string; agent?: string }[] =
  [];

beforeAll(() => {
  Object.assign(window, {
    ResizeObserver: class {
      observe(): void {
        // the page only needs the call to succeed
      }
    },
    ReactNativeWebView: {
      postMessage: (data: string) => posts.push(JSON.parse(data) as (typeof posts)[number]),
    },
  });
  window.eval(bridgeScript(THEME, false));
});

beforeEach(() => {
  posts.length = 0;
});

const opened = () => posts.filter((p) => p.type === "open");
const replies = () => posts.filter((p) => p.type === "reply");

function click(html: string, id: string): MouseEvent {
  document.body.innerHTML = html;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)?.dispatchEvent(event);
  return event;
}

describe("link clicks in a widget page", () => {
  it("never navigate the frame and are sent out to the host", () => {
    const event = click(
      '<a href="https://example.com/deal?x=1"><b id="in">View deal</b></a>',
      "in",
    );
    expect(event.defaultPrevented).toBe(true);
    // A click a script dispatched is no user gesture.
    expect(opened()).toEqual([
      { type: "open", url: "https://example.com/deal?x=1", gesture: false },
    ]);
  });

  it("send relay:// links and drop every other scheme, without navigating", () => {
    const hrefs = ["relay://open/boards", "javascript:alert(1)", "mailto:a@b.co", "#top"];
    for (const href of hrefs) {
      expect(click(`<a id="l" href="${href}">l</a>`, "l").defaultPrevented).toBe(true);
    }
    expect(opened()).toEqual([{ type: "open", url: "relay://open/boards", gesture: false }]);
  });

  it("go through relay.open and window.open, http(s) and relay:// only", () => {
    expect(relay.open("https://example.com/a")).toBe(true);
    expect(relay.open("file:///etc/passwd")).toBe(false);
    expect(window.open("http://example.com/b")).toBeNull();
    expect(window.open("data:text/html,x")).toBeNull();
    expect(opened()).toEqual([
      { type: "open", url: "https://example.com/a", gesture: true },
      { type: "open", url: "http://example.com/b", gesture: true },
    ]);
  });
});

describe("relay.reply", () => {
  it("sends to this chat, or to the assistant named by agent", () => {
    expect(relay.reply("add it")).toBe(true);
    expect(relay.reply("add it", { agent: "penny" })).toBe(true);
    expect(replies()).toEqual([
      { type: "reply", text: "add it" },
      { type: "reply", text: "add it", agent: "penny" },
    ]);
  });

  it("refuses a malformed agent instead of sending to this chat", () => {
    expect(relay.reply("add it", { agent: "Penny!" })).toBe(false);
    expect(relay.reply("add it", { agent: 7 })).toBe(false);
    expect(replies()).toEqual([]);
  });
});

describe("parseFrameMessage open", () => {
  it("accepts http(s) and relay:// urls only", () => {
    expect(parseFrameMessage('{"type":"open","url":"https://x.test/a"}')).toEqual({
      type: "open",
      url: "https://x.test/a",
      gesture: false,
    });
    expect(
      parseFrameMessage('{"type":"open","url":"relay://assistant/penny?send=hi","gesture":true}'),
    ).toEqual({
      type: "open",
      url: "relay://assistant/penny?send=hi",
      gesture: true,
    });
    expect(parseFrameMessage('{"type":"open","url":"relay://open/boards"}')).not.toBeNull();
    expect(parseFrameMessage('{"type":"open","url":"javascript:alert(1)"}')).toBeNull();
    expect(parseFrameMessage('{"type":"open","url":"file:///etc/passwd"}')).toBeNull();
    expect(parseFrameMessage('{"type":"open"}')).toBeNull();
  });
});

describe("parseFrameMessage reply", () => {
  it("keeps a valid agent and drops a reply with a malformed one", () => {
    expect(parseFrameMessage('{"type":"reply","text":"hi","agent":"penny"}')).toEqual({
      type: "reply",
      text: "hi",
      agent: "penny",
    });
    expect(parseFrameMessage('{"type":"reply","text":"hi"}')).toEqual({
      type: "reply",
      text: "hi",
    });
    expect(parseFrameMessage('{"type":"reply","text":"hi","agent":"../x"}')).toBeNull();
  });
});

declare const relay: {
  open(url: string): boolean;
  reply(text: string, options?: { agent?: unknown }): boolean;
};
