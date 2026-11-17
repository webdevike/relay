import { beforeEach, describe, expect, it } from "vitest";
import type { Trial, TrialSwitch } from "@relay/protocol";
import { useTrialsStore } from "@/state/trials";
import { createTrialFrameRouter, type TrialFrameRouter } from "./trials";

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: TrialFrameRouter;

const welcome = (features?: string[]) =>
  ({
    t: "welcome",
    state: { agents: { rev: 0, sessions: [] } },
    ...(features === undefined ? {} : { features }),
  }) as never;

const card = (id: string, overrides: Partial<Trial> = {}): Trial => ({
  id,
  agent: "diagram",
  label: "Diagram",
  thread: "assistant:nova",
  at: 100,
  arms: [
    { letter: "A", status: "done", preview: "a" },
    { letter: "B", status: "done", preview: "b" },
  ],
  ...overrides,
});

const switchOf = (id: string, overrides: Partial<TrialSwitch> = {}): TrialSwitch => ({
  id,
  agent: "diagram",
  label: "Diagram",
  thread: "assistant:nova",
  at: 200,
  text: "Diagram: switched to Sonnet 5.5",
  from: "opus",
  to: "sonnet",
  fromLabel: "Opus 5.5",
  toLabel: "Sonnet 5.5",
  kept: false,
  undone: false,
  ...overrides,
});

beforeEach(() => {
  useTrialsStore.setState({
    up: false,
    snapshot: { trials: [], switches: [] },
    fresh: [],
    asked: false,
    picking: {},
    undoing: {},
    failure: null,
  });
  route = createTrialFrameRouter(useTrialsStore.getState());
});

describe("welcome", () => {
  it("says whether the host keeps trials, every time", () => {
    route(welcome(["reply.widgets", "trials"]));
    expect(useTrialsStore.getState().up).toBe(true);
    route(welcome(["reply.widgets"]));
    expect(useTrialsStore.getState().up).toBe(false);
    route(welcome(["trials"]));
    route(welcome());
    expect(useTrialsStore.getState().up).toBe(false);
  });

  it("a lost socket offers nothing until the next welcome, keeps the cards and drops what was in flight", () => {
    route(welcome(["trials"]));
    route({ t: "trials.snapshot", trials: [card("t1")], switches: [] });
    useTrialsStore.getState().sentPick("t1", "A");
    useTrialsStore.getState().clearFeatures();
    expect(useTrialsStore.getState()).toMatchObject({ up: false, picking: {}, undoing: {} });
    expect(useTrialsStore.getState().snapshot.trials.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("trials.snapshot", () => {
  it("replaces the cards and switch messages", () => {
    route({ t: "trials.snapshot", trials: [card("t1")], switches: [switchOf("s1")] });
    route({ t: "trials.snapshot", trials: [card("t2")], switches: [] });
    expect(useTrialsStore.getState().snapshot).toEqual({ trials: [card("t2")], switches: [] });
  });

  it("the answer to trials.get draws still; a card or switch pushed after it arrives once", () => {
    const store = useTrialsStore.getState();
    store.ask();
    route({ t: "trials.snapshot", trials: [card("t1")], switches: [] });
    expect(useTrialsStore.getState()).toMatchObject({ fresh: [], asked: false });

    // A result filling in an existing card is not a new arrival.
    route({
      t: "trials.snapshot",
      trials: [card("t1", { pick: "A" }), card("t2")],
      switches: [switchOf("s1")],
    });
    expect(useTrialsStore.getState().fresh).toEqual(["t2", "s1"]);

    store.settle("t2");
    expect(useTrialsStore.getState().fresh).toEqual(["s1"]);
    route({ t: "trials.snapshot", trials: [card("t1"), card("t2")], switches: [switchOf("s1")] });
    expect(useTrialsStore.getState().fresh).toEqual(["s1"]);
  });

  it("a fresh mark goes with its card when the host drops it", () => {
    route({ t: "trials.snapshot", trials: [card("t1")], switches: [] });
    expect(useTrialsStore.getState().fresh).toEqual(["t1"]);
    route({ t: "trials.snapshot", trials: [], switches: [] });
    expect(useTrialsStore.getState().fresh).toEqual([]);
  });

  it("ends a pick or undo in flight once the snapshot shows it", () => {
    route({ t: "trials.snapshot", trials: [card("t1"), card("t2")], switches: [switchOf("s1")] });
    const store = useTrialsStore.getState();
    store.sentPick("t1", "B");
    store.sentPick("t2", "A");
    store.sentUndo("s1");
    route({
      t: "trials.snapshot",
      trials: [card("t1", { pick: "B" }), card("t2")],
      switches: [switchOf("s1", { undone: true })],
    });
    expect(useTrialsStore.getState()).toMatchObject({ picking: { t2: "A" }, undoing: {} });
  });
});

describe("trial.picked and trial.undone", () => {
  beforeEach(() => {
    route({ t: "trials.snapshot", trials: [card("t1")], switches: [switchOf("s1")] });
  });

  it("an accepted pick or undo ends it quietly", () => {
    const store = useTrialsStore.getState();
    store.sentPick("t1", "A");
    store.sentUndo("s1");
    route({ t: "trial.picked", trial: "t1", ok: true });
    route({ t: "trial.undone", switch: "s1", ok: true });
    expect(useTrialsStore.getState()).toMatchObject({ picking: {}, undoing: {}, failure: null });
  });

  it("a refusal ends it and becomes the thread's toast, a new object every time", () => {
    useTrialsStore.getState().sentPick("t1", "A");
    route({ t: "trial.picked", trial: "t1", ok: false, error: "already picked" });
    const first = useTrialsStore.getState().failure;
    expect(first).toEqual({ thread: "assistant:nova", text: "Pick not saved: already picked" });
    expect(useTrialsStore.getState().picking).toEqual({});

    route({ t: "trial.undone", switch: "s1", ok: false });
    expect(useTrialsStore.getState().failure).toEqual({
      thread: "assistant:nova",
      text: "Undo didn't go through",
    });
    expect(useTrialsStore.getState().failure).not.toBe(first);
  });
});

describe("other frames", () => {
  it("leave trials alone", () => {
    route({ t: "trials.snapshot", trials: [card("t1")], switches: [] });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "widgets.snapshot", thread: "assistant:nova", widgets: {} });
    expect(useTrialsStore.getState().snapshot.trials.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("clear", () => {
  it("forgets every card for another host", () => {
    route({ t: "trials.snapshot", trials: [card("t1")], switches: [switchOf("s1")] });
    useTrialsStore.getState().clear();
    expect(useTrialsStore.getState()).toMatchObject({
      snapshot: { trials: [], switches: [] },
      fresh: [],
      picking: {},
      failure: null,
    });
  });
});
