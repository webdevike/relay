import { beforeEach, describe, expect, it } from "vitest";
import type { StudioAsset, StudioBackend, StudioJob } from "@relay/protocol";
import { draftSpec, EMPTY_DRAFT, formProblem, stepParam, studioForm, type StudioDraft } from "@/studio/draft";
import { useStudioStore } from "./studio";

const res = (id: string, aspect: "9:16" | "16:9" | "1:1") => ({ id, label: id, aspect });

const ltx: StudioBackend = {
  id: "ltx",
  label: "Local video (LTX, free)",
  mode: "video",
  paid: false,
  available: true,
  resolutions: [res("384x672", "9:16"), res("672x384", "16:9")],
  seconds: [5, 8],
  frames: ["start", "mid", "end"],
  refs: 0,
  seed: true,
  serial: true,
};

const codexImage: StudioBackend = { ...ltx, id: "codex-image", label: "Image (Codex, free)", mode: "image", resolutions: [res("1024x1536", "9:16")], seconds: [], frames: [], seed: false, serial: false };
const codexEdit: StudioBackend = { ...codexImage, id: "codex-edit", label: "Image edit (Codex, free)", refs: 4 };

const higgsfield: StudioBackend = {
  id: "higgsfield",
  label: "Higgsfield (paid)",
  mode: "video",
  paid: true,
  available: true,
  resolutions: [],
  seconds: [],
  frames: [],
  refs: 0,
  seed: false,
  serial: false,
  balance: 500,
  models: [
    { id: "kling", name: "Kling", mode: "video", resolutions: [res("720p", "9:16")], seconds: [5, 10], frames: ["start"] },
    { id: "veo", name: "Veo", mode: "video", resolutions: [res("1080p", "9:16"), res("1080p-wide", "16:9")], seconds: [8], frames: [] },
  ],
};

const backends = [ltx, codexImage, codexEdit, higgsfield];

function job(id: string, createdAt: number, patch: Partial<StudioJob> = {}): StudioJob {
  return {
    id,
    spec: { mode: "image", backend: "codex-image", prompt: id, aspect: "9:16", resolution: "1024x1536" },
    state: "done",
    origin: "phone",
    createdAt,
    progress: 1,
    outputs: [],
    ...patch,
  };
}

function output(id: string): StudioAsset {
  return { id, kind: "image", mimeType: "image/png", width: 1, height: 1, size: 1, path: `/studio/${id}/t`, thumb: `/studio/${id}/t/thumb`, origin: "output", createdAt: 1 };
}

const draft = (patch: Partial<StudioDraft>): StudioDraft => ({ ...EMPTY_DRAFT, ...patch });

beforeEach(() => {
  useStudioStore.setState({ loaded: false, jobs: [], uploads: [], backends, draft: EMPTY_DRAFT });
});

describe("upsertJob", () => {
  it("keeps the list newest first whatever order jobs arrive in", () => {
    const { upsertJob } = useStudioStore.getState();
    upsertJob(job("b", 2));
    upsertJob(job("c", 3));
    upsertJob(job("a", 1));
    upsertJob(job("b", 2, { state: "failed" }));
    expect(useStudioStore.getState().jobs.map((j) => `${j.id}:${j.state}`)).toEqual(["c:done", "b:failed", "a:done"]);
  });
});

describe("remix", () => {
  it("fills the draft from the job, with the seed it ran with", () => {
    useStudioStore.getState().remix(
      job("j", 1, {
        spec: { mode: "video", backend: "ltx", prompt: "a fox", aspect: "16:9", resolution: "672x384", seconds: 8, frames: { start: "s", end: "e" } },
        seed: 42,
      }),
    );
    expect(useStudioStore.getState().draft).toEqual({
      mode: "video",
      backend: "ltx",
      model: undefined,
      prompt: "a fox",
      aspect: "16:9",
      resolution: "672x384",
      seconds: 8,
      seed: 42,
      frames: { start: "s", end: "e" },
      refs: [],
    });
  });

  it("never carries a paid job's confirmation into the next create", () => {
    useStudioStore.getState().remix(
      job("paid", 1, { spec: { mode: "video", backend: "higgsfield", model: "kling", prompt: "rain", aspect: "9:16", resolution: "720p", seconds: 5, confirmCredits: 30 }, credits: 30 }),
    );
    const state = useStudioStore.getState();
    expect(state.draft).not.toHaveProperty("confirmCredits");
    const form = studioForm(state.draft, state.backends);
    expect(draftSpec(form)).not.toHaveProperty("confirmCredits");
    expect(draftSpec(form, 31)?.confirmCredits).toBe(31);
    // The confirmed number lives only in that one spec; the draft is untouched by it.
    expect(useStudioStore.getState().draft).not.toHaveProperty("confirmCredits");
  });
});

describe("putAsset", () => {
  it("a keyframe switches to video on a backend that takes the slot", () => {
    useStudioStore.getState().patchDraft({ mode: "image", backend: "codex-image" });
    useStudioStore.getState().putAsset("start", "img");
    expect(useStudioStore.getState().draft).toMatchObject({ mode: "video", backend: "ltx", frames: { start: "img" } });
  });

  it("a reference switches to an edit backend and keeps at most its limit", () => {
    const { putAsset } = useStudioStore.getState();
    for (const id of ["a", "b", "c", "d", "e"]) putAsset("ref", id);
    expect(useStudioStore.getState().draft).toMatchObject({ mode: "image", backend: "codex-edit", refs: ["b", "c", "d", "e"] });
  });
});

describe("remove", () => {
  it("empties slots that held a deleted job's outputs or a deleted upload", () => {
    const store = useStudioStore.getState();
    store.upsertJob(job("j", 1, { outputs: [output("o1")] }));
    store.patchDraft({ frames: { start: "o1", end: "u1" }, refs: ["o1", "keep"] });
    store.remove("j");
    expect(useStudioStore.getState().draft).toMatchObject({ frames: { end: "u1" }, refs: ["keep"] });
    useStudioStore.getState().remove("u1");
    expect(useStudioStore.getState().draft.frames).toEqual({});
  });
});

describe("studioForm", () => {
  it("fits the draft to a backend of its mode and that backend's sizes", () => {
    const form = studioForm(draft({ mode: "video", backend: "codex-image", aspect: "16:9", resolution: "nope", seconds: 99 }), backends);
    expect(form.backend?.id).toBe("ltx");
    expect(form.draft).toMatchObject({ backend: "ltx", resolution: "672x384", seconds: 5 });
    expect(form.slots).toEqual(["start", "mid", "end"]);
  });

  it("takes Higgsfield's sizes, lengths and slots from the chosen model", () => {
    const form = studioForm(draft({ mode: "video", backend: "higgsfield", model: "veo", aspect: "16:9" }), backends);
    expect(form.draft).toMatchObject({ model: "veo", resolution: "1080p-wide", seconds: 8 });
    expect(form.slots).toEqual([]);
    expect(studioForm(draft({ mode: "video", backend: "higgsfield" }), backends).model?.id).toBe("kling");
  });

  it("skips an unavailable backend unless it was picked", () => {
    const down = { ...ltx, available: false, reason: "No GPU" };
    expect(studioForm(draft({ mode: "video" }), [down, higgsfield]).backend?.id).toBe("higgsfield");
    const picked = studioForm(draft({ mode: "video", backend: "ltx", prompt: "x" }), [down, higgsfield]);
    expect(formProblem(picked)).toBe("No GPU");
  });
});

describe("formProblem and draftSpec", () => {
  it("LTX takes a start and an end together, or neither", () => {
    const base = draft({ mode: "video", backend: "ltx", prompt: "waves" });
    expect(formProblem(studioForm({ ...base, frames: { start: "a" } }, backends))).toMatch(/start and an end/);
    expect(formProblem(studioForm({ ...base, frames: { start: "a", end: "b" } }, backends))).toBeUndefined();
    expect(formProblem(studioForm(base, backends))).toBeUndefined();
  });

  it("sends only what the backend takes", () => {
    const form = studioForm(draft({ mode: "image", backend: "codex-image", prompt: "  a cat  ", seed: 7, frames: { start: "x" }, refs: ["r"] }), backends);
    expect(draftSpec(form)).toEqual({ mode: "image", backend: "codex-image", prompt: "a cat", aspect: "9:16", resolution: "1024x1536" });
  });

  it("an edit needs a reference", () => {
    expect(formProblem(studioForm(draft({ backend: "codex-edit", prompt: "x" }), backends))).toBe("Add a reference image to edit");
  });
});

describe("ComfyUI presets", () => {
  const size = { resolutions: [res("1024x1024", "9:16")], seconds: [], frames: [] };
  const comfy: StudioBackend = {
    ...codexImage,
    id: "comfyui",
    label: "ComfyUI",
    refs: 2,
    models: [
      {
        id: "angles",
        name: "Angles",
        mode: "image",
        ...size,
        refs: 1,
        inputs: [
          { kind: "choice", id: "angle", label: "Angle", options: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], default: "low" },
          { kind: "number", id: "strength", label: "Strength", min: 0, max: 1, step: 0.1, default: 0.5 },
        ],
      },
      { id: "upscale", name: "Upscale", mode: "image", ...size, refs: 1, prompt: false },
      { id: "pair", name: "Pair", mode: "image", ...size, refs: 2, minRefs: 2 },
      { id: "plain", name: "Plain", mode: "image", ...size, refs: 0 },
    ],
  };
  const all = [...backends, comfy];
  const onComfy = (patch: Partial<StudioDraft>) => draft({ backend: "comfyui", ...patch });

  it("drops params the model doesn't list when the model switches", () => {
    useStudioStore.setState({ backends: all, draft: onComfy({ model: "angles", params: { angle: "high", strength: 0.8, stale: 1 } }) });
    expect(studioForm(useStudioStore.getState().draft, all).draft.params).toEqual({ angle: "high", strength: 0.8 });
    useStudioStore.getState().patchDraft({ model: "upscale" });
    expect(useStudioStore.getState().draft.params).toEqual({});
    useStudioStore.getState().patchDraft({ model: "angles" });
    expect(useStudioStore.getState().draft.params).toEqual({});
  });

  it("sends params only when there are some", () => {
    const some = studioForm(onComfy({ model: "angles", prompt: "x", refs: ["r"], params: { angle: "high" } }), all);
    expect(draftSpec(some)?.params).toEqual({ angle: "high" });
    expect(draftSpec(studioForm(onComfy({ model: "angles", prompt: "x", refs: ["r"] }), all))).not.toHaveProperty("params");
  });

  it("a preset without a prompt sends its name and doesn't ask for one", () => {
    const form = studioForm(onComfy({ model: "upscale", prompt: "", refs: ["r"] }), all);
    expect(form.takesPrompt).toBe(false);
    expect(formProblem(form)).toBeUndefined();
    expect(draftSpec(form)).toMatchObject({ prompt: "Upscale", model: "upscale", refs: ["r"] });
  });

  it("enforces the model's reference minimum and maximum", () => {
    expect(formProblem(studioForm(onComfy({ model: "angles", prompt: "x" }), all))).toBe("Add a reference image to edit");
    const pair = onComfy({ model: "pair", prompt: "x", refs: ["a"] });
    expect(formProblem(studioForm(pair, all))).toBe("Add 2 reference images");
    expect(formProblem(studioForm({ ...pair, refs: ["a", "b"] }, all))).toBeUndefined();
    expect(studioForm(onComfy({ model: "angles", prompt: "x", refs: ["a", "b"] }), all).refLimit).toBe(1);
    expect(draftSpec(studioForm(onComfy({ model: "angles", prompt: "x", refs: ["a", "b"] }), all))?.refs).toEqual(["a"]);
    // A model that takes no references needs none.
    expect(formProblem(studioForm(onComfy({ model: "plain", prompt: "x" }), all))).toBeUndefined();
  });

  it("steps a number input inside its range", () => {
    const strength = { kind: "number", id: "strength", label: "Strength", min: 0, max: 1, step: 0.1, default: 0.5 } as const;
    expect(stepParam(strength, 0.7, 1)).toBe(0.8);
    expect(stepParam(strength, 1, 1)).toBe(1);
    expect(stepParam(strength, 0, -1)).toBe(0);
  });
});
