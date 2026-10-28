import { describe, expect, it } from "vitest";
import type { AssistantPortrait } from "@relay/protocol";
import { portraitOf, portraitSvg } from "./portrait";

const NOVA: AssistantPortrait = {
  style: "micah",
  seed: "nova-17",
  options: { glasses: ["round"], glassesProbability: 100, hair: ["full"], hairColor: ["e0ddff"], baseColor: ["b16a5b"], earringsProbability: 0 },
  colors: { paper: "#e7f5ff", accent: "#f76707" },
};

describe("portraitOf", () => {
  it("is the designed portrait, else notionists from the registry avatar, else from the id", () => {
    expect(portraitOf({ id: "nova", avatar: "nova-17", portrait: NOVA })).toBe(NOVA);
    expect(portraitOf({ id: "nova", avatar: "nova-17" })).toEqual({ style: "notionists", seed: "nova-17" });
    expect(portraitOf({ id: "nova" })).toEqual({ style: "notionists", seed: "nova" });
    expect(portraitOf({ id: "nova", avatar: "  " })).toEqual({ style: "notionists", seed: "nova" });
  });

  it("keeps one object per seed, so store selectors stay stable", () => {
    expect(portraitOf({ id: "astra", avatar: "astra-2" })).toBe(portraitOf({ id: "other", avatar: "astra-2" }));
  });
});

describe("portraitSvg", () => {
  it("draws one stable portrait per seed and options, without metadata", () => {
    const astra = portraitSvg({ style: "notionists", seed: "astra-2" });
    expect(astra.startsWith("<svg")).toBe(true);
    expect(astra).not.toContain("<metadata");
    expect(portraitSvg({ style: "notionists", seed: "astra-2" })).toBe(astra);
    expect(portraitSvg({ style: "notionists", seed: "nova-17" })).not.toBe(astra);
  });

  it("draws micah with the designed parts: hair, skin and glasses as given", () => {
    const nova = portraitSvg(NOVA);
    expect(nova).not.toContain("<metadata");
    expect(nova).toContain("#e0ddff");
    expect(nova).toContain("#b16a5b");
    expect(nova).not.toBe(portraitSvg({ ...NOVA, options: { ...NOVA.options, glassesProbability: 0 } }));
    expect(nova).not.toBe(portraitSvg({ style: "notionists", seed: "nova-17" }));
  });
});
