import { describe, expect, it } from "vitest";
import { markdownQuote, overlayPlacement, quoteIntoDraft, type OverlayPlacementInput } from "./bubbleMenu";

const base: OverlayPlacementInput = {
  bubble: { x: 16, y: 400, width: 200, height: 80 },
  screen: { width: 390, height: 844 },
  insets: { top: 47, bottom: 34 },
  side: "left",
  bar: { width: 330, height: 50 },
  menu: { width: 220, height: 180 },
  lift: 1,
  gap: 8,
  margin: 12,
};

describe("overlayPlacement", () => {
  it("leaves a bubble with room around it where it is, bar above and menu below", () => {
    const p = overlayPlacement(base);
    expect(p.bubble).toEqual(base.bubble);
    expect(p.bar.y).toBe(400 - 8 - 50);
    expect(p.menu.y).toBe(480 + 8);
    expect(p.bar.x).toBe(16);
    expect(p.menu.x).toBe(16);
    expect(p.contentOffset).toBe(0);
  });

  it("aligns Isaac's bubble's bar and menu to its right edge, kept off the screen edge", () => {
    const inside = overlayPlacement({ ...base, side: "right", bubble: { x: 200, y: 400, width: 174, height: 80 } });
    expect(inside.menu.x).toBe(374 - 220);
    expect(inside.bar.x).toBe(374 - 330);
    // A bubble running into the margin: both stop at it.
    const edge = overlayPlacement({ ...base, side: "right", bubble: { x: 200, y: 400, width: 186, height: 80 } });
    expect(edge.menu.x).toBe(390 - 12 - 220);
    expect(edge.bar.x).toBe(390 - 12 - 330);
  });

  it("slides a bubble near the top down so the bar fits under the status bar", () => {
    const p = overlayPlacement({ ...base, bubble: { ...base.bubble, y: 60 } });
    expect(p.bar.y).toBe(47 + 12);
    expect(p.bubble.y).toBe(47 + 12 + 50 + 8);
  });

  it("slides a bubble near the bottom up so the menu fits above the home indicator", () => {
    const p = overlayPlacement({ ...base, bubble: { ...base.bubble, y: 700 } });
    expect(p.menu.y + 180).toBe(844 - 34 - 12);
    expect(p.bubble.y + 80 + 8).toBe(p.menu.y);
  });

  it("keeps the grown bubble clear of bar and menu when it lifts", () => {
    const p = overlayPlacement({ ...base, lift: 1.1 });
    expect(p.scale).toBe(1.1);
    expect(p.bar.y + 50 + 8).toBeCloseTo(400 - 4);
    expect(p.menu.y - 8).toBeCloseTo(480 + 4);
  });

  it("clips a bubble taller than the room, unscaled, keeping the part that was on screen", () => {
    const room = 844 - 34 - 12 - (47 + 12) - 50 - 180 - 16;
    const p = overlayPlacement({ ...base, lift: 1.05, bubble: { ...base.bubble, y: -300, height: 1400 } });
    expect(p.scale).toBe(1);
    expect(p.bubble.height).toBe(room);
    expect(p.bubble.y).toBe(47 + 12 + 50 + 8);
    expect(p.contentOffset).toBe(p.bubble.y + 300);
    expect(p.menu.y).toBe(p.bubble.y + room + 8);
  });

  it("never shows past the end of a tall bubble", () => {
    const p = overlayPlacement({ ...base, bubble: { ...base.bubble, y: -2000, height: 2100 } });
    expect(p.contentOffset).toBe(2100 - p.bubble.height);
  });
});

describe("markdownQuote", () => {
  it("quotes every line, blank ones as a bare marker, without surface tags", () => {
    expect(markdownQuote("<surface>iPhone - Relay</surface>\nfirst\n\nsecond\n")).toBe("> first\n>\n> second");
  });
});

describe("quoteIntoDraft", () => {
  it("fills an empty composer with the quote and a blank line, cursor after it", () => {
    expect(quoteIntoDraft("", 0, "ship it")).toEqual({ draft: "> ship it\n\n", cursor: 11 });
  });

  it("puts the quote above the cursor's line and keeps the cursor in its words", () => {
    const draft = "intro\nwhat about this";
    const cursor = draft.indexOf("about");
    const result = quoteIntoDraft(draft, cursor, "a\nb");
    expect(result.draft).toBe("intro\n> a\n> b\n\nwhat about this");
    expect(result.draft.slice(result.cursor)).toBe("about this");
  });

  it("quotes above the last line when the cursor is at the end", () => {
    const result = quoteIntoDraft("thanks", 6, "done");
    expect(result.draft).toBe("> done\n\nthanks");
    expect(result.cursor).toBe(result.draft.length);
  });

  it("clamps a stale cursor", () => {
    expect(quoteIntoDraft("hi", 99, "x")).toEqual({ draft: "> x\n\nhi", cursor: 7 });
  });
});
