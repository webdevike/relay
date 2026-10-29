/**
 * Studio as the phone last heard it: jobs (newest first), uploaded reference frames and the
 * backends the host offers, plus the composer's draft so Remix and "Use as frame" can fill it
 * from anywhere. Not persisted: the host owns the jobs and files and the driver asks for them on
 * every (re)connection.
 */
import { create } from "zustand";
import type { StudioAsset, StudioBackend, StudioJob, StudioState } from "@relay/protocol";
import { draftWithAsset, draftWithout, EMPTY_DRAFT, remixDraft, type StudioDraft, type StudioTarget } from "@/studio/draft";

export interface StudioStore {
  /** False until the first `studio.state` from this host. */
  loaded: boolean;
  jobs: StudioJob[];
  uploads: StudioAsset[];
  backends: StudioBackend[];
  draft: StudioDraft;
  setState: (state: StudioState) => void;
  /** Replaces the job with the same id, or inserts it; the list stays newest first. */
  upsertJob: (job: StudioJob) => void;
  addUpload: (asset: StudioAsset) => void;
  /** A deleted job or upload; slots in the draft that held its files empty. */
  remove: (id: string) => void;
  /** Another host: everything this one said goes. The draft's asset ids name its files, so they go too. */
  clear: () => void;
  patchDraft: (patch: Partial<StudioDraft>) => void;
  remix: (job: StudioJob) => void;
  putAsset: (target: StudioTarget, asset: string) => void;
}

const newestFirst = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;

export const useStudioStore = create<StudioStore>((set, get) => ({
  loaded: false,
  jobs: [],
  uploads: [],
  backends: [],
  draft: EMPTY_DRAFT,
  setState: ({ jobs, uploads, backends }) => {
    set({ loaded: true, jobs: [...jobs].sort(newestFirst), uploads: [...uploads].sort(newestFirst), backends });
  },
  upsertJob: (job) => {
    const jobs = get().jobs.filter((existing) => existing.id !== job.id);
    jobs.push(job);
    set({ jobs: jobs.sort(newestFirst) });
  },
  addUpload: (asset) => {
    const uploads = get().uploads.filter((existing) => existing.id !== asset.id);
    uploads.push(asset);
    set({ uploads: uploads.sort(newestFirst) });
  },
  remove: (id) => {
    const { jobs, uploads, draft } = get();
    const gone = new Set([id, ...(jobs.find((job) => job.id === id)?.outputs.map((output) => output.id) ?? [])]);
    set({
      jobs: jobs.filter((job) => job.id !== id),
      uploads: uploads.filter((upload) => upload.id !== id),
      draft: draftWithout(draft, gone),
    });
  },
  clear: () => {
    set({ loaded: false, jobs: [], uploads: [], backends: [], draft: { ...get().draft, frames: {}, refs: [] } });
  },
  patchDraft: (patch) => {
    set({ draft: { ...get().draft, ...patch } });
  },
  remix: (job) => {
    set({ draft: remixDraft(job) });
  },
  putAsset: (target, asset) => {
    set({ draft: draftWithAsset(get().draft, get().backends, target, asset) });
  },
}));
