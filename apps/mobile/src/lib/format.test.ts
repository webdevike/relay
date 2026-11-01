import { describe, expect, it } from "vitest";
import { byteSize, clockTime, elapsed, highlightParts, longDate, nameTint, relativeTime, tokenCount, truncate } from "./format";

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

describe("byteSize", () => {
  it("keeps bytes whole and steps up at each 1024 boundary", () => {
    expect(byteSize(0)).toBe("0 B");
    expect(byteSize(1023)).toBe("1023 B");
    expect(byteSize(1024)).toBe("1.0 KB");
    expect(byteSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("shows one decimal under 10 of a unit and whole numbers above", () => {
    expect(byteSize(3.45 * 1024)).toBe("3.5 KB");
    expect(byteSize(12.6 * 1024 * 1024)).toBe("13 MB");
  });
});

describe("elapsed", () => {
  it("reads seconds, then minutes and seconds, then hours and minutes", () => {
    expect(elapsed(-5)).toBe("0s");
    expect(elapsed(45_900)).toBe("45s");
    expect(elapsed(130_000)).toBe("2m 10s");
    expect(elapsed(3_900_000)).toBe("1h 5m");
  });
});

describe("tokenCount", () => {
  it("reads tokens, then whole thousands, then millions to one decimal", () => {
    expect(tokenCount(1)).toBe("1 token");
    expect(tokenCount(850)).toBe("850 tokens");
    expect(tokenCount(41_999)).toBe("41k tokens");
    expect(tokenCount(1_240_000)).toBe("1.2M tokens");
  });
});

describe("activity dates and highlights", () => {
  it("writes a full local date with a 12-hour time", () => {
    expect(longDate(new Date(2026, 9, 30, 17, 53).getTime())).toBe("October 30, 2026 at 5:53 PM");
    expect(clockTime(new Date(2026, 0, 1, 0, 5).getTime())).toBe("12:05 AM");
  });

  it("cuts the highlighted words out as bright runs", () => {
    expect(highlightParts("changed status from In QA to Done", ["In QA", "Done"])).toEqual([
      { text: "changed status from ", bright: false },
      { text: "In QA", bright: true },
      { text: " to ", bright: false },
      { text: "Done", bright: true },
    ]);
    expect(highlightParts("no change", [])).toEqual([{ text: "no change", bright: false }]);
  });

  it("gives a name one stable tint", () => {
    expect(nameTint("Steve Arms")).toBe(nameTint(" steve arms "));
    expect(nameTint("Steve Arms")).toMatch(/^#[0-9A-F]{6}$/);
  });
});
