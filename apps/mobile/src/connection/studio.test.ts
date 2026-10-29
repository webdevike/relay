import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioAsset, StudioBackend, StudioJob } from "@relay/protocol";
import { useStudioStore } from "@/state/studio";
import { EMPTY_DRAFT } from "@/studio/draft";
import { createStudioFrameRouter, PendingStudio, type StudioFrameRouter } from "./studio";

function asset(id: string, createdAt: number, origin: StudioAsset["origin"] = "output"): StudioAsset {
  return { id, kind: "image", mimeType: "image/jpeg", width: 10, height: 10, size: 1, path: `/studio/${id}/t`, thumb: `/studio/${id}/t/thumb`, origin, createdAt };
}

function job(id: string, createdAt: number, patch: Partial<StudioJob> = {}): StudioJob {
  return {
    id,
    spec: { mode: "image", backend: "codex-image", prompt: id, aspect: "1:1", resolution: "1024x1024" },
    state: "queued",
    origin: "phone",
    createdAt,
    progress: 0,
    outputs: [],
    ...patch,
  };
}

const backend: StudioBackend = {
  id: "codex-image",
  label: "Image (Codex, free)",
  mode: "image",
  paid: false,
  available: true,
  resolutions: [],
  seconds: [],
  frames: [],
  refs: 0,
  seed: false,
  serial: false,
};

const ids = (): string[] => useStudioStore.getState().jobs.map((j) => j.id);

let pending: PendingStudio;
let route: StudioFrameRouter;

beforeEach(() => {
  vi.useFakeTimers();
  useStudioStore.setState({ loaded: false, jobs: [], uploads: [], backends: [], draft: EMPTY_DRAFT });
  pending = new PendingStudio(1000);
  route = createStudioFrameRouter(useStudioStore.getState(), pending);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("studio.state", () => {
  it("replaces everything, newest first", () => {
    route({ t: "studio.job", job: job("stale", 99) });
    route({ t: "studio.state", jobs: [job("old", 1), job("new", 3), job("mid", 2)], uploads: [asset("u1", 1, "upload"), asset("u2", 2, "upload")], backends: [backend] });
    const state = useStudioStore.getState();
    expect(ids()).toEqual(["new", "mid", "old"]);
    expect(state.uploads.map((u) => u.id)).toEqual(["u2", "u1"]);
    expect(state.backends).toEqual([backend]);
    expect(state.loaded).toBe(true);
  });
});

describe("studio.job", () => {
  it("inserts by createdAt and replaces by id", () => {
    route({ t: "studio.state", jobs: [job("b", 2)], uploads: [], backends: [] });
    route({ t: "studio.job", job: job("a", 1) });
    route({ t: "studio.job", job: job("c", 3) });
    route({ t: "studio.job", job: job("b", 2, { state: "running", progress: 0.5 }) });
    expect(ids()).toEqual(["c", "b", "a"]);
    expect(useStudioStore.getState().jobs[1]?.progress).toBe(0.5);
  });
});

describe("studio.removed", () => {
  it("drops a job, or an upload, by id and ignores unknown ids", () => {
    route({ t: "studio.state", jobs: [job("a", 1), job("b", 2)], uploads: [asset("u", 1, "upload")], backends: [] });
    route({ t: "studio.removed", id: "a" });
    route({ t: "studio.removed", id: "u" });
    route({ t: "studio.removed", id: "nope" });
    expect(ids()).toEqual(["b"]);
    expect(useStudioStore.getState().uploads).toEqual([]);
  });
});

describe("studio.res", () => {
  it("settles the request waiting on its rid with the host's answer", async () => {
    const answer = pending.add("r1");
    route({ t: "studio.res", rid: "r1", ok: true, credits: 12, balance: 400 });
    await expect(answer).resolves.toMatchObject({ rid: "r1", ok: true, credits: 12, balance: 400 });
  });

  it("ignores answers nobody waits for and leaves other requests waiting", async () => {
    const answer = pending.add("r1");
    route({ t: "studio.res", rid: "other", ok: false, error: "x" });
    route({ t: "studio.res", rid: "r1", ok: false, error: "Price went up" });
    await expect(answer).resolves.toMatchObject({ ok: false, error: "Price went up" });
  });

  it("shows a created job and a new upload at once", () => {
    route({ t: "studio.res", rid: "r", ok: true, job: job("new", 5) });
    route({ t: "studio.res", rid: "r", ok: true, asset: asset("up", 6, "upload") });
    expect(ids()).toEqual(["new"]);
    expect(useStudioStore.getState().uploads.map((u) => u.id)).toEqual(["up"]);
  });

  it("times out when the host never answers", async () => {
    const answer = pending.add("r1");
    vi.advanceTimersByTime(1000);
    await expect(answer).resolves.toEqual({ rid: "r1", ok: false, error: "Your Mac did not answer." });
    // A late answer after the timeout changes nothing.
    route({ t: "studio.res", rid: "r1", ok: true });
  });

  it("fails everything still waiting when the host changes", async () => {
    const one = pending.add("r1");
    const two = pending.add("r2");
    pending.cancelAll();
    await expect(one).resolves.toMatchObject({ ok: false, error: "Disconnected." });
    await expect(two).resolves.toMatchObject({ ok: false, error: "Disconnected." });
  });
});

describe("other frames", () => {
  it("leave the store alone", () => {
    route({ t: "studio.state", jobs: [job("a", 1)], uploads: [], backends: [] });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "drop.removed", id: "a" });
    route({ t: "ack", id: "a" });
    expect(ids()).toEqual(["a"]);
  });
});
