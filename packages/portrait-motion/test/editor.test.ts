import { describe, expect, it } from "vitest";
import {
  PART_DEFS,
  parseSaveMessage,
  partChoices,
  partThumbSvg,
  partValue,
  pinPortrait,
  portraitSvg,
  saveMessage,
  shuffle,
  shufflePart,
  withColor,
  withPalette,
  withPart,
  withStyle,
  type Portrait,
} from "../src";

const nova: Portrait = {
  style: "micah",
  seed: "nova-17",
  options: { hair: ["pixie"], glassesProbability: 0 },
  colors: { paper: "#e7f5ff", accent: "#1c7ed6" },
};

/** A deterministic random source. */
const seeded = (): (() => number) => {
  let s = 7;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
};

describe("pinPortrait", () => {
  it("writes every part the seed drew, keeps designed options, and is idempotent", () => {
    const pinned = pinPortrait(nova);
    expect(partValue(pinned, "hair")).toBe("pixie");
    expect(partValue(pinned, "glasses")).toBeNull();
    expect(partValue(pinned, "mouth")).not.toBeNull();
    expect(pinned.options?.["baseColor"]).toHaveLength(1);
    expect(pinPortrait(pinned)).toEqual(pinned);
  });

  it("draws the same face as the portrait it pins", () => {
    const strip = (svg: string): string => svg.replace(/<metadata[\s\S]*?<\/metadata>/, "");
    expect(strip(portraitSvg(pinPortrait(nova)))).toBe(strip(portraitSvg(nova)));
  });
});

describe("edits", () => {
  it("sets a part, switches an optional one off and on, without touching the input", () => {
    const base = pinPortrait(nova);
    const before = JSON.stringify(base);
    const glasses = partChoices("micah", "glasses").find((v) => v !== null) ?? null;
    const on = withPart(base, "glasses", glasses);
    expect(partValue(on, "glasses")).toBe(glasses);
    expect(on.options?.["glassesProbability"]).toBe(100);
    expect(partValue(withPart(on, "glasses", null), "glasses")).toBeNull();
    expect(JSON.stringify(base)).toBe(before);
  });

  it("offers none only for optional parts", () => {
    expect(partChoices("micah", "glasses")[0]).toBeNull();
    expect(partChoices("micah", "mouth")).not.toContain(null);
    expect(partChoices("notionists", "hair").length).toBeGreaterThan(30);
  });

  it("changes color options and the paper and accent, clearing colors when none are left", () => {
    expect(withColor(nova, "hairColor", "#fc909f").options?.["hairColor"]).toEqual(["fc909f"]);
    expect(withPalette(nova, "paper", "#ffe3e3").colors).toEqual({ paper: "#ffe3e3", accent: "#1c7ed6" });
    expect(withPalette(withPalette(nova, "paper", null), "accent", null).colors).toBeUndefined();
  });

  it("switches style to that style's own parts for the seed, keeping colors", () => {
    const n = withStyle(pinPortrait(nova), "notionists");
    expect(n.style).toBe("notionists");
    expect(n.colors).toEqual(nova.colors);
    expect(n.options?.["hair"]).toHaveLength(1);
    expect(n.options?.["glasses"]).toBeUndefined();
  });

  it("shuffles to a different, valid face", () => {
    const base = pinPortrait(nova);
    const next = shuffle(base, seeded());
    expect(next).not.toEqual(base);
    for (const def of PART_DEFS.micah) {
      const v = partValue(next, def.key);
      expect(partChoices("micah", def.key)).toContain(v);
    }
    const one = shufflePart(base, "hair", seeded());
    expect(partValue(one, "hair")).not.toBe("pixie");
    expect(partValue(one, "mouth")).toBe(partValue(base, "mouth"));
  });

  it("draws a thumbnail cropped to the part", () => {
    const def = PART_DEFS.micah[0]!;
    expect(partThumbSvg(pinPortrait(nova), def, "pixie")).toContain(`viewBox="${def.view}"`);
  });
});

describe("the Save message", () => {
  it("round-trips the agent and the portrait on one line", () => {
    const p = pinPortrait(nova);
    const text = saveMessage("nova", p);
    expect(text.startsWith("Save my avatar: {")).toBe(true);
    expect(text).not.toContain("\n");
    expect(parseSaveMessage(text)).toEqual({ agent: "nova", avatar: p });
  });

  it("leaves out colors the portrait does not have", () => {
    const { colors: _, ...bare } = nova;
    expect(JSON.parse(saveMessage("nova", bare).slice("Save my avatar: ".length)).avatar).not.toHaveProperty("colors");
  });

  it("rejects anything else", () => {
    expect(parseSaveMessage("hello")).toBeNull();
    expect(parseSaveMessage("Save my avatar: {nope")).toBeNull();
    expect(parseSaveMessage('Save my avatar: {"agent":"nova","avatar":{"style":"x","seed":"a"}}')).toBeNull();
  });
});
