import { beforeEach, describe, expect, it } from "vitest";
import { useLiveModelStore } from "./liveModel";

const store = () => useLiveModelStore.getState();

describe("one live 3D view", () => {
  beforeEach(() => {
    useLiveModelStore.setState({ slot: null, seen: new Map() });
  });

  it("gives the slot to the first model that mounts; later mounts wait", () => {
    store().claim("newest", "annex.glb", false);
    store().claim("older", "pantry.glb", false);
    expect(store().slot).toBe("newest");
  });

  it("hands the slot to a tapped model", () => {
    store().claim("newest", "annex.glb", false);
    store().claim("older", "pantry.glb", true);
    expect(store().slot).toBe("older");
  });

  it("frees the slot only when its holder unmounts", () => {
    store().claim("newest", "annex.glb", false);
    store().release("older");
    expect(store().slot).toBe("newest");
    store().release("newest");
    expect(store().slot).toBeNull();
  });

  it("never loads a model on its own again once any view has mounted it", () => {
    // First open: the newest model loads, the older one waits behind it.
    store().claim("annex-1", "annex.glb", false);
    store().claim("pantry-1", "pantry.glb", false);
    store().release("annex-1");
    store().release("pantry-1");
    // Reopened thread: both remount with a free slot, neither loads until tapped.
    store().claim("annex-2", "annex.glb", false);
    store().claim("pantry-2", "pantry.glb", false);
    expect(store().slot).toBeNull();
    // A model posted later still loads on its own.
    store().claim("stairs-1", "stairs.glb", false);
    expect(store().slot).toBe("stairs-1");
  });

  it("lets the same view take its model again (StrictMode re-runs effects)", () => {
    store().claim("view", "annex.glb", false);
    store().release("view");
    store().claim("view", "annex.glb", false);
    expect(store().slot).toBe("view");
  });
});
