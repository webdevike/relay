import { beforeEach, describe, expect, it } from "vitest";
import { useLiveModelStore } from "./liveModel";

const store = () => useLiveModelStore.getState();
const holder = () => store().slot?.id ?? null;

describe("one live 3D view", () => {
  beforeEach(() => {
    useLiveModelStore.setState({ slot: null, seen: new Map() });
  });

  it("gives the slot to the newest message's model, whichever mounts first", () => {
    // Opening a thread: the inverted list mounts the newest row first.
    store().claim("newest", "annex.glb", false, 2);
    store().claim("older", "pantry.glb", false, 1);
    expect(holder()).toBe("newest");
    // Models arriving one by one: each newer one takes over.
    useLiveModelStore.setState({ slot: null, seen: new Map() });
    store().claim("first", "annex.glb", false, 1);
    store().claim("second", "pantry.glb", false, 2);
    expect(holder()).toBe("second");
  });

  it("hands the slot to a tapped model, and no newer model takes it from there", () => {
    store().claim("newest", "annex.glb", false, 2);
    store().claim("older", "pantry.glb", true, 1);
    expect(holder()).toBe("older");
    store().claim("latest", "stairs.glb", false, 3);
    expect(holder()).toBe("older");
  });

  it("frees the slot only when its holder unmounts", () => {
    store().claim("newest", "annex.glb", false, 2);
    store().release("older");
    expect(holder()).toBe("newest");
    store().release("newest");
    expect(holder()).toBeNull();
  });

  it("never loads a model on its own again once any view has mounted it", () => {
    // First open: the newest model loads, the older one waits behind it.
    store().claim("annex-1", "annex.glb", false, 2);
    store().claim("pantry-1", "pantry.glb", false, 1);
    store().release("annex-1");
    store().release("pantry-1");
    // Reopened thread: both remount with a free slot, neither loads until tapped.
    store().claim("annex-2", "annex.glb", false, 2);
    store().claim("pantry-2", "pantry.glb", false, 1);
    expect(holder()).toBeNull();
    // A model posted later still loads on its own.
    store().claim("stairs-1", "stairs.glb", false, 3);
    expect(holder()).toBe("stairs-1");
  });

  it("lets the same view take its model again (StrictMode re-runs effects)", () => {
    store().claim("view", "annex.glb", false, 1);
    store().release("view");
    store().claim("view", "annex.glb", false, 1);
    expect(holder()).toBe("view");
  });
});
