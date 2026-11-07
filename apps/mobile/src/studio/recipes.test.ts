import { describe, expect, it } from "vitest";
import type { StudioItem } from "@relay/protocol";
import { comfy, codexEdit, HOST, job, kontext, ltx, output } from "./fixtures";
import { createEntries } from "./create";
import { aspectsByCloseness, defaultEngine, editRecipe, engineProblem, EDIT_ENGINES, presetRecipe, toolPresets, videoRecipe } from "./recipes";

const item = (patch: Partial<StudioItem["asset"]> = {}, project?: string): StudioItem => {
  const asset = output("cur", 5, { width: 768, height: 1344, ...patch });
  return { asset, job: job("j", 5, { outputs: [asset], ...(project === undefined ? {} : { project }) }) };
};

describe("aspectsByCloseness", () => {
  it("orders the wire aspects by how close each is to the image", () => {
    expect(aspectsByCloseness(768, 1344)[0]).toBe("9:16");
    expect(aspectsByCloseness(1920, 1080)[0]).toBe("16:9");
    expect(aspectsByCloseness(1000, 1100)).toEqual(["1:1", "9:16", "16:9"]);
  });
});

describe("engines", () => {
  it("defaults to Qwen Image Edit, and to the next that runs when it can't", () => {
    expect(defaultEngine(HOST)).toBe("qwen");
    expect(defaultEngine([kontext, codexEdit])).toBe("kontext");
    expect(defaultEngine([])).toBe("qwen");
  });

  it("says why an engine can't run here", () => {
    const qwen = EDIT_ENGINES[0];
    if (qwen === undefined) throw new Error("no engines");
    expect(engineProblem(qwen, [{ ...comfy, available: false, reason: "ComfyUI is not running" }])).toBe("ComfyUI is not running");
    expect(engineProblem(qwen, [{ ...comfy, models: [] }])).toBe("Qwen Image Edit is not on this host");
    expect(engineProblem(qwen, HOST)).toBeUndefined();
  });
});

describe("editRecipe", () => {
  it("Qwen: the qwen-edit preset with the version as its one reference, parent how edit, in its project", () => {
    expect(editRecipe("qwen", item({}, "p"), " Make it night ", HOST)).toEqual({
      ok: true,
      op: {
        kind: "create",
        origin: "phone",
        spec: { mode: "image", backend: "comfyui", model: "qwen-edit", prompt: "Make it night", aspect: "9:16", resolution: "1mp-tall", refs: ["cur"] },
        project: "p",
        parent: { asset: "cur", how: "edit" },
      },
    });
  });

  it("Kontext and Codex: their own backend, the closest aspect they have a size for, Unsorted sends no project", () => {
    const kontextOp = editRecipe("kontext", item(), "Add warm sunlight", HOST);
    expect(kontextOp).toMatchObject({ ok: true, op: { spec: { backend: "kontext", aspect: "1:1", resolution: "1024x1024", refs: ["cur"] }, parent: { asset: "cur", how: "edit" } } });
    expect(kontextOp.ok && kontextOp.op).not.toHaveProperty("project");
    expect(kontextOp.ok && kontextOp.op.spec).not.toHaveProperty("model");
    expect(editRecipe("codex", item(), "Turn it into a watercolor", HOST)).toMatchObject({ ok: true, op: { spec: { backend: "codex-edit", aspect: "9:16", resolution: "1024x1536", refs: ["cur"] } } });
  });

  it("refuses an empty prompt, a video, and an engine the host lacks", () => {
    expect(editRecipe("qwen", item(), "  ", HOST)).toEqual({ ok: false, error: "Describe the edit first" });
    expect(editRecipe("qwen", item({ kind: "video", mimeType: "video/mp4" }), "night", HOST)).toEqual({ ok: false, error: "Only images can be edited" });
    expect(editRecipe("kontext", item(), "night", [comfy])).toEqual({ ok: false, error: "FLUX Kontext is not on this host" });
  });
});

describe("toolPresets and presetRecipe", () => {
  it("lists the host's one-picture ComfyUI presets, not the ones the engine picker and reference routing already use", () => {
    expect(toolPresets(HOST).map((m) => m.id)).toEqual(["relight", "klein-edit"]);
    expect(toolPresets([])).toEqual([]);
  });

  it("runs a preset on the version with its chosen params; the preset's name stands in for an empty prompt", () => {
    const relight = toolPresets(HOST)[0];
    if (relight === undefined) throw new Error("no relight");
    const made = presetRecipe(relight, item({}, "p"), "  ", { direction: "left" }, HOST);
    expect(made).toMatchObject({ ok: true, op: { spec: { backend: "comfyui", model: "relight", prompt: "Relight", refs: ["cur"], params: { direction: "left" } }, project: "p", parent: { asset: "cur", how: "edit" } } });
    expect(presetRecipe(relight, item(), "warm", {}, HOST)).toMatchObject({ ok: true, op: { spec: { prompt: "warm" } } });
    expect(presetRecipe(relight, item(), "x", {}, [{ ...comfy, available: false, reason: "ComfyUI is not running" }])).toEqual({ ok: false, error: "ComfyUI is not running" });
  });
});

describe("videoRecipe", () => {
  const ltxEntry = createEntries(HOST, "video")[0];
  const paidEntry = createEntries(HOST, "video").find((e) => e.paid);
  if (ltxEntry === undefined || paidEntry === undefined) throw new Error("no video entries");

  it("LTX: the version is the start frame and the parent, an end version completes the pair", () => {
    expect(videoRecipe(ltxEntry, item(), "", HOST, { seconds: 8, end: "v2" })).toMatchObject({
      ok: true,
      op: { spec: { mode: "video", backend: "ltx", prompt: "Subtle natural motion", aspect: "9:16", resolution: "384x672", seconds: 8, frames: { start: "cur", end: "v2" } }, parent: { asset: "cur", how: "video" } },
    });
  });

  it("explains what is missing: LTX's end frame, a paid model's confirmation, an image", () => {
    expect(videoRecipe(ltxEntry, item(), "pan", HOST)).toEqual({ ok: false, error: "LTX needs both a start and an end frame, or neither" });
    expect(videoRecipe(paidEntry, item(), "pan", HOST)).toEqual({ ok: false, error: "Paid videos start from the create bar" });
    expect(videoRecipe(ltxEntry, item({ kind: "video", mimeType: "video/mp4" }), "pan", [ltx])).toEqual({ ok: false, error: "Only images can start a video" });
  });
});
