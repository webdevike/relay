/**
 * Studio's library as the phone shows it, derived from the host's jobs with the protocol's lineage
 * helpers: the grid of one view (All images, Favorites, a project, Unsorted), the switcher's rows
 * with cover and count, pending tiles, the GPU queue line, and the optimistic edits that favorite,
 * trash, restore and move apply before the host confirms them. Pure; the screen and the actions
 * call it.
 */
import {
  STUDIO_UNSORTED,
  studioIsOriginal,
  studioItems,
  studioJobActive,
  studioLineage,
  studioProjectOf,
  type StudioAsset,
  type StudioItem,
  type StudioJob,
  type StudioLineage,
  type StudioProject,
} from "@relay/protocol";

/** What the grid shows: every original, every favorite, or one project's originals (Unsorted is `STUDIO_UNSORTED`). */
export type LibraryView = { kind: "all" } | { kind: "favorites" } | { kind: "project"; id: string };

export const ALL_VIEW: LibraryView = { kind: "all" };

export interface Library {
  items: StudioItem[];
  lineage: StudioLineage;
}

export function libraryOf(jobs: readonly StudioJob[]): Library {
  const items = studioItems(jobs);
  return { items, lineage: studioLineage(items) };
}

export function sameView(a: LibraryView, b: LibraryView): boolean {
  return a.kind === b.kind && (a.kind !== "project" || (b.kind === "project" && a.id === b.id));
}

/** The view's project id, or undefined for All images and Favorites. */
export function viewProject(view: LibraryView): string | undefined {
  return view.kind === "project" ? view.id : undefined;
}

export function projectName(id: string, projects: readonly StudioProject[]): string {
  return id === STUDIO_UNSORTED ? "Unsorted" : (projects.find((p) => p.id === id)?.name ?? "Unsorted");
}

export function viewName(view: LibraryView, projects: readonly StudioProject[]): string {
  if (view.kind === "all") return "All images";
  if (view.kind === "favorites") return "Favorites";
  return projectName(view.id, projects);
}

/** A project view whose project is gone falls back to All images. */
export function liveView(view: LibraryView, projects: readonly StudioProject[]): LibraryView {
  if (view.kind !== "project" || view.id === STUDIO_UNSORTED || projects.some((p) => p.id === view.id)) return view;
  return ALL_VIEW;
}

/** The grid of a view, newest first: originals only, except Favorites, which lists every favorite. */
export function gridItems(library: Library, view: LibraryView): StudioItem[] {
  const { items, lineage } = library;
  if (view.kind === "favorites") return items.filter((item) => item.asset.favorite === true);
  return items.filter((item) => studioIsOriginal(item, lineage) && (view.kind === "all" || studioProjectOf(item.job) === view.id));
}

/** Queued and running originals (no parent) the view would show once they finish, newest first. */
export function pendingJobs(jobs: readonly StudioJob[], view: LibraryView): StudioJob[] {
  if (view.kind === "favorites") return [];
  return jobs
    .filter((job) => studioJobActive(job) && job.parent === undefined && (view.kind === "all" || studioProjectOf(job) === view.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export interface SwitcherRow {
  view: LibraryView;
  name: string;
  count: number;
  /** Thumb path of the newest image in it. */
  cover: string | undefined;
}

/** The project switcher: All images, Favorites, each project (oldest first), Unsorted. */
export function switcherRows(library: Library, projects: readonly StudioProject[]): SwitcherRow[] {
  const row = (view: LibraryView): SwitcherRow => {
    const grid = gridItems(library, view);
    return { view, name: viewName(view, projects), count: grid.length, cover: grid[0]?.asset.thumb };
  };
  return [
    row(ALL_VIEW),
    row({ kind: "favorites" }),
    ...projects.map((p) => row({ kind: "project", id: p.id })),
    row({ kind: "project", id: STUDIO_UNSORTED }),
  ];
}

export interface QueueSummary {
  running: StudioJob[];
  waiting: StudioJob[];
  failed: StudioJob[];
  /** "1 running · 2 waiting", "GPU idle". */
  label: string;
}

export function queueSummary(jobs: readonly StudioJob[]): QueueSummary {
  const running = jobs.filter((job) => job.state === "running");
  const waiting = jobs.filter((job) => job.state === "queued");
  const failed = jobs.filter((job) => job.state === "failed");
  const parts = [
    ...(running.length > 0 ? [`${running.length} running`] : []),
    ...(waiting.length > 0 ? [`${waiting.length} waiting`] : []),
    ...(failed.length > 0 ? [`${failed.length} failed`] : []),
  ];
  return { running, waiting, failed, label: parts.length === 0 ? "GPU idle" : parts.join(" · ") };
}

/** "1 image", "3 images". */
export function imageCount(n: number): string {
  return `${n} ${n === 1 ? "image" : "images"}`;
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

export function toggleSelected(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** The selection without ids the grid no longer shows (trashed, moved out of the view). */
export function keepVisible(selected: readonly string[], grid: readonly StudioItem[]): string[] {
  const shown = new Set(grid.map((item) => item.asset.id));
  const kept = selected.filter((id) => shown.has(id));
  return kept.length === selected.length ? (selected as string[]) : kept;
}

/** What Favorite does to a selection: favorites them all unless every one already is one. */
export function favoriteValue(ids: readonly string[], lineage: StudioLineage): boolean {
  return !ids.every((id) => lineage.byId.get(id)?.asset.favorite === true);
}

// ---------------------------------------------------------------------------------------------
// Optimistic edits (the host's `studio.job` frames confirm or correct them)
// ---------------------------------------------------------------------------------------------

export type AssetPatch = { favorite: boolean } | { deletedAt: number | undefined };

function patchAsset(asset: StudioAsset, patch: AssetPatch): StudioAsset {
  if ("favorite" in patch) return { ...asset, favorite: patch.favorite };
  if (patch.deletedAt !== undefined) return { ...asset, deletedAt: patch.deletedAt };
  const restored = { ...asset };
  delete restored.deletedAt;
  return restored;
}

/** The jobs with `ids` (outputs) favorited, trashed or restored; untouched jobs stay the same objects. */
export function withAssets(jobs: readonly StudioJob[], ids: readonly string[], patch: AssetPatch): StudioJob[] {
  const wanted = new Set(ids);
  return jobs.map((job) =>
    job.outputs.some((o) => wanted.has(o.id)) ? { ...job, outputs: job.outputs.map((o) => (wanted.has(o.id) ? patchAsset(o, patch) : o)) } : job,
  );
}

/** The jobs that made `ids` moved to `project` (STUDIO_UNSORTED clears it). */
export function withProject(jobs: readonly StudioJob[], ids: readonly string[], project: string): StudioJob[] {
  const wanted = new Set(ids);
  return jobs.map((job) => {
    if (!job.outputs.some((o) => wanted.has(o.id))) return job;
    if (project !== STUDIO_UNSORTED) return { ...job, project };
    const unsorted = { ...job };
    delete unsorted.project;
    return unsorted;
  });
}
