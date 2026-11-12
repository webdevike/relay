import { describe, expect, it } from "vitest";
import { DISMISS_FRACTION, DISMISS_VELOCITY, FLICK_MIN_DISTANCE, RUBBER_BAND, dragOffset, shouldDismissSwipe } from "./swipeDismiss";

const WIDTH = 360;
const FAR = -(WIDTH * DISMISS_FRACTION);

describe("shouldDismissSwipe", () => {
  it("dismisses a slow drag left once it passes the share of the width, not before", () => {
    expect(shouldDismissSwipe(FAR, 0, WIDTH)).toBe(true);
    expect(shouldDismissSwipe(FAR + 1, 0, WIDTH)).toBe(false);
    expect(shouldDismissSwipe(-WIDTH, 0, WIDTH)).toBe(true);
  });

  it("dismisses a fast flick that moved a little, but never a twitch or a slow short drag", () => {
    expect(shouldDismissSwipe(-FLICK_MIN_DISTANCE, -DISMISS_VELOCITY, WIDTH)).toBe(true);
    expect(shouldDismissSwipe(-FLICK_MIN_DISTANCE + 1, -DISMISS_VELOCITY * 3, WIDTH)).toBe(false);
    expect(shouldDismissSwipe(-60, -(DISMISS_VELOCITY - 1), WIDTH)).toBe(false);
  });

  it("never dismisses a rightward swipe, however far or fast", () => {
    expect(shouldDismissSwipe(WIDTH, 5000, WIDTH)).toBe(false);
    expect(shouldDismissSwipe(0, -5000, WIDTH)).toBe(false);
    // A drag that went left and came back right past its start has a positive translation.
    expect(shouldDismissSwipe(20, -5000, WIDTH)).toBe(false);
  });

  it("needs a measured card", () => {
    expect(shouldDismissSwipe(-500, -5000, 0)).toBe(false);
  });
});

describe("dragOffset", () => {
  it("follows the finger left and only rubber-bands to the right", () => {
    expect(dragOffset(-120)).toBe(-120);
    expect(dragOffset(100)).toBe(100 * RUBBER_BAND);
    expect(dragOffset(0)).toBe(0);
  });
});
