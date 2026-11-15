import { beforeEach, describe, expect, it } from "vitest";
import { useReplyWidgetsStore } from "@/state/replyWidgets";
import { createReplyWidgetFrameRouter, type ReplyWidgetFrameRouter } from "./replyWidgets";

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: ReplyWidgetFrameRouter;

const chart = "```openui\nroot = Card([])\n```";
const table = "```openui\nroot = Table([])\n```";

const welcome = (features?: string[]) =>
  ({ t: "welcome", state: { agents: { rev: 0, sessions: [] } }, ...(features === undefined ? {} : { features }) }) as never;

beforeEach(() => {
  useReplyWidgetsStore.setState({ widgetsUp: false, trainingUp: false, threads: {}, fresh: {}, asked: {}, labelAnswer: null });
  route = createReplyWidgetFrameRouter(useReplyWidgetsStore.getState());
});

describe("welcome", () => {
  it("says whether the host keeps reply widgets and takes labels, every time", () => {
    route(welcome(["bookmarks", "reply.widgets", "widget.training"]));
    expect(useReplyWidgetsStore.getState()).toMatchObject({ widgetsUp: true, trainingUp: true });
    route(welcome(["reply.widgets"]));
    expect(useReplyWidgetsStore.getState()).toMatchObject({ widgetsUp: true, trainingUp: false });
    route(welcome());
    expect(useReplyWidgetsStore.getState()).toMatchObject({ widgetsUp: false, trainingUp: false });
  });

  it("a lost socket offers nothing until the next welcome, and keeps the blocks shown", () => {
    route(welcome(["reply.widgets", "widget.training"]));
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@5": chart } });
    useReplyWidgetsStore.getState().clearFeatures();
    expect(useReplyWidgetsStore.getState()).toMatchObject({ widgetsUp: false, trainingUp: false });
    expect(useReplyWidgetsStore.getState().threads["assistant:nova"]).toEqual({ "assistant@5": chart });
  });
});

describe("widgets.snapshot", () => {
  it("replaces that thread's blocks and leaves the others alone", () => {
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@5": chart } });
    route({ t: "widgets.snapshot", thread: "assistant:astra", widgets: { "assistant@9": table } });
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: {} });
    expect(useReplyWidgetsStore.getState().threads).toEqual({ "assistant:nova": {}, "assistant:astra": { "assistant@9": table } });
  });

  it("the answer to the screen's own widgets.get draws still; a block pushed after it slides in once", () => {
    const store = useReplyWidgetsStore.getState();
    store.ask("assistant:nova");
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@5": chart } });
    expect(useReplyWidgetsStore.getState().fresh).toEqual({});
    expect(useReplyWidgetsStore.getState().asked).toEqual({});

    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@5": chart, "assistant@8": table } });
    expect(useReplyWidgetsStore.getState().fresh).toEqual({ "assistant:nova": ["assistant@8"] });

    // Its row drew it: a recycled row never animates it again.
    store.settle("assistant:nova", "assistant@8");
    expect(useReplyWidgetsStore.getState().fresh).toEqual({});
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@5": chart, "assistant@8": table } });
    expect(useReplyWidgetsStore.getState().fresh).toEqual({});
  });

  it("a fresh mark goes with its block when the host drops it", () => {
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@8": table } });
    expect(useReplyWidgetsStore.getState().fresh).toEqual({ "assistant:nova": ["assistant@8"] });
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: {} });
    expect(useReplyWidgetsStore.getState().fresh).toEqual({});
  });
});

describe("widget.labeled", () => {
  it("records each answer as a new object, even for the same reply", () => {
    route({ t: "widget.labeled", thread: "assistant:nova", message: "assistant@5", ok: true });
    const first = useReplyWidgetsStore.getState().labelAnswer;
    expect(first).toEqual({ thread: "assistant:nova", message: "assistant@5", ok: true, error: undefined });
    route({ t: "widget.labeled", thread: "assistant:nova", message: "assistant@5", ok: false, error: "disk full" });
    expect(useReplyWidgetsStore.getState().labelAnswer).not.toBe(first);
    expect(useReplyWidgetsStore.getState().labelAnswer).toEqual({ thread: "assistant:nova", message: "assistant@5", ok: false, error: "disk full" });
  });
});

describe("other frames", () => {
  it("leave reply widgets alone", () => {
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: { "assistant@5": chart } });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "reactions.snapshot", thread: "assistant:nova", reactions: {} });
    expect(useReplyWidgetsStore.getState().threads).toEqual({ "assistant:nova": { "assistant@5": chart } });
  });
});
