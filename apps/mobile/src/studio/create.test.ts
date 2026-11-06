import { describe, expect, it } from "vitest";
import { STUDIO_UNSORTED } from "@relay/protocol";
import { chosenEntry, createCount, createEntries, createOp, createProblem, createSpec, createTarget, EMPTY_CREATE, type CreateDraft } from "./create";
import { codexImage, comfy, HOST, higgsfield, moss, project } from "./fixtures";
import { ALL_VIEW } from "./library";

const draft = (patch: Partial<CreateDraft>): CreateDraft => ({ ...EMPTY_CREATE, ...patch });
const entries = createEntries(HOST);

describe("createEntries", () => {
  it("offers the models that make originals, grouped Local, ChatGPT, Paid", () => {
    expect(entries.map((e) => [e.group, e.label, e.key])).toEqual([
      ["Local", "MOSS-Image", "moss:moss-image"],
      ["Local", "Jib Mix Moss", "moss:jib-mix"],
      ["Local", "FLUX.2 klein create", "comfyui:klein-create"],
      ["ChatGPT", "Codex image", "codex-image:"],
      ["Paid", "Soul", "higgsfield:soul"],
    ]);
  });

  it("shows a backend that is down as one disabled entry with its reason", () => {
    const down = createEntries([{ ...moss, available: false, reason: "MLX is not installed" }, { ...comfy, available: false, reason: "ComfyUI is not running" }]);
    expect(down.map((e) => [e.label, e.available, e.reason])).toEqual([
      ["MOSS-Image", false, "MLX is not installed"],
      ["FLUX.2 klein create", false, "ComfyUI is not running"],
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
