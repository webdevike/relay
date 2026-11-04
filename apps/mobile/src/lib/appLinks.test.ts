import { describe, expect, it } from "vitest";
import { appLinkRoute, hrefPath, systemPath } from "./appLinks";

describe("appLinkRoute", () => {
  it("is null for anything that is not a relay:// app link", () => {
    expect(appLinkRoute("https://example.com")).toBeNull();
    expect(appLinkRoute("relay://agents/abc")).toBeNull();
    expect(appLinkRoute("relay://expo-development-client/?url=http%3A%2F%2Fx")).toBeNull();
  });

  it("opens the singular relay://open/setting as Settings, like desktop", () => {
    expect(appLinkRoute("relay://open/setting")).toEqual({ how: "navigate", href: "/settings" });
  });

  it("maps pages to screens and a Reviews item to a push", () => {
    expect(appLinkRoute("relay://assistant/nova")).toEqual({ how: "navigate", href: { pathname: "/eva", params: { agent: "nova" } } });
    expect(appLinkRoute("relay://open/settings/connections?connect=github")).toEqual({ how: "navigate", href: "/settings" });
    expect(appLinkRoute("relay://open/board/mind-map")).toEqual({ how: "navigate", href: { pathname: "/boards", params: { slug: "mind-map" } } });
    expect(appLinkRoute("relay://open/canvas?canvas=artifacts")).toEqual({ how: "navigate", href: { pathname: "/canvas", params: { slug: "artifacts" } } });
    const item = "https://github.com/o/r/pull/12";
    expect(appLinkRoute(`relay://open/reviews?item=${encodeURIComponent(item)}`)).toEqual({ how: "push", href: `/reviews?item=${encodeURIComponent(item)}` });
  });

  it("has no screen for Test Bench, Jobs or a canvas link without a valid room", () => {
    expect(appLinkRoute("relay://open/test-bench?experiment=x&arm=a")).toBe("none");
    expect(appLinkRoute("relay://open/jobs")).toBe("none");
    expect(appLinkRoute("relay://open/canvas")).toBe("none");
    expect(appLinkRoute("relay://open/canvas?canvas=Not%20A%20Slug")).toBe("none");
  });
});

describe("systemPath", () => {
  it("rewrites app links to the router's paths", () => {
    expect(systemPath("relay://assistant/astra")).toBe("/eva?agent=astra");
    expect(systemPath("relay://open/assistants")).toBe("/assistants");
    expect(systemPath("relay://open/settings")).toBe("/settings");
    expect(systemPath("relay://open/studio")).toBe("/studio");
    expect(systemPath("relay://open/board")).toBe("/boards");
    expect(systemPath("relay://open/board/mind-map")).toBe("/boards?slug=mind-map");
    expect(systemPath("relay://open/canvas?canvas=artifacts")).toBe("/canvas?slug=artifacts");
    const item = "https://github.com/o/r/pull/12";
    expect(systemPath(`relay://open/reviews?item=${encodeURIComponent(item)}`)).toBe(`/reviews?item=${encodeURIComponent(item)}`);
  });

  it("lands on Home for a page the phone lacks, and leaves other URLs alone", () => {
    expect(systemPath("relay://open/test-bench")).toBe("/");
    expect(systemPath("relay://reviews?item=x")).toBe("relay://reviews?item=x");
    expect(systemPath("relay://agents/abc")).toBe("relay://agents/abc");
    expect(systemPath("/settings")).toBe("/settings");
  });
});

describe("hrefPath", () => {
  it("encodes params", () => {
    expect(hrefPath({ pathname: "/boards", params: { slug: "a b" } })).toBe("/boards?slug=a%20b");
    expect(hrefPath("/studio")).toBe("/studio");
  });
});
