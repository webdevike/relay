import { describe, expect, it } from "vitest";
import { dragOffset, FLING_VELOCITY, settlePage, SWIPE_SLOP, swipeOwner } from "./nestedPaging";

const W = 160;

describe("swipeOwner", () => {
  it("waits until the finger has travelled the slop", () => {
    expect(swipeOwner(1, 3, 0, 0)).toBe("undecided");
    expect(swipeOwner(1, 3, -(SWIPE_SLOP - 1), SWIPE_SLOP - 1)).toBe("undecided");
  });

  it("leaves mostly vertical swipes to Home's scroll, on any page", () => {
    expect(swipeOwner(0, 3, 4, -12)).toBe("vertical");
    expect(swipeOwner(1, 3, -6, 20)).toBe("vertical");
    expect(swipeOwner(2, 3, 0, 15)).toBe("vertical");
    // A dead-diagonal swipe is not a page turn.
    expect(swipeOwner(1, 3, -12, 12)).toBe("vertical");
  });

  it("pages the stack while the page it heads for exists", () => {
    // A finger moving left brings the next page in, moving right the previous one.
    expect(swipeOwner(0, 3, -12, 2)).toBe("inner");
    expect(swipeOwner(1, 3, -12, 0)).toBe("inner");
    expect(swipeOwner(1, 3, 12, 0)).toBe("inner");
    expect(swipeOwner(2, 3, 12, -3)).toBe("inner");
  });

  it("hands a swipe past the first or last page to the Home pager", () => {
    expect(swipeOwner(2, 3, -12, 0)).toBe("outer");
    expect(swipeOwner(0, 3, 12, 0)).toBe("outer");
    // A stack of one never takes a sideways swipe.
    expect(swipeOwner(0, 1, -12, 0)).toBe("outer");
    expect(swipeOwner(0, 1, 12, 0)).toBe("outer");
  });

  it("walks a stack to its end, then gives the next swipe to Home", () => {
    let page = 0;
    const owners: string[] = [];
    for (let swipe = 0; swipe < 4; swipe++) {
      const owner = swipeOwner(page, 3, -40, 0);
      owners.push(owner);
      if (owner === "inner") page = settlePage(page, 3, -W * 0.6, 0, W);
    }
    expect(owners).toEqual(["inner", "inner", "outer", "outer"]);
    expect(page).toBe(2);
  });
});

describe("dragOffset", () => {
  it("follows the finger from the page's resting place", () => {
    expect(dragOffset(1, 3, 0, W)).toBe(-W);
    expect(dragOffset(1, 3, -30, W)).toBe(-W - 30);
    expect(dragOffset(1, 3, 30, W)).toBe(-W + 30);
  });

  it("stops at the neighbouring page", () => {
    expect(dragOffset(1, 4, -W * 3, W)).toBe(-2 * W);
    expect(dragOffset(2, 4, W * 3, W)).toBe(-W);
  });

  it("never pulls past the first or last page", () => {
    expect(dragOffset(0, 3, 50, W)).toBe(0);
    expect(dragOffset(2, 3, -50, W)).toBe(-2 * W);
    expect(dragOffset(0, 1, -50, W)).toBe(0);
  });
});

describe("settlePage", () => {
  it("springs back from a short slow drag", () => {
    expect(settlePage(1, 3, -W * 0.3, 0, W)).toBe(1);
    expect(settlePage(1, 3, W * 0.3, 0, W)).toBe(1);
  });

  it("turns once the drag is past half way", () => {
    expect(settlePage(1, 3, -W * 0.6, 0, W)).toBe(2);
    expect(settlePage(1, 3, W * 0.6, 0, W)).toBe(0);
  });

  it("turns on a fling however short the drag", () => {
    expect(settlePage(0, 3, -20, -FLING_VELOCITY, W)).toBe(1);
    expect(settlePage(2, 3, 20, FLING_VELOCITY * 2, W)).toBe(1);
  });

  it("a fling back against the drag returns to the page it started on", () => {
    expect(settlePage(1, 3, -W * 0.4, FLING_VELOCITY * 2, W)).toBe(1);
  });

  it("moves at most one page and never past either end", () => {
    expect(settlePage(1, 5, -W * 4, -5000, W)).toBe(2);
    expect(settlePage(2, 3, -W, -5000, W)).toBe(2);
    expect(settlePage(0, 3, W, 5000, W)).toBe(0);
  });

  it("keeps a stack of one, or one not yet measured, where it is", () => {
    expect(settlePage(0, 1, -W, -5000, W)).toBe(0);
    expect(settlePage(1, 3, -W, -5000, 0)).toBe(1);
  });
});
