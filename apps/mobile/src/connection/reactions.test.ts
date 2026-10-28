import { beforeEach, describe, expect, it } from "vitest";
import { ISAAC_REACTOR } from "@relay/protocol";
import { useReactionsStore } from "@/state/reactions";
import { createReactionFrameRouter, type ReactionFrameRouter } from "./reactions";

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: ReactionFrameRouter;

const heart = { emoji: "❤️", excerpt: "ship it", at: 10 };
const thumbs = { emoji: "👍", excerpt: "ship it", at: 11 };

beforeEach(() => {
  useReactionsStore.setState({ threads: {} });
  route = createReactionFrameRouter(useReactionsStore.getState());
});

describe("reactions.snapshot", () => {
  it("replaces that thread's reactions and leaves the others alone", () => {
    route({ t: "reactions.snapshot", thread: "assistant:nova", reactions: { "user@1": { isaac: heart } } });
    route({ t: "reactions.snapshot", thread: "session:abc", reactions: { "assistant@2": { isaac: thumbs } } });
    route({ t: "reactions.snapshot", thread: "assistant:nova", reactions: {} });
    expect(useReactionsStore.getState().threads).toEqual({ "assistant:nova": {}, "session:abc": { "assistant@2": { isaac: thumbs } } });
  });

  it("is authoritative over an optimistic tap", () => {
    useReactionsStore.getState().setLocal("assistant:nova", "assistant@5", "😂", "haha", 20);
    expect(useReactionsStore.getState().threads["assistant:nova"]?.["assistant@5"]?.[ISAAC_REACTOR]?.emoji).toBe("😂");
    route({ t: "reactions.snapshot", thread: "assistant:nova", reactions: { "assistant@5": { isaac: { emoji: "👎", excerpt: "haha", at: 21 } } } });
    expect(useReactionsStore.getState().threads["assistant:nova"]?.["assistant@5"]?.[ISAAC_REACTOR]?.emoji).toBe("👎");
  });

  it("keeps an assistant's reaction beside Isaac's, and Isaac's tap leaves it alone", () => {
    route({ t: "reactions.snapshot", thread: "assistant:nova", reactions: { "user@1": { nova: thumbs } } });
    const store = useReactionsStore.getState();
    store.setLocal("assistant:nova", "user@1", "❤️", "ship it", 12);
    expect(useReactionsStore.getState().threads["assistant:nova"]).toEqual({ "user@1": { nova: thumbs, isaac: { emoji: "❤️", excerpt: "ship it", at: 12 } } });
    store.setLocal("assistant:nova", "user@1", null, "ship it", 13);
    expect(useReactionsStore.getState().threads["assistant:nova"]).toEqual({ "user@1": { nova: thumbs } });
  });
});

describe("setLocal", () => {
  it("replaces Isaac's reaction and clears it for null", () => {
    const store = useReactionsStore.getState();
    store.setLocal("session:abc", "user@1", "👍", "hi", 1);
    store.setLocal("session:abc", "user@1", "‼️", "hi", 2);
    expect(useReactionsStore.getState().threads["session:abc"]).toEqual({ "user@1": { isaac: { emoji: "‼️", excerpt: "hi", at: 2 } } });
    store.setLocal("session:abc", "user@1", null, "hi", 3);
    expect(useReactionsStore.getState().threads["session:abc"]).toEqual({});
  });

  it("keeps the same objects when nothing changes, so selectors do not re-render", () => {
    const store = useReactionsStore.getState();
    store.setLocal("session:abc", "user@1", "👍", "hi", 1);
    const before = useReactionsStore.getState().threads;
    store.setLocal("session:abc", "user@1", "👍", "hi", 2);
    store.setLocal("session:abc", "user@9", null, "", 2);
    expect(useReactionsStore.getState().threads).toBe(before);
  });
});

describe("other frames", () => {
  it("leave reactions alone", () => {
    route({ t: "reactions.snapshot", thread: "assistant:nova", reactions: { "user@1": { isaac: heart } } });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "catchup.noted", id: "a", ok: true });
    expect(useReactionsStore.getState().threads["assistant:nova"]).toEqual({ "user@1": { isaac: heart } });
  });
});
