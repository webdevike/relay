import { describe, expect, it } from "vitest";
import { parseAppLink, parseWidget, type WidgetSpec } from "../src";

const parse = (spec: object): WidgetSpec | null => parseWidget(JSON.stringify(spec));

describe("relay:// app links", () => {
  it("parses assistant and open links and nothing else", () => {
    expect(parseAppLink("relay://assistant/nova")).toEqual({ kind: "assistant", id: "nova" });
    expect(parseAppLink("relay://open/test-bench")).toEqual({ kind: "open", page: "test-bench" });
    for (const bad of [
      "relay://assistant/",
      "relay://assistant/Nova",
      "relay://assistant/a/b",
      "relay://assistant/nova?x=1",
      "relay://reviews?item=x",
      "relay://other/nova",
      "javascript:alert(1)",
      "https://example.com",
    ])
      expect(parseAppLink(bad)).toBeNull();
  });

  it("takes a relay:// url on a card, link and button; a card drops a bad one", () => {
    const kids = [{ widget: "divider" }];
    expect(parse({ widget: "card", title: "Nova", url: "relay://assistant/nova", children: kids })).toMatchObject({
      url: "relay://assistant/nova",
    });
    expect(parse({ widget: "card", url: "https://example.com/x", children: kids })).toMatchObject({
      url: "https://example.com/x",
    });
    expect(parse({ widget: "card", url: "relay://nope/x", children: kids })).toEqual({ widget: "card", children: kids });
    expect(parse({ widget: "link", label: "Nova", url: "relay://assistant/nova" })).not.toBeNull();
    expect(parse({ widget: "link", label: "Bad", url: "relay://nope" })).toBeNull();
    expect(parse({ widget: "button", label: "Go", url: "relay://open/jobs" })).not.toBeNull();
    expect(parse({ widget: "link", label: "Bad", url: "javascript:alert(1)" })).toBeNull();
  });
});
