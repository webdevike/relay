/**
 * Studio as the phone last heard it: jobs (newest first), backends, projects, saved references and
 * SAM segments by image, plus what the screen keeps across visits (the open view and the create
 * bar's draft). Not persisted: the host owns the library and the driver asks for it on every
 * (re)connection. Favorite, trash, restore and move patch the jobs here at once (`patchAssets`,
 * `moveAssets`); the host's `studio.job` frames confirm them.
 */
import { create } from "zustand";
import type { StudioBackend, StudioJob, StudioLibrary, StudioProject, StudioReference, StudioSegments, StudioState } from "@relay/protocol";
import { EMPTY_CREATE, type CreateDraft } from "@/studio/create";
import { ALL_VIEW, withAssets, withProject, type AssetPatch, type LibraryView } from "@/studio/library";

export interface StudioStore {
  /** False until the first `studio.state` from this host. */
  loaded: boolean;
  jobs: StudioJob[];
  backends: StudioBackend[];
  /** Oldest first. */
  projects: StudioProject[];
  /** Saved Styles and Characters, oldest first. */
  references: StudioReference[];
  /** SAM 2.1's objects by image id. */
  segments: Record<string, StudioSegments>;
  view: LibraryView;
  create: CreateDraft;
  setState: (state: StudioState) => void;
  /** Replaces the job with the same id, or inserts it; the list stays newest first. */
  upsertJobs: (jobs: readonly StudioJob[]) => void;
  /** A deleted job (or upload). */
  remove: (id: string) => void;
  setLibrary: (library: StudioLibrary) => void;
  upsertProject: (project: StudioProject) => void;
  upsertReference: (reference: StudioReference) => void;
  setSegments: (segments: StudioSegments) => void;
  /** Favorite, trash or restore outputs before the host confirms. */
  patchAssets: (ids: readonly string[], patch: AssetPatch) => void;
  /** Move the jobs that made `ids` before the host confirms. */
  moveAssets: (ids: readonly string[], project: string) => void;
  setView: (view: LibraryView) => void;
  patchCreate: (patch: Partial<CreateDraft>) => void;
  /** Another host: everything this one said goes, and so do the view and target that name its projects. */
  clear: () => void;
}

const newestFirst = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;
const oldestFirst = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;

function upsert<T extends { id: string; createdAt: number }>(list: readonly T[], item: T): T[] {
  return [...list.filter((existing) => existing.id !== item.id), item].sort(oldestFirst);
}

export const useStudioStore = create<StudioStore>((set, get) => ({
  loaded: false,
  jobs: [],
  backends: [],
  projects: [],
  references: [],
  segments: {},
  view: ALL_VIEW,
  create: EMPTY_CREATE,
  setState: ({ jobs, backends, projects, references }) => {
    set({ loaded: true, jobs: [...jobs].sort(newestFirst), backends, projects: [...projects].sort(oldestFirst), references: [...references].sort(oldestFirst) });
  },
  upsertJobs: (incoming) => {
    const ids = new Set(incoming.map((job) => job.id));
    set({ jobs: [...get().jobs.filter((existing) => !ids.has(existing.id)), ...incoming].sort(newestFirst) });
  },
  remove: (id) => {
    const { jobs, segments } = get();
    const gone = jobs.find((job) => job.id === id)?.outputs.map((output) => output.id) ?? [];
    const kept = gone.some((asset) => asset in segments) ? Object.fromEntries(Object.entries(segments).filter(([asset]) => !gone.includes(asset))) : segments;
    set({ jobs: jobs.filter((job) => job.id !== id), segments: kept });
  },
  setLibrary: ({ projects, references }) => {
    set({ projects: [...projects].sort(oldestFirst), references: [...references].sort(oldestFirst) });
  },
  upsertProject: (project) => {
    set({ projects: upsert(get().projects, project) });
  },
  upsertReference: (reference) => {
    set({ references: upsert(get().references, reference) });
  },
  setSegments: (segments) => {
    set({ segments: { ...get().segments, [segments.asset]: segments } });
  },
  patchAssets: (ids, patch) => {
    set({ jobs: withAssets(get().jobs, ids, patch) });
  },
  moveAssets: (ids, project) => {
    set({ jobs: withProject(get().jobs, ids, project) });
  },
  setView: (view) => {
    set({ view });
  },
  patchCreate: (patch) => {
    set({ create: { ...get().create, ...patch } });
  },
  clear: () => {
    set({ loaded: false, jobs: [], backends: [], projects: [], references: [], segments: {}, view: ALL_VIEW, create: { ...get().create, target: null } });
  },
}));
