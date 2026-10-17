import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ALLOW_PINCH_ZOOM_JS, FOCUS_KEYBOARD_JS, KEYBOARD_FOCUSED, KEYBOARD_NONE } from "./computer";

interface FakeEl {
  id?: string;
  tag: string;
  focusable: boolean;
  attrs: Record<string, string>;
  focus?: () => void;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
}

function element(tag: string, init: { id?: string; focusable?: boolean; content?: string } = {}): FakeEl {
  const attrs: Record<string, string> = init.content === undefined ? {} : { content: init.content };
  return {
    tag,
    ...(init.id === undefined ? {} : { id: init.id }),
    focusable: init.focusable ?? true,
    attrs,
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => {
      attrs[name] = value;
    },
  };
}

function run(script: string, document: unknown, window: unknown = {}): void {
  runInNewContext(script, { document, window });
}

describe("FOCUS_KEYBOARD_JS", () => {
  const page = (elements: FakeEl[]) => {
    const doc = {
      activeElement: null as FakeEl | null,
      querySelectorAll: (selector: string): FakeEl[] =>
        elements.filter((el) => {
          if (selector === "input" || selector === "textarea") return el.tag === selector;
          const needle = /\[id\*="(\w+)" i\]/.exec(selector)?.[1];
          return needle !== undefined && (el.id ?? "").toLowerCase().includes(needle);
        }),
    };
    for (const el of elements) {
      el.focus = () => {
        if (el.focusable) doc.activeElement = el;
      };
    }
    const posted: string[] = [];
    return { doc, win: { ReactNativeWebView: { postMessage: (m: string) => posted.push(m) } }, posted };
  };

  it("prefers a keyboard-id field over an earlier plain input", () => {
    const plain = element("input");
    const hidden = element("input", { id: "keyboard-input-assist" });
    const { doc, win, posted } = page([plain, hidden]);
    run(FOCUS_KEYBOARD_JS, doc, win);
    expect(doc.activeElement).toBe(hidden);
    expect(posted).toEqual([KEYBOARD_FOCUSED]);
  });

  it("skips an id match that cannot take focus and falls back to an input", () => {
    const wrapper = element("div", { id: "input-container", focusable: false });
    const field = element("textarea");
    const { doc, win, posted } = page([wrapper, field]);
    run(FOCUS_KEYBOARD_JS, doc, win);
    expect(doc.activeElement).toBe(field);
    expect(posted).toEqual([KEYBOARD_FOCUSED]);
  });

  it("reports none when the page has no field", () => {
    const { doc, win, posted } = page([element("div")]);
    run(FOCUS_KEYBOARD_JS, doc, win);
    expect(posted).toEqual([KEYBOARD_NONE]);
  });
});

describe("ALLOW_PINCH_ZOOM_JS", () => {
  const page = (meta: FakeEl | null) => {
    const head = { appendChild: (el: FakeEl) => (meta = el) };
    const doc = {
      head,
      documentElement: head,
      querySelector: () => meta,
      createElement: (tag: string) => element(tag),
    };
    return { doc, meta: () => meta };
  };

  it("replaces user-scalable=no and keeps the other terms", () => {
    const { doc, meta } = page(element("meta", { content: "width=device-width, initial-scale=1, user-scalable=no, maximum-scale=1" }));
    run(ALLOW_PINCH_ZOOM_JS, doc);
    expect(meta()?.attrs["content"]).toBe("width=device-width, initial-scale=1, user-scalable=yes, maximum-scale=5");
  });

  it("adds the meta when the page has none", () => {
    const { doc, meta } = page(null);
    run(ALLOW_PINCH_ZOOM_JS, doc);
    expect(meta()?.attrs["content"]).toBe("width=device-width, user-scalable=yes, maximum-scale=5");
    expect(meta()?.attrs["name"]).toBe("viewport");
  });
});
