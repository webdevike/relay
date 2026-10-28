import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTabs, type Artifact } from "@relay/protocol";
import { useArtifactsStore } from "@/state/artifacts";
import { ACT_TIMEOUT_MS, createArtifactFrameRouter, PendingActs } from "./artifacts";

const item: Artifact = { id: "linear:ENG-1", kind: "linear", title: "Ticket", mentions: 2, firstSeen: 1, lastSeen: 2, sources: [], addedBy: "extractor" };

describe("artifact frames", () => {
  beforeEach(() => {
    useArtifactsStore.getState().clear();
  });

  it("stores a thread's snapshot", () => {
    const route = createArtifactFrameRouter(useArtifactsStore.getState(), new PendingActs());
    route({ t: "artifacts.snapshot", thread: "assistant:astra", items: [item], tabs: defaultTabs() });
    expect(useArtifactsStore.getState().threads["assistant:astra"]?.items).toEqual([item]);
    route({ t: "artifacts.snapshot", thread: "assistant:astra", items: [], tabs: defaultTabs() });
    expect(useArtifactsStore.getState().threads["assistant:astra"]?.items).toEqual([]);
  });

  it("pins and patches tabs at once", () => {
    const store = useArtifactsStore.getState();
    store.set("assistant:nova", { items: [item], tabs: defaultTabs() });
    store.pin("assistant:nova", item.id, { by: "isaac", at: 5 });
    expect(useArtifactsStore.getState().threads["assistant:nova"]?.items[0]?.pinned).toEqual({ by: "isaac", at: 5 });
    store.pin("assistant:nova", item.id, undefined);
    expect(useArtifactsStore.getState().threads["assistant:nova"]?.items[0]).not.toHaveProperty("pinned");
    store.patchTab("assistant:nova", "media", { hidden: true, title: "Pics" });
    expect(useArtifactsStore.getState().threads["assistant:nova"]?.tabs.find((tab) => tab.id === "media")).toMatchObject({ hidden: true, title: "Pics" });
    store.pin("assistant:none", item.id, undefined);
    expect(useArtifactsStore.getState().threads["assistant:none"]).toBeUndefined();
  });
});

describe("pending acts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the host's answer to its rid", async () => {
    const pending = new PendingActs();
    const route = createArtifactFrameRouter(useArtifactsStore.getState(), pending);
    const answer = pending.add("r1");
    route({ t: "artifacts.acted", rid: "other", ok: true });
    route({ t: "artifacts.acted", rid: "r1", ok: false, error: "Hidden tab" });
    await expect(answer).resolves.toEqual({ ok: false, error: "Hidden tab", id: undefined });
  });

  it("fails after the timeout and on cancel", async () => {
    vi.useFakeTimers();
    const pending = new PendingActs();
    const late = pending.add("r1");
    vi.advanceTimersByTime(ACT_TIMEOUT_MS);
    await expect(late).resolves.toMatchObject({ ok: false });
    const cut = pending.add("r2");
    pending.cancelAll();
    await expect(cut).resolves.toEqual({ ok: false, error: "Disconnected." });
  });
});
