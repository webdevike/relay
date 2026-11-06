/** Studio data for tests: jobs, outputs, backends and projects shaped like the host's, no network. */
import type { StudioAsset, StudioBackend, StudioJob, StudioModel, StudioProject, StudioResolution } from "@relay/protocol";

export const res = (id: string, aspect: StudioResolution["aspect"]): StudioResolution => ({ id, label: id, aspect });

export function output(id: string, createdAt: number, patch: Partial<StudioAsset> = {}): StudioAsset {
  return { id, kind: "image", mimeType: "image/png", width: 1024, height: 1024, size: 1, path: `/studio/${id}/t`, thumb: `/studio/${id}/t/thumb`, origin: "output", createdAt, ...patch };
}

/** A finished job whose one output has the job's id plus `o` (`a` makes `ao`). */
export function job(id: string, createdAt: number, patch: Partial<StudioJob> = {}): StudioJob {
  return {
    id,
    spec: { mode: "image", backend: "moss", model: "moss-image", prompt: `prompt ${id}`, aspect: "1:1", resolution: "1024x1024" },
    state: "done",
    origin: "phone",
    createdAt,
    progress: 1,
    outputs: [output(`${id}o`, createdAt)],
    ...patch,
  };
}

export const project = (id: string, name: string, createdAt: number): StudioProject => ({ id, name, createdAt });

const model = (id: string, name: string, patch: Partial<StudioModel> = {}): StudioModel => ({ id, name, mode: "image", resolutions: [res("1024x1024", "1:1"), res("768x1344", "9:16"), res("1344x768", "16:9")], seconds: [], frames: [], ...patch });

const base: StudioBackend = { id: "moss", label: "MOSS-Image", mode: "image", paid: false, available: true, resolutions: [], seconds: [], frames: [], refs: 0, seed: true, serial: true };

export const moss: StudioBackend = { ...base, models: [model("moss-image", "MOSS-Image"), model("jib-mix", "Jib Mix Moss")] };
export const comfy: StudioBackend = {
  ...base,
  id: "comfyui",
  label: "ComfyUI",
  refs: 4,
  models: [model("klein-create", "FLUX.2 klein create", { refs: 0 }), model("qwen-edit", "Qwen Image Edit", { refs: 1, resolutions: [res("1mp", "1:1"), res("1mp-tall", "9:16"), res("1mp-wide", "16:9")] }), model("relight", "Relight")],
};
export const kontext: StudioBackend = { ...base, id: "kontext", label: "FLUX Kontext", refs: 1, resolutions: [res("1024x1024", "1:1")] };
export const codexImage: StudioBackend = { ...base, id: "codex-image", label: "Image (Codex, free)", seed: false, serial: false, resolutions: [res("1024x1024", "1:1"), res("1024x1536", "9:16"), res("1536x1024", "16:9")] };
export const codexEdit: StudioBackend = { ...codexImage, id: "codex-edit", label: "Image edit (Codex, free)", refs: 4 };
export const ltx: StudioBackend = { ...base, id: "ltx", label: "LTX video", mode: "video", resolutions: [res("384x672", "9:16")], seconds: [4, 8], frames: ["start", "end"] };
export const higgsfield: StudioBackend = {
  ...base,
  id: "higgsfield",
  label: "Higgsfield (paid)",
  mode: "video",
  paid: true,
  balance: 400,
  seed: false,
  serial: false,
  models: [model("kling", "Kling", { mode: "video", seconds: [5], resolutions: [res("720p", "9:16")] }), model("soul", "Soul")],
};

export const HOST: StudioBackend[] = [moss, comfy, kontext, codexImage, codexEdit, ltx, higgsfield];
