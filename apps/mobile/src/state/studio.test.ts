import { beforeEach, describe, expect, it } from "vitest";
import { STUDIO_UNSORTED, studioItems } from "@relay/protocol";
import { EMPTY_CREATE } from "@/studio/create";
import { HOST, job, project } from "@/studio/fixtures";
import { ALL_VIEW } from "@/studio/library";
import { useStudioStore } from "./studio";

const live = () => studioItems(useStudioStore.getState().jobs).map((item) => item.asset.id);

beforeEach(() => {
  useStudioStore.setState({ loaded: true, jobs: [job("b", 2), job("a", 1)], backends: HOST, projects: [project("p", "Portraits", 1)], references: [], segments: {}, view: ALL_VIEW, create: EMPTY_CREATE });
});

describe("upsertJobs", () => {
  it("keeps the list newest first whatever order jobs arrive in", () => {
    const { upsertJobs } = useStudioStore.getState();
    upsertJobs([job("c", 3)]);
    upsertJobs([job("b", 2, { state: "failed" }), job("d", 0)]);
    expect(useStudioStore.getState().jobs.map((j) => `${j.id}:${j.state}`)).toEqual(["c:done", "b:failed", "a:done", "d:done"]);
  });
});

describe("patchAssets", () => {
  it("favorites, trashes and restores outputs before the host confirms", () => {
    const { patchAssets } = useStudioStore.getState();
    patchAssets(["ao"], { favorite: true });
    expect(useStudioStore.getState().jobs.find((j) => j.id === "a")?.outputs[0]?.favorite).toBe(true);
    patchAssets(["ao", "bo"], { deletedAt: 5 });
    expect(live()).toEqual([]);
    patchAssets(["bo"], { deletedAt: undefined });
    expect(live()).toEqual(["bo"]);
    expect(useStudioStore.getState().jobs.find((j) => j.id === "b")?.outputs[0]).not.toHaveProperty("deletedAt");
  });
});

describe("moveAssets", () => {
  it("moves the jobs that made them, and Unsorted clears the project", () => {
    const { moveAssets } = useStudioStore.getState();
    moveAssets(["ao"], "p");
    expect(useStudioStore.getState().jobs.find((j) => j.id === "a")?.project).toBe("p");
    moveAssets(["ao"], STUDIO_UNSORTED);
    expect(useStudioStore.getState().jobs.find((j) => j.id === "a")).not.toHaveProperty("project");
  });
});

describe("clear", () => {
  it("forgets this host's library, view and target but keeps the typed prompt", () => {
    const store = useStudioStore.getState();
    store.setView({ kind: "project", id: "p" });
    store.patchCreate({ prompt: "a fox", target: "p", count: 3 });
    store.clear();
    const state = useStudioStore.getState();
    expect(state).toMatchObject({ loaded: false, jobs: [], backends: [], projects: [], references: [], segments: {}, view: ALL_VIEW });
    expect(state.create).toEqual({ ...EMPTY_CREATE, prompt: "a fox", count: 3, target: null });
  });
});
