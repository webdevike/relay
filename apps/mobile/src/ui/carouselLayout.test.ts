// The open card carousel's slots laid out by Yoga, the engine that lays out the phone (the
// react-native-web harness lays out in the browser, which hid the empty thin bar of 2026-11-24).
import Yoga, { Edge, Errata, PositionType, type Node } from "yoga-layout";
import { describe, expect, it } from "vitest";
import { carouselCardWidth, slotFrame, type SlotFrame } from "./carouselMath";

const SCREEN = 393;
const CARD_PADDING_TOP = 10;
const CARD_BODY = 150;

/** A strip `stripHeight` tall holding one slot placed by `frame`, around a StackCard-like card. */
function layout(frame: SlotFrame, stripHeight: number): { slot: Node; card: Node } {
  const config = Yoga.Config.create();
  config.setErrata(Errata.All); // React Native's default ("classic") layout
  const node = (): Node => Yoga.Node.create(config);
  const strip = node();
  strip.setWidth(SCREEN);
  strip.setHeight(stripHeight);
  const { position, left, width, top } = frame;
  expect(position).toBe("absolute");
  const slot = node();
  slot.setPositionType(PositionType.Absolute);
  slot.setPosition(Edge.Left, left);
  slot.setPosition(Edge.Top, top);
  slot.setWidth(width);
  const card = node();
  card.setPadding(Edge.Top, CARD_PADDING_TOP);
  const body = node();
  body.setHeight(CARD_BODY);
  card.insertChild(body, 0);
  slot.insertChild(card, 0);
  strip.insertChild(slot, 0);
  strip.calculateLayout(SCREEN, stripHeight);
  return { slot, card };
}

describe("carousel slot layout on Yoga", () => {
  const width = carouselCardWidth(SCREEN);
  const left = (SCREEN - width) / 2;
  const cardHeight = CARD_PADDING_TOP + CARD_BODY;

  it("lays a card out at its full height before the strip has measured any card", () => {
    const { card } = layout(slotFrame(left, width, 0, 0), 0);
    expect(card.getComputedHeight()).toBe(cardHeight);
  });

  it("centres a measured card on the tallest card's strip", () => {
    const strip = 300;
    const { slot, card } = layout(slotFrame(left, width, strip, cardHeight), strip);
    expect(card.getComputedHeight()).toBe(cardHeight);
    expect(slot.getComputedTop()).toBe((strip - cardHeight) / 2);
    expect(slot.getComputedLeft()).toBe(left);
  });
});
