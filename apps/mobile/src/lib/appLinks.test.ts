import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAppLink } from "@relay/protocol";
import { appLinkRoute, hrefPath, ROUTER_SCREENS, systemPath } from "./appLinks";
import { LINK_KINDS } from "./linkKinds.fixture";

const APP_DIR = path.resolve(import.meta.dirname, "../../app");

/** Whether `pathname` (`/rooms/r1`) names a file in app/, dynamic `[param]` segments included. */
function screenExists(pathname: string): boolean {
  let dir = APP_DIR;
  const parts = pathname.split("/").filter((part) => part !== "");
  for (const [i, part] of parts.entries()) {
    const entries = readdirSync(dir);
    const match =
      entries.find((e) => e === part || e === `${part}.tsx`) ??
      entries.find((e) => /^\[[^\]]+\](\.tsx)?$/.test(e));
    if (match === undefined) return false;
    if (i === parts.length - 1)
      return match.endsWith(".tsx") || existsSync(path.join(dir, match, "index.tsx"));
    dir = path.join(dir, match.replace(/\.tsx$/, ""));
  }
  return existsSync(path.join(APP_DIR, "index.tsx"));
}

const pathOf = (url: string): string => systemPath(url).path.split("?")[0] ?? "";
const ITEM = "https://github.com/o/r/pull/12";

describe("every desktop link kind on the phone", () => {
  it("has the kinds a link can name", () => {
    expect(LINK_KINDS.length).toBeGreaterThan(40);
  });

  it.each(LINK_KINDS.map((k) => [k.what, k] as const))("%s", (_what, kind) => {
    expect(appLinkRoute(kind.url), kind.url).not.toBeNull();
    expect(systemPath(kind.url), kind.url).toEqual({
      path: kind.phone,
      ...(kind.notice === undefined ? {} : { notice: kind.notice }),
    });
  });

  it("opens only screens that exist in app/", () => {
    for (const { url } of LINK_KINDS) expect(screenExists(pathOf(url)), url).toBe(true);
  });

  it("opens the older rooms/<id> like desktop's room/<id>", () => {
    expect(systemPath("relay://open/rooms/r1")).toEqual({ path: "/rooms/r1" });
  });
});

describe("appLinkRoute", () => {
  it("is null for anything that is not a relay:// link the app handles", () => {
    expect(appLinkRoute("https://example.com")).toBeNull();
    expect(appLinkRoute("/settings")).toBeNull();
    expect(appLinkRoute("relay://expo-development-client/?url=http%3A%2F%2Fx")).toBeNull();
  });

  it("leaves the older relay://<screen> paths to the router", () => {
    expect(appLinkRoute("relay://agents/abc")).toBeNull();
    expect(appLinkRoute("relay://reviews?item=x")).toBeNull();
    expect(appLinkRoute("relay://rooms/dev?to=%2Frooms")).toBeNull();
    expect(systemPath("relay://agents/abc")).toEqual({ path: "relay://agents/abc" });
  });

  it("names exactly the screens in app/ for those paths", () => {
    const files = readdirSync(APP_DIR)
      .filter((e) => !e.startsWith("+") && !e.startsWith("_"))
      .map((e) => e.replace(/\.tsx$/, ""))
      .filter((f) => f !== "index")
      .sort();
    expect([...ROUTER_SCREENS].sort()).toEqual(files);
  });

  it("opens the singular relay://open/setting as Settings, like desktop", () => {
    expect(appLinkRoute("relay://open/setting")).toEqual({ how: "navigate", href: "/settings" });
  });

  it("pushes a Reviews item over the queue and switches to everything else", () => {
    expect(appLinkRoute(`relay://open/reviews?item=${encodeURIComponent(ITEM)}`)?.how).toBe("push");
    expect(appLinkRoute("relay://assistant/nova")).toEqual({
      how: "navigate",
      href: { pathname: "/eva", params: { agent: "nova" } },
    });
  });

  it("opens Home with a notice, never a dead route, for links the grammar rejects or pages it does not know", () => {
    for (const url of [
      "relay://open/jobs/x/y",
      "relay://open/workspace/ECard",
      "relay://open/settings?nope=1",
      "relay://assistant/Nova",
      "relay://assistant/nova/avatar",
      "relay://nonsense",
      "relay://",
    ]) {
      expect(systemPath(url), url).toEqual({
        path: "/",
        notice: "That link isn't one Relay can open",
      });
    }
    expect(systemPath("relay://open/brand-new-page")).toEqual({
      path: "/",
      notice: "The phone has no screen for that link",
    });
  });

  it("gives a chat link with no readable session id the sessions list", () => {
    expect(
      systemPath(buildAppLink({ kind: "open", page: "chat", params: { chat: "/x/.jsonl" } })),
    ).toEqual({
      path: "/agents",
      notice: "Chats open as sessions under Agents",
    });
  });

  it("sends an assistant link's ?send= only when Isaac's tap opened it, and never puts the text in the route", () => {
    const href = { pathname: "/eva", params: { agent: "penny" } };
    const compose = (send: boolean) => ({ agent: "penny", text: "Add the lamp", send });
    expect(
      appLinkRoute("relay://assistant/penny?send=Add%20the%20lamp", { gesture: true }),
    ).toEqual({ how: "navigate", href, compose: compose(true) });
    // Anything else that opens it (a widget page on its own, the default) gets a draft.
    expect(
      appLinkRoute("relay://assistant/penny?send=Add%20the%20lamp", { gesture: false })?.compose,
    ).toEqual(compose(false));
    expect(appLinkRoute("relay://assistant/penny?send=Add%20the%20lamp")?.compose).toEqual(
      compose(false),
    );
    // A ?draft= never sends, even from a tap.
    expect(
      appLinkRoute("relay://assistant/penny?draft=Add%20the%20lamp", { gesture: true })?.compose,
    ).toEqual(compose(false));
  });

  it("turns a system URL's ?send= into a draft on the plain thread route", () => {
    expect(systemPath("relay://assistant/penny?send=Add%20the%20lamp")).toEqual({
      path: "/eva?agent=penny",
      compose: { agent: "penny", text: "Add the lamp", send: false },
    });
    expect(systemPath("relay://assistant/penny?draft=hi")).toEqual({
      path: "/eva?agent=penny",
      compose: { agent: "penny", text: "hi", send: false },
    });
  });
});

describe("hrefPath", () => {
  it("encodes params", () => {
    expect(hrefPath({ pathname: "/boards", params: { slug: "a b" } })).toBe("/boards?slug=a%20b");
    expect(hrefPath("/studio")).toBe("/studio");
  });
});
