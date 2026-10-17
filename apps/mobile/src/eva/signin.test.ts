import { describe, expect, it } from "vitest";
import { faviconUrl, signinFailure } from "./signin";

describe("faviconUrl", () => {
  it("asks Google's favicon service for a 64px icon of the host", () => {
    expect(faviconUrl("github.com")).toBe("https://www.google.com/s2/favicons?domain=github.com&sz=64");
    expect(faviconUrl("a b&c")).toBe("https://www.google.com/s2/favicons?domain=a%20b%26c&sz=64");
  });
});

describe("signinFailure", () => {
  it("shows the host's message, or a plain line when there is none", () => {
    expect(signinFailure(new Error("Incorrect password."))).toBe("Incorrect password.");
    expect(signinFailure(new Error(""))).toBe("Couldn't sign in.");
    expect(signinFailure("boom")).toBe("Couldn't sign in.");
  });
});
