/**
 * What Studio's buttons do: generate (free at once, paid only through the confirm sheet), cancel
 * and clear jobs, fill slots from the phone or the gallery, and the viewer's actions. The screen
 * stays layout; everything that talks to the host or the file system is here.
 */
import { useState } from "react";
import { ActionSheetIOS, Alert } from "react-native";
import type { StudioAsset, StudioBackend, StudioFrameSlot, StudioJob, StudioSpec } from "@relay/protocol";
import { hostBaseUrl, studioRequest } from "@/connection";
import { useStudioStore } from "@/state/studio";
import { saveToPhotos } from "@/drops/actions";
import { useTransientMessage } from "@/lib/useTransientMessage";
import { downloadAsset, shareFile, uploadFromDevice } from "./assets";
import { draftSpec, formProblem, type StudioForm, type StudioTarget } from "./draft";
import type { ViewerAction } from "./StudioViewer";

const TARGET_NAMES: Record<StudioTarget, string> = { start: "Start frame", mid: "Mid frame", end: "End frame", ref: "Reference" };

/** Where an image can go, given what the host's backends take. */
function targetsFor(backends: readonly StudioBackend[]): StudioTarget[] {
  const slots = new Set<StudioFrameSlot>();
  for (const b of backends) {
    if (b.mode !== "video") continue;
    for (const slot of b.frames) slots.add(slot);
    for (const model of b.models ?? []) if (model.mode === "video") for (const slot of model.frames) slots.add(slot);
  }
  const frames: StudioTarget[] = (["start", "mid", "end"] as const).filter((slot) => slots.has(slot));
  return backends.some((b) => b.mode === "image" && b.refs > 0) ? [...frames, "ref"] : frames;
}

/** An iOS action sheet over `options`; resolves with the picked index, or null for Cancel. */
function chooseFrom(title: string, options: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...options, "Cancel"], cancelButtonIndex: options.length }, (index) => {
      resolve(index >= options.length ? null : index);
    });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export interface ViewerItem {
  asset: StudioAsset;
  /** The job that made it; none for an upload. */
  job: StudioJob | undefined;
}

export interface PaidConfirm {
  spec: StudioSpec;
  form: StudioForm;
  error: string | null;
}

/** `onDraftFilled`: Remix or a new frame changed the composer; the screen scrolls up to it. */
export function useStudio(form: StudioForm, onDraftFilled: () => void) {
  const toast = useTransientMessage();
  const [generating, setGenerating] = useState(false);
  const [confirm, setConfirm] = useState<PaidConfirm | null>(null);
  const [uploading, setUploading] = useState<StudioTarget | null>(null);
  const [picking, setPicking] = useState<StudioTarget | null>(null);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ViewerItem | null>(null);
  const [viewerBusy, setViewerBusy] = useState<ViewerAction | null>(null);

  const create = async (spec: StudioSpec): Promise<string | null> => {
    const result = await studioRequest({ kind: "create", spec, origin: "phone" });
    if (!result.ok) return result.error ?? "Your Mac did not start the job.";
    toast.show(result.job?.state === "running" ? "Started" : "Queued");
    return null;
  };

  const generate = async () => {
    if (formProblem(form) !== undefined) return;
    const spec = draftSpec(form);
    if (spec === undefined) return;
    // Paid jobs never start from here: the confirm sheet prices them and Isaac taps to spend.
    if (form.backend?.paid === true) {
      setConfirm({ spec, form, error: null });
      return;
    }
    setGenerating(true);
    const error = await create(spec);
    setGenerating(false);
    if (error !== null) toast.show(error);
  };

  const confirmPaid = async (credits: number) => {
    if (confirm === null) return;
    const spec = draftSpec(confirm.form, credits);
    if (spec === undefined) return;
    setGenerating(true);
    const error = await create(spec);
    setGenerating(false);
    // Refused (the price rose, the balance ran out): a new spec object prices it again.
    if (error === null) setConfirm(null);
    else setConfirm({ ...confirm, spec: { ...confirm.spec }, error });
  };

  const jobRequest = async (job: StudioJob, kind: "cancel" | "delete") => {
    setBusyJob(job.id);
    const result = await studioRequest({ kind, id: job.id });
    setBusyJob(null);
    if (!result.ok) toast.show(result.error ?? (kind === "cancel" ? "Your Mac did not cancel it." : "Your Mac did not remove it."));
  };

  const remix = (job: StudioJob) => {
    useStudioStore.getState().remix(job);
    onDraftFilled();
    toast.show("Settings filled in");
  };

  const upload = async (target: StudioTarget) => {
    setUploading(target);
    try {
      const asset = await uploadFromDevice();
      if (asset !== null) useStudioStore.getState().putAsset(target, asset.id);
    } catch (error) {
      toast.show(errorText(error));
    } finally {
      setUploading(null);
    }
  };

  const add = async (target: StudioTarget) => {
    const choice = await chooseFrom(TARGET_NAMES[target], ["Upload from phone", "Pick from gallery"]);
    if (choice === 0) await upload(target);
    if (choice === 1) setPicking(target);
  };

  const pick = (asset: StudioAsset) => {
    if (picking !== null) useStudioStore.getState().putAsset(picking, asset.id);
    setPicking(null);
  };

  const asFrame = async (asset: StudioAsset) => {
    const targets = targetsFor(useStudioStore.getState().backends);
    if (targets.length === 0) {
      toast.show("No backend on this host takes frames");
      return;
    }
    const choice = await chooseFrom(asset.kind === "video" ? "Use the last frame as" : "Use as", targets.map((t) => TARGET_NAMES[t]));
    const target = choice === null ? undefined : targets[choice];
    if (target === undefined) return;
    let id = asset.id;
    if (asset.kind === "video") {
      setViewerBusy("frame");
      const result = await studioRequest({ kind: "frame", asset: asset.id, at: "last" });
      setViewerBusy(null);
      if (!result.ok || result.asset === undefined) {
        toast.show(result.error ?? "Your Mac did not grab the frame.");
        return;
      }
      id = result.asset.id;
    }
    useStudioStore.getState().putAsset(target, id);
    setViewing(null);
    onDraftFilled();
    toast.show(`Added as ${TARGET_NAMES[target].toLowerCase()}`);
  };

  const withFile = async (action: "save" | "share", asset: StudioAsset) => {
    const base = hostBaseUrl();
    if (base === null) {
      toast.show("Not connected to your Mac.");
      return;
    }
    setViewerBusy(action);
    try {
      const file = await downloadAsset(base, asset);
      if (action === "share") await shareFile(file, asset.mimeType);
      else toast.show((await saveToPhotos(file)) ? "Saved to Photos" : "Relay needs Photos access in Settings");
    } catch (error) {
      toast.show(errorText(error));
    } finally {
      setViewerBusy(null);
    }
  };

  const remove = (item: ViewerItem) => {
    const id = item.job?.id ?? item.asset.id;
    const count = item.job?.outputs.length ?? 1;
    const noun = item.asset.kind === "video" ? "video" : "image";
    Alert.alert(count > 1 ? `Delete these ${count} files?` : `Delete this ${noun}?`, "It is removed from your Mac too.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setViewerBusy("delete");
          void studioRequest({ kind: "delete", id }).then((result) => {
            setViewerBusy(null);
            if (result.ok) setViewing(null);
            else toast.show(result.error ?? "Your Mac did not delete it.");
          });
        },
      },
    ]);
  };

  const viewerAction = (action: ViewerAction) => {
    if (viewing === null) return;
    if (action === "remix") {
      if (viewing.job !== undefined) remix(viewing.job);
      setViewing(null);
    }
    if (action === "frame") void asFrame(viewing.asset);
    if (action === "save" || action === "share") void withFile(action, viewing.asset);
    if (action === "delete") remove(viewing);
  };

  return {
    message: toast.message,
    generating,
    generate,
    confirm,
    confirmPaid,
    closeConfirm: () => {
      setConfirm(null);
    },
    busyJob,
    cancel: (job: StudioJob) => jobRequest(job, "cancel"),
    dismiss: (job: StudioJob) => jobRequest(job, "delete"),
    remix,
    uploading,
    add,
    picking,
    pick,
    closePicker: () => {
      setPicking(null);
    },
    viewing,
    view: setViewing,
    closeViewer: () => {
      setViewing(null);
    },
    viewerBusy,
    viewerAction,
  };
}
