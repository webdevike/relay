import { describe, expect, it } from "vitest";
import { buildAppLink, parseAppLink, parseAssistantAvatar, parseWidget, type WidgetSpec } from "../src";

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

  it("reads page parts and params, and builds the same link back", () => {
    for (const url of [
      "relay://open/settings/connections?connect=github",
      "relay://open/settings/theme?setting=theme.mode",
      `relay://open/reviews?item=${encodeURIComponent("https://github.com/o/r/pull/12")}`,
      "relay://open/workspace/relay-agent-access",
      "relay://assistant/nova",
    ]) {
      const link = parseAppLink(url);
      expect(link, url).not.toBeNull();
      expect(buildAppLink(link!)).toBe(url);
    }
    expect(parseAppLink("relay://open/settings/connections")).toEqual({ kind: "open", page: "settings", sub: "connections" });
    for (const bad of ["relay://open/settings/a/b", "relay://open/settings?nope=1", "relay://open/settings?item="])
      expect(parseAppLink(bad), bad).toBeNull();
  });

  it("takes a relay:// url on a card, link and button; a card drops a bad one", () => {
    const kids = [{ widget: "divider" }];
    expect(
      parse({ widget: "card", title: "Nova", url: "relay://assistant/nova", children: kids }),
    ).toMatchObject({
      url: "relay://assistant/nova",
    });
    expect(parse({ widget: "card", url: "https://example.com/x", children: kids })).toMatchObject({
      url: "https://example.com/x",
    });
    expect(parse({ widget: "card", url: "relay://nope/x", children: kids })).toEqual({
      widget: "card",
      children: kids,
    });
    expect(parse({ widget: "link", label: "Nova", url: "relay://assistant/nova" })).not.toBeNull();
    expect(parse({ widget: "link", label: "Bad", url: "relay://nope" })).toBeNull();
    expect(parse({ widget: "button", label: "Go", url: "relay://open/jobs" })).not.toBeNull();
    expect(parse({ widget: "link", label: "Bad", url: "javascript:alert(1)" })).toBeNull();
  });
});

describe("relay://assistant/<id>/avatar sources", () => {
  it("parses only the avatar form", () => {
    expect(parseAssistantAvatar("relay://assistant/nova/avatar")).toBe("nova");
    for (const bad of [
      "relay://assistant/nova",
      "relay://assistant/Nova/avatar",
      "relay://assistant/nova/avatar/x",
      "relay://open/nova/avatar",
      "https://example.com/avatar",
    ])
      expect(parseAssistantAvatar(bad)).toBeNull();
  });

  it("keeps it as an avatar src next to drops and https, and drops anything else", () => {
    const avatar = (src: string) => parse({ widget: "avatar", name: "Nova", src });
    expect(avatar("relay://assistant/nova/avatar")).toMatchObject({
      src: "relay://assistant/nova/avatar",
    });
    expect(avatar("/drops/a/b")).toMatchObject({ src: "/drops/a/b" });
    expect(avatar("https://x.com/a.png")).toMatchObject({ src: "https://x.com/a.png" });
    expect(avatar("relay://assistant/nova")).toEqual({ widget: "avatar", name: "Nova" });
  });
});
