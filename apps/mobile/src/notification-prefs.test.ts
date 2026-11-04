import { describe, expect, it } from "vitest";
import { notificationTarget } from "./notification-target";
import { withMuted } from "./notification-prefs";

describe("withMuted", () => {
  it("adds an assistant once and removes it, keeping the others in order", () => {
    expect(withMuted([], "nova", true)).toEqual(["nova"]);
    expect(withMuted(["nova"], "nova", true)).toEqual(["nova"]);
    expect(withMuted(["astra", "nova"], "astra", false)).toEqual(["nova"]);
    expect(withMuted(["nova"], "astra", false)).toEqual(["nova"]);
    expect(withMuted(["nova"], "astra", true)).toEqual(["nova", "astra"]);
  });
});

describe("notificationTarget for a canvas invitation", () => {
  it("opens the board's live room by its slug", () => {
    expect(notificationTarget({ canvas: "mind-map" })).toEqual({ pathname: "/canvas", params: { slug: "mind-map" } });
  });

  it("ignores a slug that is no slug", () => {
    expect(notificationTarget({ canvas: "../x" })).toBeNull();
    expect(notificationTarget({ canvas: 3 })).toBeNull();
    expect(notificationTarget({ canvas: "" })).toBeNull();
  });
});
