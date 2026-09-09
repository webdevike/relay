import { describe, expect, it } from "vitest";
import { relativeTime, truncate } from "./format";

describe("relativeTime", () => {
  const now = 1_000_000;

  it("reads 'now' for anything under a minute old", () => {
    expect(relativeTime(now, now)).toBe("now");
    expect(relativeTime(now - 59_000, now)).toBe("now");
  });

  it("reads whole minutes once a minute has elapsed", () => {
    expect(relativeTime(now - 60_000, now)).toBe("1m");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m");
  });

  it("reads whole hours once an hour has elapsed", () => {
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h");
    expect(relativeTime(now - 23 * 60 * 60_000, now)).toBe("23h");
  });

  it("reads whole days once a day has elapsed", () => {
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d");
    expect(relativeTime(now - 10 * 24 * 60 * 60_000, now)).toBe("10d");
  });

  it("clamps future timestamps to 'now' instead of going negative", () => {
    expect(relativeTime(now + 5_000, now)).toBe("now");
  });
});

describe("truncate", () => {
  it("returns the string unchanged when it fits", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("cuts and appends an ellipsis when it overflows", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("handles a max length of 1 or less without producing an ellipsis-only overflow", () => {
    expect(truncate("hello", 1)).toBe("h");
    expect(truncate("hello", 0)).toBe("");
  });
});
