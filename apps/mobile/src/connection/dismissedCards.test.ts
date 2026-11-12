import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@relay/protocol";

vi.mock("@/state/storage", () => ({
  fileStorage: { getItem: () => Promise.resolve(null), setItem: () => undefined, removeItem: () => undefined },
}));

import { useDismissedCardsStore } from "@/state/dismissedCards";
import { createDismissedCardFrameRouter, type DismissedCardFrameRouter } from "./dismissedCards";

let route: DismissedCardFrameRouter;
let sentUp: string[];

beforeEach(() => {
  useDismissedCardsStore.setState({ ids: [], pending: [], hostUp: false, synced: false });
  sentUp = [];
  route = createDismissedCardFrameRouter(useDismissedCardsStore.getState(), (id) => void sentUp.push(id));
});

const welcome = (features?: string[]) => ({ t: "welcome", ...(features === undefined ? {} : { features }) }) as unknown as ServerMessage;

describe("welcome", () => {
  it("says whether the host keeps dismissed cards, every time", () => {
    route(welcome(["query", "cards.dismissed"]));
    expect(useDismissedCardsStore.getState().hostUp).toBe(true);
    route(welcome(["query"]));
    expect(useDismissedCardsStore.getState().hostUp).toBe(false);
    route(welcome());
    expect(useDismissedCardsStore.getState().hostUp).toBe(false);
  });
});

describe("cards.dismissed", () => {
  it("replaces the set, and sends up what the phone dismissed unsynced, only with the first one", () => {
    useDismissedCardsStore.getState().apply("meeting:r1", true);
    useDismissedCardsStore.getState().apply("canvas:m1", true);
    route({ t: "cards.dismissed", ids: ["canvas:m1"] });
    route({ t: "cards.dismissed", ids: ["canvas:m1"] });
    expect(sentUp).toEqual(["meeting:r1"]);
    route({ t: "cards.dismissed", ids: [] });
    expect(useDismissedCardsStore.getState().ids).toEqual([]);
  });
});
