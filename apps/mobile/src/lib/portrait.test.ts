import { describe, expect, it } from "vitest";
import { portraitSeed, portraitSvg } from "./portrait";

describe("portraitSeed", () => {
  it("is the registry avatar, else the id", () => {
    expect(portraitSeed({ id: "nova", avatar: "nova-17" })).toBe("nova-17");
    expect(portraitSeed({ id: "nova" })).toBe("nova");
    expect(portraitSeed({ id: "nova", avatar: "  " })).toBe("nova");
  });
});

describe("portraitSvg", () => {
  it("draws one stable notionists portrait per seed, without metadata", () => {
    const nova = portraitSvg("nova-17");
    expect(nova.startsWith("<svg")).toBe(true);
    expect(nova).not.toContain("<metadata");
    expect(portraitSvg("nova-17")).toBe(nova);
    expect(portraitSvg("astra-2")).not.toBe(nova);
  });
});
