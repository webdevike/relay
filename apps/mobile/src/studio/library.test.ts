import { describe, expect, it } from "vitest";
import { STUDIO_UNSORTED, type StudioJob } from "@relay/protocol";
import { job, output, project } from "./fixtures";
import {
  ALL_VIEW,
  favoriteValue,
  gridItems,
  keepVisible,
  libraryOf,
  liveView,
  pendingJobs,
  queueSummary,
  switcherRows,
  toggleSelected,
  viewName,
  withAssets,
  withProject,
  type LibraryView,
} from "./library";

const child = (id: string, createdAt: number, parent: string, patch: Partial<StudioJob> = {}) => job(id, createdAt, { parent: { asset: parent, how: "edit" }, ...patch });

const jobs: StudioJob[] = [
  job("a", 1, { project: "p" }),
  child("a1", 2, "ao", { project: "p" }),
  child("a2", 3, "a1o", { project: "p" }),
  job("b", 4, { outputs: [output("bo", 4, { favorite: true })] }),
  job("c", 5, { project: "p" }),
  child("c1", 6, "co", { project: "p", outputs: [output("c1o", 6, { favorite: true })] }),
  job("d", 7, { outputs: [output("do", 7, { deletedAt: 20 })] }),
  // Its parent is trashed, so it counts as an original.
  child("e", 8, "do"),
  job("q1", 9, { state: "queued", progress: 0, outputs: [], project: "p" }),
  child("q2", 10, "ao", { state: "running", progress: 0.4, outputs: [] }),
  job("q3", 11, { state: "running", progress: 0.1, outputs: [] }),
  job("f", 12, { state: "failed", progress: 0, outputs: [], error: "Out of memory" }),
];
const library = libraryOf(jobs);
const projects = [project("p", "Portraits", 1)];
const ids = (view: LibraryView) => gridItems(library, view).map((item) => item.asset.id);
const unsorted: LibraryView = { kind: "project", id: STUDIO_UNSORTED };

describe("gridItems", () => {
  it("shows originals only, newest first, leaving trashed ones out", () => {
    expect(ids(ALL_VIEW)).toEqual(["eo", "co", "bo", "ao"]);
  });

  it("lists every favorite in Favorites, versions included", () => {
    expect(ids({ kind: "favorites" })).toEqual(["c1o", "bo"]);
  });

  it("narrows to one project, and Unsorted is every job naming none", () => {
    expect(ids({ kind: "project", id: "p" })).toEqual(["co", "ao"]);
    expect(ids(unsorted)).toEqual(["eo", "bo"]);
  });
});

describe("pendingJobs", () => {
  it("shows queued and running originals of the view, never versions", () => {
    expect(pendingJobs(jobs, ALL_VIEW).map((j) => j.id)).toEqual(["q3", "q1"]);
    expect(pendingJobs(jobs, { kind: "project", id: "p" }).map((j) => j.id)).toEqual(["q1"]);
    expect(pendingJobs(jobs, unsorted).map((j) => j.id)).toEqual(["q3"]);
    expect(pendingJobs(jobs, { kind: "favorites" })).toEqual([]);
  });
});

describe("switcherRows", () => {
  it("counts each view and covers it with its newest image", () => {
    expect(switcherRows(library, projects).map((r) => [r.name, r.count, r.cover])).toEqual([
      ["All images", 4, "/studio/eo/t/thumb"],
      ["Favorites", 2, "/studio/c1o/t/thumb"],
      ["Portraits", 2, "/studio/co/t/thumb"],
      ["Unsorted", 2, "/studio/eo/t/thumb"],
    ]);
  });
});

describe("views", () => {
  it("names views and falls back to All images when a project is gone", () => {
    expect(viewName({ kind: "project", id: "p" }, projects)).toBe("Portraits");
    expect(viewName(unsorted, projects)).toBe("Unsorted");
    expect(liveView({ kind: "project", id: "gone" }, projects)).toEqual(ALL_VIEW);
    expect(liveView(unsorted, [])).toEqual(unsorted);
  });
});

describe("queueSummary", () => {
  it("says what runs, waits and failed", () => {
    expect(queueSummary(jobs).label).toBe("2 running · 1 waiting · 1 failed");
    expect(queueSummary([job("x", 1, { state: "queued", progress: 0, outputs: [] })]).label).toBe("1 waiting");
    expect(queueSummary([job("y", 1)]).label).toBe("GPU idle");
  });
});

describe("selection", () => {
  it("toggles ids and drops the ones the grid no longer shows", () => {
    let selected = toggleSelected([], "ao");
    selected = toggleSelected(selected, "bo");
    selected = toggleSelected(selected, "ao");
    expect(selected).toEqual(["bo"]);
    const after = libraryOf(withAssets(jobs, ["bo"], { deletedAt: 30 }));
    expect(keepVisible(["bo", "co"], gridItems(after, ALL_VIEW))).toEqual(["co"]);
  });

  it("favorites a selection unless every image in it already is one", () => {
    expect(favoriteValue(["bo", "co"], library.lineage)).toBe(true);
    expect(favoriteValue(["bo", "c1o"], library.lineage)).toBe(false);
  });
});

describe("optimistic edits", () => {
  it("trash hides an image and restore brings it back", () => {
    const trashed = libraryOf(withAssets(jobs, ["ao"], { deletedAt: 30 }));
    // Its versions lose their parent, so the first one becomes an original of its own.
    expect(gridItems(trashed, ALL_VIEW).map((i) => i.asset.id)).toEqual(["eo", "co", "bo", "a1o"]);
    const restored = libraryOf(withAssets(withAssets(jobs, ["ao"], { deletedAt: 30 }), ["ao"], { deletedAt: undefined }));
    expect(gridItems(restored, ALL_VIEW).map((i) => i.asset.id)).toEqual(ids(ALL_VIEW));
  });

  it("leaves untouched jobs as the same objects", () => {
    const next = withAssets(jobs, ["bo"], { favorite: false });
    expect(next[0]).toBe(jobs[0]);
    expect(next[3]).not.toBe(jobs[3]);
  });

  it("move takes the image's job to the project and back", () => {
    const moved = withProject(jobs, ["bo"], "p");
    expect(gridItems(libraryOf(moved), { kind: "project", id: "p" }).map((i) => i.asset.id)).toEqual(["co", "bo", "ao"]);
    expect(withProject(moved, ["bo"], STUDIO_UNSORTED)[3]).not.toHaveProperty("project");
  });
});
