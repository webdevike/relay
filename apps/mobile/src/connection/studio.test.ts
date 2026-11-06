import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioSegments } from "@relay/protocol";
import { useStudioStore } from "@/state/studio";
import { EMPTY_CREATE } from "@/studio/create";
import { codexImage, job, output, project } from "@/studio/fixtures";
import { ALL_VIEW } from "@/studio/library";
import { createStudioFrameRouter, PendingStudio, type StudioFrameRouter } from "./studio";

const ids = (): string[] => useStudioStore.getState().jobs.map((j) => j.id);

const reference = (id: string, createdAt: number) => ({ id, kind: "style" as const, name: id, asset: output(`${id}-copy`, createdAt), createdAt });

const segments = (asset: string, state: StudioSegments["state"]): StudioSegments => ({
  asset,
  state,
  segments: state === "done" ? [{ id: `${asset}-s1`, label: "Object 1", box: [0.1, 0.1, 0.5, 0.5], area: 0.25, mask: "/studio/m/t", thumb: "/studio/m/t/thumb" }] : [],
});

let pending: PendingStudio;
let route: StudioFrameRouter;

beforeEach(() => {
  vi.useFakeTimers();
  useStudioStore.setState({ loaded: false, jobs: [], backends: [], projects: [], references: [], segments: {}, view: ALL_VIEW, create: EMPTY_CREATE });
  pending = new PendingStudio(1000);
  route = createStudioFrameRouter(useStudioStore.getState(), pending);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("studio.state", () => {
  it("replaces everything: jobs newest first, projects and references oldest first", () => {
    route({ t: "studio.state", jobs: [job("old", 1), job("new", 3), job("mid", 2)], uploads: [], backends: [codexImage], projects: [project("b", "B", 2), project("a", "A", 1)], references: [reference("r2", 2), reference("r1", 1)] });
    const state = useStudioStore.getState();
    expect(state.loaded).toBe(true);
    expect(ids()).toEqual(["new", "mid", "old"]);
    expect(state.backends).toEqual([codexImage]);
    expect(state.projects.map((p) => p.id)).toEqual(["a", "b"]);
    expect(state.references.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("studio.job", () => {
  it("inserts or replaces one job and keeps the list newest first", () => {
    route({ t: "studio.state", jobs: [job("a", 1), job("c", 3)], uploads: [], backends: [], projects: [], references: [] });
    route({ t: "studio.job", job: job("b", 2) });
    route({ t: "studio.job", job: job("c", 3, { state: "running", progress: 0.5, outputs: [] }) });
    expect(ids()).toEqual(["c", "b", "a"]);
    expect(useStudioStore.getState().jobs[0]?.progress).toBe(0.5);
  });
});

describe("studio.removed", () => {
  it("drops the job and the segments of its outputs", () => {
    route({ t: "studio.state", jobs: [job("a", 1), job("b", 2)], uploads: [], backends: [], projects: [], references: [] });
    route({ t: "studio.segments", ...segments("ao", "done") });
    route({ t: "studio.removed", id: "a" });
    expect(ids()).toEqual(["b"]);
    expect(useStudioStore.getState().segments).toEqual({});
  });
});

describe("studio.library", () => {
  it("replaces projects and references and leaves the jobs alone", () => {
    route({ t: "studio.state", jobs: [job("a", 1)], uploads: [], backends: [], projects: [project("old", "Old", 1)], references: [] });
    route({ t: "studio.library", projects: [project("p2", "Second", 5), project("p1", "First", 4)], references: [reference("r", 3)] });
    const state = useStudioStore.getState();
    expect(state.projects.map((p) => p.name)).toEqual(["First", "Second"]);
    expect(state.references.map((r) => r.id)).toEqual(["r"]);
    expect(ids()).toEqual(["a"]);
  });
});

describe("studio.segments", () => {
  it("keeps the latest state for each image, without the frame tag", () => {
    route({ t: "studio.segments", ...segments("x", "running") });
    route({ t: "studio.segments", ...segments("y", "queued") });
    route({ t: "studio.segments", ...segments("x", "done") });
    const kept = useStudioStore.getState().segments;
    expect(kept["x"]).toEqual(segments("x", "done"));
    expect(kept["y"]?.state).toBe("queued");
    expect(kept["x"]).not.toHaveProperty("t");
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

  it("shows every job a counted create queued at once", () => {
    const batch = [1, 2, 3].map((n) => job(`b${n}`, n, { state: "queued", progress: 0, outputs: [], batch: { id: "batch", index: n - 1, count: 3 } }));
    route({ t: "studio.res", rid: "r", ok: true, job: batch[0], jobs: batch });
    expect(ids()).toEqual(["b3", "b2", "b1"]);
  });

  it("adds a new project, reference and segments it answers with", () => {
    route({ t: "studio.res", rid: "r", ok: true, project: project("p", "Portraits", 1) });
    route({ t: "studio.res", rid: "r", ok: true, reference: reference("ref", 2) });
    route({ t: "studio.res", rid: "r", ok: true, segments: segments("img", "queued") });
    const state = useStudioStore.getState();
    expect(state.projects.map((p) => p.name)).toEqual(["Portraits"]);
    expect(state.references.map((r) => r.id)).toEqual(["ref"]);
    expect(state.segments["img"]?.state).toBe("queued");
  });

  it("changes nothing on a refusal", () => {
    route({ t: "studio.res", rid: "r", ok: false, error: "No", job: job("x", 1), project: project("p", "P", 1) });
    expect(ids()).toEqual([]);
    expect(useStudioStore.getState().projects).toEqual([]);
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
    route({ t: "studio.state", jobs: [job("a", 1)], uploads: [], backends: [], projects: [], references: [] });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "drop.removed", id: "a" });
    route({ t: "ack", id: "a" });
    expect(ids()).toEqual(["a"]);
  });
});
