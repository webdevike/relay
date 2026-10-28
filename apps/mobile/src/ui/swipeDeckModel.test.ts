import { describe, expect, it } from "vitest";
import {
  REST,
  STEP_DROP,
  STEP_SCALE,
  cardPose,
  deckSlots,
  thrownMotion,
  weightsFor,
  type CardPose,
  type CardWeights,
  type DeckGeometry,
  type DeckMotionState,
  type SwipeCardRole,
  type SwipeDirection,
} from "./swipeDeckModel";

const GEOMETRY: DeckGeometry = { width: 402, height: 874, reduceMotion: false };
const REDUCED: DeckGeometry = { ...GEOMETRY, reduceMotion: true };
const DIRECTIONS: readonly SwipeDirection[] = ["left", "right", "up"];

/** What the deck shows at one frame: the cards the view tree still has, their native weights, the shared motion. */
interface Frame {
  mounted: Set<string>;
  weights: Record<string, CardWeights>;
  motion: DeckMotionState;
}

/**
 * The three changes a finished throw makes, on their two channels: `hide` (the thrown card's
 * presence to 0, native queue, sent first), `commit` (React: the thrown card unmounts) and `native`
 * (the promoted cards' weights and the motion reset, native queue, after `hide`). iOS may apply
 * the commit before, between or after the native batches.
 */
type Step = "hide" | "commit" | "native";
const ORDERS: readonly (readonly Step[])[] = [
  ["hide", "commit", "native"],
  ["hide", "native", "commit"],
  ["commit", "hide", "native"],
];

function apply(frame: Frame, step: Step, thrown: string, promoted: Record<string, SwipeCardRole>): Frame {
  const next: Frame = { mounted: new Set(frame.mounted), weights: { ...frame.weights }, motion: frame.motion };
  if (step === "hide") next.weights[thrown] = { ...(frame.weights[thrown] ?? weightsFor("top")), presence: 0 };
  if (step === "commit") next.mounted.delete(thrown);
  if (step === "native") {
    for (const [key, role] of Object.entries(promoted)) next.weights[key] = weightsFor(role, frame.weights[key]?.presence ?? 1);
    next.motion = REST;
  }
  return next;
}

function framesOf(order: readonly Step[], start: Frame, thrown: string, promoted: Record<string, SwipeCardRole>): Frame[] {
  const frames = [start];
  for (const step of order) frames.push(apply(frames[frames.length - 1] ?? start, step, thrown, promoted));
  return frames;
}

function poseOf(frame: Frame, key: string, geometry: DeckGeometry): CardPose | null {
  const weights = frame.weights[key];
  return frame.mounted.has(key) && weights !== undefined ? cardPose(weights, frame.motion, geometry) : null;
}

/** Drawn somewhere a person would see it: not hidden and not off the screen. */
function onScreen(pose: CardPose | null, geometry: DeckGeometry): boolean {
  if (pose === null || pose.opacity <= 0) return false;
  return Math.abs(pose.translateX) < geometry.width && pose.translateY > -geometry.height;
}

const close = (pose: CardPose | null, expected: Partial<CardPose>): void => {
  expect(pose).not.toBeNull();
  for (const [field, value] of Object.entries(expected)) expect(pose?.[field as keyof CardPose]).toBeCloseTo(value, 6);
};

/** The deck right as a throw finishes: A thrown, B underneath, C behind. */
function thrownDeck(direction: SwipeDirection, geometry: DeckGeometry): Frame {
  return {
    mounted: new Set(["A", "B", "C"]),
    weights: { A: weightsFor("top", geometry.reduceMotion ? 0 : 1), B: weightsFor("under"), C: weightsFor("waiting") },
    motion: geometry.reduceMotion ? REST : thrownMotion(direction, geometry),
  };
}

const PROMOTED: Record<string, SwipeCardRole> = { B: "top", C: "under" };

describe("swipe deck hand-over after a throw", () => {
  for (const direction of DIRECTIONS) {
    for (const order of ORDERS) {
      it(`${direction}, ${order.join(" > ")}: the thrown card never comes back and the next card never moves`, () => {
        for (const frame of framesOf(order, thrownDeck(direction, GEOMETRY), "A", PROMOTED)) {
          expect(onScreen(poseOf(frame, "A", GEOMETRY), GEOMETRY)).toBe(false);
          // The next card sits exactly where it will rest as the top card, with no action overlay.
          close(poseOf(frame, "B", GEOMETRY), { translateX: 0, translateY: 0, scale: 1, rotateDeg: 0, opacity: 1, overlay: 0 });
          // The one behind has already moved up to the "under" place.
          close(poseOf(frame, "C", GEOMETRY), { translateX: 0, translateY: STEP_DROP, scale: 1 - STEP_SCALE, opacity: 1, overlay: 0 });
        }
      });
    }
  }

  it("Reduce Motion: the faded card stays hidden and the flat stack never moves", () => {
    for (const order of ORDERS) {
      for (const frame of framesOf(order, thrownDeck("right", REDUCED), "A", PROMOTED)) {
        expect(onScreen(poseOf(frame, "A", REDUCED), REDUCED)).toBe(false);
        close(poseOf(frame, "B", REDUCED), { translateX: 0, translateY: 0, scale: 1, opacity: 1, overlay: 0 });
        close(poseOf(frame, "C", REDUCED), { translateY: 0, scale: 1 });
      }
    }
  });

  it("catches the old flash: without the hide, a reset that lands before the commit draws the thrown card in the middle", () => {
    const start = thrownDeck("right", GEOMETRY);
    const resetFirst = apply(start, "native", "A", PROMOTED);
    expect(onScreen(poseOf(resetFirst, "A", GEOMETRY), GEOMETRY)).toBe(true);
    close(poseOf(resetFirst, "A", GEOMETRY), { translateX: 0, opacity: 1 });
  });
});

describe("swipe deck motion", () => {
  it("a throw ends off screen, faded, with the cards underneath a full level up", () => {
    for (const direction of DIRECTIONS) {
      const motion = thrownMotion(direction, GEOMETRY);
      const top = cardPose(weightsFor("top"), motion, GEOMETRY);
      expect(top.opacity).toBe(0);
      expect(onScreen({ ...top, opacity: 1 }, GEOMETRY)).toBe(false);
      close(cardPose(weightsFor("under"), motion, GEOMETRY), { scale: 1, translateY: 0 });
    }
  });

  it("a drag up to the threshold neither fades the card nor fully lifts the one underneath", () => {
    const motion = { x: GEOMETRY.width * 0.35, y: 0, lift: 0 };
    const top = cardPose(weightsFor("top"), motion, GEOMETRY);
    expect(top.opacity).toBe(1);
    expect(top.overlay).toBe(1);
    expect(top.rotateDeg).toBeGreaterThan(0);
    const under = cardPose(weightsFor("under"), motion, GEOMETRY);
    expect(under.scale).toBeGreaterThan(1 - STEP_SCALE);
    expect(under.scale).toBeLessThan(1);
  });

  it("at rest the stack peeks: under one level down, the next two", () => {
    close(cardPose(weightsFor("top"), REST, GEOMETRY), { translateY: 0, scale: 1, opacity: 1, overlay: 0 });
    close(cardPose(weightsFor("under"), REST, GEOMETRY), { translateY: STEP_DROP, scale: 1 - STEP_SCALE });
    close(cardPose(weightsFor("waiting"), REST, GEOMETRY), { translateY: STEP_DROP * 2, scale: 1 - STEP_SCALE * 2 });
  });

  it("Reduce Motion drags without tilt", () => {
    expect(cardPose(weightsFor("top"), { x: 150, y: 0, lift: 0 }, REDUCED).rotateDeg).toBe(0);
  });
});

describe("deckSlots", () => {
  const keyOf = (id: string): string => id;

  it("mounts the first three items as top, under and waiting", () => {
    expect(deckSlots(["a", "b", "c", "d"], keyOf, {})).toEqual([
      { item: "a", key: "a:0", role: "top" },
      { item: "b", key: "b:0", role: "under" },
      { item: "c", key: "c:0", role: "waiting" },
    ]);
  });

  it("a card thrown back into a short deck gets a new key, so its thrown instance is never reused", () => {
    const before = deckSlots(["a", "b"], keyOf, {});
    const after = deckSlots(["b", "a"], keyOf, { a: 1 });
    expect(after.map((slot) => slot.key)).toEqual(["b:0", "a:1"]);
    expect(after.some((slot) => before.find((old) => old.item === "a")?.key === slot.key)).toBe(false);
  });
});
