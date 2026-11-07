/**
 * What Studio's buttons do to the library: favorite, move, trash (with an Undo toast that sends
 * `restore`), new projects, cancel and clear jobs. Each library edit shows at once (the store
 * patches the jobs) and the host's frames confirm it; a refusal asks for the whole library again
 * so the phone matches the host, and says why. The toast is shared by the grid and the editor, so
 * an Undo survives closing the editor.
 */
import { create } from "zustand";
import { STUDIO_UNSORTED, studioFamily, type StudioOp, type StudioProject } from "@relay/protocol";
import { requestStudio, studioRequest } from "@/connection";
import { useStudioStore } from "@/state/studio";
import { confirmDelete } from "./confirm";
import { imageCount, libraryOf, projectName } from "./library";

/** How long a toast with Undo stays up. */
export const UNDO_TOAST_MS = 6000;
const TOAST_MS = 2600;

export interface StudioToast {
  text: string;
  action?: { label: string; run: () => void } | undefined;
}

interface ToastStore {
  toast: StudioToast | null;
  show: (toast: StudioToast, ms?: number) => void;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useStudioToast = create<ToastStore>((set) => ({
  toast: null,
  show: (toast, ms = toast.action === undefined ? TOAST_MS : UNDO_TOAST_MS) => {
    clearTimeout(timer);
    set({ toast });
    timer = setTimeout(() => {
      set({ toast: null });
    }, ms);
  },
  clear: () => {
    clearTimeout(timer);
    set({ toast: null });
  },
}));

export function toast(text: string, action?: StudioToast["action"]): void {
  useStudioToast.getState().show({ text, action });
}

/** Sends a library edit; a refusal re-reads the library (undoing the optimistic patch) and says why. */
async function send(op: StudioOp, failure: string): Promise<boolean> {
  const result = await studioRequest(op);
  if (result.ok) return true;
  requestStudio();
  toast(result.error ?? failure);
  return false;
}

export async function favoriteAssets(ids: readonly string[], value: boolean): Promise<void> {
  if (ids.length === 0) return;
  useStudioStore.getState().patchAssets(ids, { favorite: value });
  await send({ kind: "favorite", assets: [...ids], value }, "Your Mac did not save the favorite.");
}

async function restoreAssets(ids: readonly string[]): Promise<void> {
  useStudioStore.getState().patchAssets(ids, { deletedAt: undefined });
  await send({ kind: "restore", assets: [...ids] }, "Your Mac did not restore them.");
}

/** Trash now, with an Undo toast; the host deletes every copy once the undo window is over. */
export async function trashAssets(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  useStudioStore.getState().patchAssets(ids, { deletedAt: Date.now() });
  const kept = [...ids];
  toast(`Deleted ${imageCount(ids.length)}`, {
    label: "Undo",
    run: () => {
      void restoreAssets(kept);
    },
  });
  await send({ kind: "trash", assets: kept }, "Your Mac did not delete them.");
}

/**
 * Deletes images with everything made from them (an original takes all its versions, a version its
 * own edits), after one confirm that says how many images go. False when Isaac backs out; otherwise
 * it is the same trash, with its Undo toast, as `trashAssets`.
 */
export async function deleteImages(ids: readonly string[]): Promise<boolean> {
  const family = studioFamily(ids, libraryOf(useStudioStore.getState().jobs).lineage);
  if (family.length === 0) return false;
  if (!(await confirmDelete(family.length, ids.length))) return false;
  await trashAssets(family);
  return true;
}

/** Move to a project (STUDIO_UNSORTED for none), with an Undo toast that moves each back where it was. */
export async function moveAssets(ids: readonly string[], project: string): Promise<void> {
  if (ids.length === 0) return;
  const { jobs, projects } = useStudioStore.getState();
  const before = new Map<string, string[]>();
  for (const id of ids) {
    const from = jobs.find((job) => job.outputs.some((o) => o.id === id))?.project ?? STUDIO_UNSORTED;
    if (from === project) continue;
    before.set(from, [...(before.get(from) ?? []), id]);
  }
  if (before.size === 0) return;
  useStudioStore.getState().moveAssets(ids, project);
  toast(`Moved ${imageCount(ids.length)} to ${projectName(project, projects)}`, {
    label: "Undo",
    run: () => {
      for (const [from, back] of before) {
        useStudioStore.getState().moveAssets(back, from);
        void send({ kind: "move", assets: back, project: from }, "Your Mac did not move them back.");
      }
    },
  });
  await send({ kind: "move", assets: [...ids], project }, "Your Mac did not move them.");
}

/** A new project; undefined (with a toast) when the host refuses. */
export async function createProject(name: string): Promise<StudioProject | undefined> {
  const result = await studioRequest({ kind: "project.create", name: name.trim() });
  if (result.ok && result.project !== undefined) return result.project;
  toast(result.error ?? "Your Mac did not make the project.");
  return undefined;
}

export async function cancelJob(id: string): Promise<void> {
  const result = await studioRequest({ kind: "cancel", id });
  if (!result.ok) toast(result.error ?? "Your Mac did not cancel it.");
}

/** Clears a failed job from the queue. */
export async function dismissJob(id: string): Promise<void> {
  const result = await studioRequest({ kind: "delete", id });
  if (!result.ok) toast(result.error ?? "Your Mac did not clear it.");
}
