import { describe, expect, it } from "vitest";
import type { StudioBackend, StudioModel } from "@relay/protocol";
import { comfyReason, defaultEntry, draftChoice, draftForEntry, draftForTab, draftTab, EMPTY_DRAFT, studioEntries, studioForm, studioPresets, type StudioDraft } from "./draft";

const res = (id: string, aspect: "9:16" | "16:9" | "1:1") => ({ id, label: id, aspect });
const size = { resolutions: [res("1024x1024", "9:16")], seconds: [], frames: [] };

const base: StudioBackend = { id: "ltx", label: "LTX video", mode: "video", paid: false, available: true, resolutions: [res("384x672", "9:16")], seconds: [5], frames: ["start"], refs: 0, seed: true, serial: true };
const ltx = base;
const codexImage: StudioBackend = { ...base, id: "codex-image", label: "Codex image", mode: "image", seconds: [], frames: [], seed: false };
const codexEdit: StudioBackend = { ...codexImage, id: "codex-edit", label: "Codex edit", refs: 4 };
const model = (id: string, name: string, mode: "image" | "video" = "image"): StudioModel => ({ id, name, mode, ...size });
const moss: StudioBackend = { ...codexImage, id: "moss", label: "MOSS-Image", seed: true, resolutions: [], models: [model("moss-image", "MOSS-Image"), model("jib", "Jib Mix Moss")] };
const kontext: StudioBackend = { ...codexImage, id: "kontext", label: "FLUX Kontext", refs: 1 };
const higgsfield: StudioBackend = { ...base, id: "higgsfield", label: "Higgsfield", paid: true, balance: 90, models: [model("kling", "Kling", "video"), model("soul", "Soul", "image")] };
const comfy: StudioBackend = { ...codexImage, id: "comfyui", label: "ComfyUI", models: [model("create", "Create"), model("angles", "Angles")] };
const comfyVideo: StudioBackend = { ...base, id: "comfyui-video", label: "ComfyUI video", available: false, reason: "no video presets" };

const host = [ltx, codexImage, codexEdit, moss, kontext, comfy, comfyVideo, higgsfield];
const draft = (patch: Partial<StudioDraft>): StudioDraft => ({ ...EMPTY_DRAFT, ...patch });
const labels = (backends: StudioBackend[]) => studioEntries(backends).map((e) => e.label);

const some = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};
describe("studioEntries", () => {
  it("lists every model grouped Local, ChatGPT, Paid with images before videos", () => {
    expect(labels(host)).toEqual(["MOSS-Image", "Jib Mix Moss", "FLUX Kontext", "LTX video", "Codex image", "Codex edit", "Soul", "Kling"]);
    expect(studioEntries(host).map((e) => e.group)).toEqual(["Local", "Local", "Local", "Local", "ChatGPT", "ChatGPT", "Paid", "Paid"]);
  });

  it("leaves ComfyUI out and tags each entry with backend, model and mode", () => {
    const entries = studioEntries(host);
    expect(entries.some((e) => e.backend === "comfyui" || e.backend === "comfyui-video")).toBe(false);
    expect(entries[1]).toMatchObject({ backend: "moss", model: "jib", mode: "image", available: true });
    const ltxEntry = entries.find((e) => e.label === "LTX video");
    expect(ltxEntry).toMatchObject({ backend: "ltx", mode: "video" });
    expect(ltxEntry?.model).toBeUndefined();
  });

  it("shows an unavailable backend disabled with its reason, even one that has models", () => {
    const down = { ...higgsfield, available: false, reason: "Sign in to Higgsfield" };
    expect(studioEntries([down]).map((e) => ({ label: e.label, available: e.available, reason: e.reason, model: e.model }))).toEqual([
      { label: "Higgsfield", available: false, reason: "Sign in to Higgsfield", model: undefined },
    ]);
  });

  it("works on a host without moss", () => {
    expect(labels([ltx, codexImage, codexEdit, higgsfield])).toEqual(["LTX video", "Codex image", "Codex edit", "Soul", "Kling"]);
  });
});

describe("defaultEntry", () => {
  it("is the first available free entry", () => {
    expect(defaultEntry(host)).toMatchObject({ backend: "moss", model: "moss-image" });
    expect(defaultEntry([{ ...moss, available: false }, ltx, higgsfield])).toMatchObject({ backend: "ltx" });
  });

  it("falls back to a paid one, then to an unavailable one", () => {
    expect(defaultEntry([{ ...ltx, available: false }, higgsfield])).toMatchObject({ backend: "higgsfield", model: "soul" });
    expect(defaultEntry([{ ...ltx, available: false, reason: "No GPU" }])).toMatchObject({ backend: "ltx", available: false });
    expect(defaultEntry([])).toBeUndefined();
  });
});

describe("tabs", () => {
  it("derives the tab from the backend", () => {
    expect(draftTab({ backend: "comfyui" })).toBe("comfyui");
    expect(draftTab({ backend: "comfyui-video" })).toBe("comfyui");
    expect(draftTab({ backend: "moss" })).toBe("models");
    expect(draftTab({})).toBe("models");
  });

  it("lists presets of the available ComfyUI backends, and says why when there are none", () => {
    expect(studioPresets(host).map((e) => e.label)).toEqual(["Create", "Angles"]);
    expect(comfyReason(host)).toBeUndefined();
    expect(comfyReason([ltx, comfyVideo])).toBe("no video presets");
    expect(comfyReason([ltx])).toBeUndefined();
  });

  it("choosing an entry moves mode, backend and model together, clearing the model when there is none", () => {
    const mossEntry = some(studioEntries(host)[0]);
    const ltxEntry = some(studioEntries(host).find((e) => e.backend === "ltx"));
    const onMoss = draftForEntry(draft({ mode: "video", backend: "ltx" }), mossEntry);
    expect(onMoss).toMatchObject({ mode: "image", backend: "moss", model: "moss-image" });
    expect(draftForEntry(onMoss, ltxEntry)).toMatchObject({ mode: "video", backend: "ltx", model: undefined });
  });

  it("switches to the other tab's default, or to the choice it last held", () => {
    const onModels = draft({ mode: "image", backend: "moss", model: "jib" });
    const onComfy = draftForTab(onModels, host, "comfyui");
    expect(onComfy).toMatchObject({ mode: "image", backend: "comfyui", model: "create" });
    const back = some(onComfy);
    expect(draftForTab(back, host, "models")).toMatchObject({ backend: "moss", model: "moss-image" });
    expect(draftForTab(back, host, "models", draftChoice(onModels))).toMatchObject({ backend: "moss", model: "jib" });
    const remembered = draftChoice({ ...back, model: "angles" });
    expect(draftForTab(onModels, host, "comfyui", remembered)).toMatchObject({ backend: "comfyui", model: "angles" });
  });

  it("opens ComfyUI as its own unavailable backend when it has no presets, and nothing without ComfyUI", () => {
    const next = draftForTab(draft({ backend: "ltx", mode: "video" }), [ltx, comfyVideo], "comfyui");
    expect(next).toMatchObject({ backend: "comfyui-video", mode: "video", model: undefined });
    expect(draftForTab(draft({ backend: "ltx" }), [ltx], "comfyui")).toBeUndefined();
  });
});

describe("studioForm picker state", () => {
  it("starts on the default entry when the draft has no valid backend", () => {
    expect(studioForm(draft({}), host).draft).toMatchObject({ mode: "image", backend: "moss", model: "moss-image" });
    expect(studioForm(draft({ backend: "gone" as never }), [ltx, codexImage]).draft).toMatchObject({ mode: "video", backend: "ltx" });
  });

  it("serves a mixed-mode paid backend in the mode of its chosen model", () => {
    const image = studioForm(draft({ mode: "image", backend: "higgsfield", model: "soul" }), host);
    expect(image.backend?.id).toBe("higgsfield");
    expect(image.entry).toMatchObject({ label: "Soul", mode: "image" });
    const video = studioForm(draft({ mode: "video", backend: "higgsfield", model: "kling" }), host);
    expect(video.entry).toMatchObject({ label: "Kling", mode: "video" });
  });

  it("reports the chosen entry or preset and the tab", () => {
    const models = studioForm(draft({ backend: "codex-edit" }), host);
    expect(models).toMatchObject({ tab: "models", entry: { label: "Codex edit" } });
    const presets = studioForm(draft({ backend: "comfyui", model: "angles" }), host);
    expect(presets).toMatchObject({ tab: "comfyui", entry: { label: "Angles" } });
  });
});
