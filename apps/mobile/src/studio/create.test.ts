import { describe, expect, it } from "vitest";
import { STUDIO_UNSORTED } from "@relay/protocol";
import { chosenEntry, createCount, createEntries, createOp, createPlan, createProblem, createSpec, createTarget, EMPTY_CREATE, refLimit, videoSettings, type CreateDraft } from "./create";
import { codexImage, comfy, HOST, higgsfield, ltx, model, moss, project } from "./fixtures";
import { ALL_VIEW } from "./library";

const draft = (patch: Partial<CreateDraft>): CreateDraft => ({ ...EMPTY_CREATE, ...patch });
const entries = createEntries(HOST);

describe("createEntries", () => {
  it("offers the models that make originals, grouped Local, ChatGPT, Paid", () => {
    expect(entries.map((e) => [e.group, e.label, e.key])).toEqual([
      ["Local", "MOSS-Image", "moss:moss-image"],
      ["Local", "Jib Mix Moss", "moss:jib-mix"],
      ["Local", "FLUX.2 Klein (ComfyUI)", "comfyui:klein-create"],
      ["ChatGPT", "Codex image", "codex-image:"],
      ["Paid", "Soul", "higgsfield:soul"],
    ]);
  });

  it("shows a backend that is down as one disabled entry with its reason", () => {
    const down = createEntries([{ ...moss, available: false, reason: "MLX is not installed" }, { ...comfy, available: false, reason: "ComfyUI is not running" }]);
    expect(down.map((e) => [e.label, e.available, e.reason])).toEqual([
      ["MOSS-Image", false, "MLX is not installed"],
      ["FLUX.2 Klein (ComfyUI)", false, "ComfyUI is not running"],
    ]);
  });

  it("leaves out edit engines, video, and paid backends with only video models", () => {
    const videoOnly = { ...higgsfield, models: higgsfield.models?.filter((m) => m.mode === "video") };
    expect(createEntries([videoOnly, { ...comfy, models: comfy.models?.filter((m) => m.id !== "klein-create") }])).toEqual([]);
  });
});

describe("chosenEntry and createCount", () => {
  it("keeps the chosen model, else starts on the first free available one", () => {
    expect(chosenEntry(draft({ entry: "codex-image:" }), entries)?.label).toBe("Codex image");
    expect(chosenEntry(draft({ entry: "gone:" }), entries)?.label).toBe("MOSS-Image");
    expect(chosenEntry(draft({}), createEntries([{ ...moss, available: false }, higgsfield]))?.label).toBe("Soul");
  });

  it("makes 1 to 4 images, and one at a time on a paid model", () => {
    expect(createCount(draft({ count: 3 }), entries[0])).toBe(3);
    expect(createCount(draft({ count: 9 }), entries[0])).toBe(4);
    expect(createCount(draft({ count: 3 }), entries.find((e) => e.paid))).toBe(1);
  });
});

describe("createTarget", () => {
  const projects = [project("p", "Portraits", 1)];
  it("follows the open project, Unsorted from All images and Favorites", () => {
    expect(createTarget(draft({}), { kind: "project", id: "p" }, projects)).toEqual({ id: "p", name: "Portraits" });
    expect(createTarget(draft({}), ALL_VIEW, projects)).toEqual({ id: STUDIO_UNSORTED, name: "Unsorted" });
    expect(createTarget(draft({}), { kind: "favorites" }, projects).id).toBe(STUDIO_UNSORTED);
  });

  it("uses the picked project while it exists", () => {
    expect(createTarget(draft({ target: "p" }), ALL_VIEW, projects).id).toBe("p");
    expect(createTarget(draft({ target: STUDIO_UNSORTED }), { kind: "project", id: "p" }, projects).id).toBe(STUDIO_UNSORTED);
    expect(createTarget(draft({ target: "gone" }), { kind: "project", id: "p" }, projects).id).toBe("p");
  });
});

describe("createProblem, createSpec and createOp", () => {
  it("waits for a prompt and a size for the aspect", () => {
    const mossEntry = chosenEntry(draft({}), entries);
    expect(createProblem(draft({}), mossEntry, HOST)).toBe("Describe what to make");
    expect(createProblem(draft({ prompt: "a fox", aspect: "9:16" }), chosenEntry(draft({ entry: "codex-image:" }), createEntries([{ ...codexImage, resolutions: [] }])), [{ ...codexImage, resolutions: [] }])).toBe("No 9:16 size for Codex image");
    expect(createProblem(draft({ prompt: "a fox" }), undefined, [])).toBe("No image model on this host");
  });

  it("builds one image spec at the model's first size, no seed", () => {
    const d = draft({ prompt: "  a fox in snow  ", aspect: "16:9", count: 4 });
    expect(createSpec(d, chosenEntry(d, entries), HOST)).toEqual({ mode: "image", backend: "moss", model: "moss-image", prompt: "a fox in snow", aspect: "16:9", resolution: "1344x768" });
    const codex = draft({ prompt: "a fox", entry: "codex-image:", aspect: "9:16" });
    expect(createSpec(codex, chosenEntry(codex, entries), HOST)).toEqual({ mode: "image", backend: "codex-image", prompt: "a fox", aspect: "9:16", resolution: "1024x1536" });
  });

  it("carries the confirmed credits only when the confirm sheet passes them", () => {
    const paid = draft({ prompt: "a fox", entry: "higgsfield:soul" });
    const entry = chosenEntry(paid, entries);
    expect(createSpec(paid, entry, HOST)).not.toHaveProperty("confirmCredits");
    expect(createSpec(paid, entry, HOST, 12)).toMatchObject({ backend: "higgsfield", model: "soul", confirmCredits: 12 });
  });

  it("sends one create with the count and the project (none for Unsorted)", () => {
    const spec = { mode: "image" as const, backend: "moss" as const, model: "moss-image", prompt: "a fox", aspect: "1:1" as const, resolution: "1024x1024" };
    expect(createOp(spec, 3, "p")).toEqual({ kind: "create", spec, origin: "phone", count: 3, project: "p" });
    expect(createOp(spec, 1, STUDIO_UNSORTED)).toEqual({ kind: "create", spec, origin: "phone" });
  });
});

describe("ComfyUI entries", () => {
  it("lists every preset the host offers that makes an image from a prompt, labelled with the model and where it runs", () => {
    const more = { ...comfy, models: [...(comfy.models ?? []), model("poster", "Poster", { refs: 0 })] };
    expect(createEntries([more]).map((e) => [e.key, e.label])).toEqual([
      ["comfyui:klein-create", "FLUX.2 Klein (ComfyUI)"],
      ["comfyui:poster", "Poster (ComfyUI)"],
    ]);
  });

  it("keeps each preset as its own disabled entry with the reason while ComfyUI is down", () => {
    const down = createEntries([{ ...comfy, available: false, reason: "ComfyUI is not running" }]);
    expect(down.map((e) => [e.label, e.available, e.reason])).toEqual([["FLUX.2 Klein (ComfyUI)", false, "ComfyUI is not running"]]);
  });
});

describe("video mode", () => {
  const videoDraft = (patch: Partial<CreateDraft> = {}) => draft({ mode: "video", prompt: "a fox runs", aspect: "9:16", ...patch });
  const videoEntries = createEntries(HOST, "video");

  it("offers LTX and the host's video models, free first, paid last", () => {
    expect(videoEntries.map((e) => [e.group, e.label, e.key])).toEqual([
      ["Local", "LTX video", "ltx:"],
      ["Paid", "Kling", "higgsfield:kling"],
    ]);
    const comfyVideo = { ...comfy, id: "comfyui-video" as const, mode: "video" as const, models: [model("wan", "Wan", { mode: "video", seconds: [5], resolutions: [{ id: "480p", label: "480p", aspect: "9:16" }] })] };
    expect(createEntries([comfyVideo], "video").map((e) => [e.label, e.key])).toEqual([["Wan (ComfyUI)", "comfyui-video:wan"]]);
  });

  it("builds a video spec at the model's first size and the default length, one per Generate", () => {
    const d = videoDraft({ count: 4 });
    const entry = chosenEntry(d, videoEntries);
    expect(createSpec(d, entry, HOST)).toEqual({ mode: "video", backend: "ltx", prompt: "a fox runs", aspect: "9:16", resolution: "384x672", seconds: 4 });
    expect(createCount(d, entry)).toBe(1);
  });

  it("uses the picked length only when the model offers it", () => {
    const entry = chosenEntry(videoDraft(), videoEntries);
    expect(createSpec(videoDraft({ seconds: 8 }), entry, HOST)).toMatchObject({ seconds: 8 });
    expect(createSpec(videoDraft({ seconds: 7 }), entry, HOST)).toMatchObject({ seconds: 4 });
    expect(videoSettings(videoDraft(), entry, HOST)?.seconds).toEqual([4, 8]);
  });

  it("LTX takes both keyframes or neither; with both, the start image is the parent", () => {
    const entry = chosenEntry(videoDraft(), videoEntries);
    expect(createProblem(videoDraft({ start: "a" }), entry, HOST)).toBe("LTX needs both a start and an end frame, or neither");
    expect(createPlan(videoDraft({ start: "a", end: "b" }), entry, HOST)).toMatchObject({ spec: { frames: { start: "a", end: "b" } }, parent: { asset: "a", how: "video" } });
  });

  it("says when the model has no size at this aspect or the prompt is empty", () => {
    const entry = chosenEntry(videoDraft(), videoEntries);
    expect(createProblem(videoDraft({ aspect: "16:9" }), entry, HOST)).toBe("No 16:9 size for LTX video");
    expect(createProblem(videoDraft({ prompt: " " }), entry, HOST)).toBe("Describe what to make");
    expect(createProblem(videoDraft(), undefined, [])).toBe("No video model on this host");
    expect(createProblem(videoDraft(), chosenEntry(videoDraft(), createEntries([{ ...ltx, available: false, reason: "LTX is not installed" }], "video")), [{ ...ltx, available: false, reason: "LTX is not installed" }])).toBe("LTX is not installed");
  });
});

describe("images with references become edits", () => {
  const withRefs = (patch: Partial<CreateDraft>) => draft({ prompt: "make it night", refs: ["a1"], ...patch });

  it("MOSS and FLUX.2 klein go to klein edit (one image), Combine (two), the first library image is the parent", () => {
    const one = withRefs({});
    expect(createPlan(one, chosenEntry(one, entries), HOST)).toMatchObject({ spec: { backend: "comfyui", model: "klein-edit", refs: ["a1"] }, parent: { asset: "a1", how: "edit" } });
    const two = withRefs({ refs: ["a1", "a2"] });
    expect(createPlan(two, chosenEntry(two, entries), HOST)).toMatchObject({ spec: { model: "combine", refs: ["a1", "a2"] }, parent: { asset: "a1", how: "combine" } });
    expect(createProblem(withRefs({ refs: ["a", "b", "c"] }), entries[0], HOST)).toBe("FLUX.2 klein takes at most 2 references");
  });

  it("Codex image becomes Codex edit; a paid model takes no references", () => {
    const codex = withRefs({ entry: "codex-image:" });
    expect(createPlan(codex, chosenEntry(codex, entries), HOST)).toMatchObject({ spec: { backend: "codex-edit", refs: ["a1"] } });
    const paid = withRefs({ entry: "higgsfield:soul" });
    expect(createProblem(paid, chosenEntry(paid, entries), HOST)).toBe("Paid models take no reference images");
  });

  it("limits how many images the draft can carry", () => {
    expect(refLimit(draft({}), entries[0], HOST)).toBe(2);
    expect(refLimit(draft({ entry: "codex-image:" }), entries.find((e) => e.key === "codex-image:"), HOST)).toBe(4);
    expect(refLimit(draft({}), entries.find((e) => e.paid), HOST)).toBe(0);
  });
});
