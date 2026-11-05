import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StudioSpec } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BACKEND_BASE, validateSpec } from "../src/studio/backends";
import {
  ComfyUIRunner,
  type ComfySocket,
  fillPlaceholders,
  loadPresets,
  PresetManifest,
  presetGap,
  presetValues,
} from "../src/studio/comfyui";
import type { Fetch } from "../src/studio/codex";
import type { StudioRunInput } from "../src/studio/runner";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-comfyui-"));
  dirs.push(dir);
  return dir;
}

const ANGLES = {
  id: "angles",
  name: "Angles",
  mode: "image",
  refs: 1,
  resolutions: [{ id: "1mp", label: "1 MP", aspect: "1:1" }],
  defaultPrompt: "same subject",
  promptTemplate: "{{angle}}. {{prompt}}",
  constants: { megapixels: 1 },
  inputs: [
    {
      kind: "choice",
      id: "angle",
      label: "Angle",
      default: "left",
      options: [
        { id: "left", label: "Left", value: "Rotate the camera 45 degrees to the left" },
        { id: "top", label: "Top", value: "Bird's-eye view from directly above" },
      ],
    },
    { kind: "number", id: "strength", label: "Strength", min: 0, max: 1.5, step: 0.05, default: 0.9 },
  ],
};

const WORKFLOW = {
  "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "qwen-edit.gguf" } },
  "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "angles.safetensors", strength_model: "{{strength}}" } },
  "3": { class_type: "LoadImage", inputs: { image: "{{image}}" } },
  "4": { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "{{prompt}}", image1: ["3", 0] } },
  "5": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: 4, megapixels: "{{megapixels}}" } },
  "9": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "studio/angles-{{seed}}" } },
};

const OBJECT_INFO = {
  UnetLoaderGGUF: { input: { required: { unet_name: [["qwen-edit.gguf"]] } } },
  LoraLoaderModelOnly: { input: { required: { lora_name: ["COMBO", { options: ["angles.safetensors"] }], strength_model: ["FLOAT", {}] } } },
  LoadImage: { input: { required: { image: [["example.png"], { image_upload: true }] } } },
  TextEncodeQwenImageEditPlus: { input: { required: { prompt: ["STRING", {}] } } },
  KSampler: { input: { required: { seed: ["INT", {}] } } },
  SaveImage: { input: { required: { filename_prefix: ["STRING", {}] } } },
};

function writePreset(root: string, manifest: object, workflow: object = WORKFLOW): void {
  const id = (manifest as { id: string }).id;
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "preset.json"), JSON.stringify(manifest));
  writeFileSync(join(root, id, "workflow.json"), JSON.stringify(workflow));
}

function spec(overrides: Partial<StudioSpec> = {}): StudioSpec {
  return { mode: "image", backend: "comfyui", prompt: "keep the logo", aspect: "1:1", resolution: "1mp", model: "angles", refs: ["a1"], ...overrides };
}

describe("preset values", () => {
  const manifest = PresetManifest.parse(ANGLES);

  it("fills the prompt template with the chosen option's text and the typed prompt", () => {
    const values = presetValues(manifest, { spec: spec({ params: { angle: "top", strength: 1.2 } }), seed: 7 });
    expect(values).toMatchObject({ prompt: "Bird's-eye view from directly above. keep the logo", strength: 1.2, seed: 7, megapixels: 1 });
  });

  it("falls back to defaults: the default option, number and prompt (a hidden prompt box sends the preset's name)", () => {
    const values = presetValues(manifest, { spec: spec({ prompt: "Angles" }), seed: 1 });
    expect(values).toMatchObject({ prompt: "Rotate the camera 45 degrees to the left. same subject", strength: 0.9 });
  });

  it("refuses an unknown option and an out-of-range number", () => {
    expect(() => presetValues(manifest, { spec: spec({ params: { angle: "under" } }) })).toThrow("Angles has no Angle under");
    expect(() => presetValues(manifest, { spec: spec({ params: { strength: 3 } }) })).toThrow("between 0 and 1.5");
  });

  it("takes width and height from a WxH resolution", () => {
    expect(presetValues(manifest, { spec: spec({ resolution: "768x1344" }) })).toMatchObject({ width: 768, height: 1344 });
  });
});

describe("placeholders", () => {
  it("keeps a lone placeholder's type, interpolates strings, leaves links alone", () => {
    const graph = fillPlaceholders(WORKFLOW, { strength: 0.75, image: "relay-1.png", prompt: "p", seed: 42, megapixels: 1 }) as typeof WORKFLOW;
    expect(graph["2"].inputs.strength_model).toBe(0.75);
    expect(graph["5"].inputs.seed).toBe(42);
    expect(graph["9"].inputs.filename_prefix).toBe("studio/angles-42");
    expect(graph["2"].inputs.model).toEqual(["1", 0]);
  });

  it("names a placeholder the job can't fill", () => {
    expect(() => fillPlaceholders({ a: "{{mask}}" }, {})).toThrow("{{mask}}");
  });
});

describe("preset gaps", () => {
  const preset = { manifest: PresetManifest.parse(ANGLES), workflow: WORKFLOW };

  it("passes when every node and file is on the server; placeholders never count as files", () => {
    expect(presetGap(preset, OBJECT_INFO)).toBeNull();
  });

  it("names a missing node class and a missing model file in either combo shape", () => {
    const noGguf = Object.fromEntries(Object.entries(OBJECT_INFO).filter(([name]) => name !== "UnetLoaderGGUF"));
    expect(presetGap(preset, noGguf)).toBe("the server has no UnetLoaderGGUF node");
    const noLora = { ...OBJECT_INFO, LoraLoaderModelOnly: { input: { required: { lora_name: ["COMBO", { options: ["other.safetensors"] }] } } } };
    expect(presetGap(preset, noLora)).toBe("the server has no angles.safetensors for LoraLoaderModelOnly");
    const noUnet = { ...OBJECT_INFO, UnetLoaderGGUF: { input: { required: { unet_name: [["flux.gguf"]] } } } };
    expect(presetGap(preset, noUnet)).toBe("the server has no qwen-edit.gguf for UnetLoaderGGUF");
  });

  it("loads valid folders and reports broken ones", () => {
    const root = freshDir();
    writePreset(root, ANGLES);
    writePreset(root, { ...ANGLES, id: "broken", mode: "sound" });
    const { presets, problems } = loadPresets(root);
    expect(presets.map((p) => p.manifest.id)).toEqual(["angles"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^broken: /);
  });
});

class FakeSocket implements ComfySocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
  send(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

interface FakeComfy {
  readonly calls: Call[];
  readonly socket: FakeSocket;
  readonly fetch: Fetch;
  /** Settles on the first `/history` poll, once the prompt is queued. */
  readonly polled: Promise<void>;
}

/** A ComfyUI that finishes (or fails) the prompt on its second `/history` poll. */
function fakeComfy(options: { readonly fail?: string; readonly never?: boolean } = {}): FakeComfy {
  const calls: Call[] = [];
  const socket = new FakeSocket();
  const polled = Promise.withResolvers<undefined>();
  let polls = 0;
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body instanceof FormData ? "form" : undefined;
    calls.push({ method, path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
    const json = (value: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
    if (url.pathname === "/object_info") return json(OBJECT_INFO);
    if (url.pathname === "/upload/image") return json({ name: "relay-job-1.png", subfolder: "", type: "input" });
    if (url.pathname === "/prompt") {
      socket.send({ type: "progress", data: { prompt_id: "someone-else", value: 9, max: 9 } });
      return json({ prompt_id: "p1", number: 1 });
    }
    if (url.pathname === "/history/p1") {
      polls += 1;
      socket.send({ type: "progress", data: { prompt_id: "p1", value: 2, max: 4 } });
      polled.resolve(undefined);
      if (polls < 2 || options.never === true) return json({});
      if (options.fail !== undefined)
        return json({
          p1: {
            status: { completed: false, status_str: "error", messages: [["execution_error", { node_type: "KSampler", exception_message: options.fail }]] },
            outputs: {},
          },
        });
      return json({
        p1: { status: { completed: true, status_str: "success", messages: [] }, outputs: { "9": { images: [{ filename: "angles_00001_.png", subfolder: "studio", type: "output" }] } } },
      });
    }
    if (url.pathname === "/view") return Promise.resolve(new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }));
    return json({});
  };
  return { calls, socket, fetch, polled: polled.promise };
}

function runner(root: string, comfy: FakeComfy, fetchOverride?: Fetch): ComfyUIRunner {
  return new ComfyUIRunner(
    {
      backend: "comfyui",
      url: "http://comfy.test",
      presetsDir: root,
      fetch: fetchOverride ?? comfy.fetch,
      socket: () => comfy.socket,
      readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    },
    1,
  );
}

function input(workDir: string, signal = new AbortController().signal, notes: string[] = []): StudioRunInput {
  return {
    spec: spec({ params: { angle: "top" } }),
    seed: 5,
    frames: {},
    refs: ["/studio/a1.png"],
    workDir,
    signal,
    note: (text) => notes.push(text),
    blocked: () => undefined,
  };
}

describe("ComfyUIRunner", () => {
  it("lists only the presets the server can run, as models without their option values", async () => {
    const root = freshDir();
    writePreset(root, ANGLES);
    writePreset(root, { ...ANGLES, id: "relight", name: "Relight" }, { "1": { class_type: "IC_Light", inputs: {} } });
    const backend = await runner(root, fakeComfy()).describe();
    expect(backend.available).toBe(true);
    expect(backend.models?.map((m) => m.id)).toEqual(["angles"]);
    expect(backend.models?.[0]?.inputs?.[0]).toEqual({
      kind: "choice",
      id: "angle",
      label: "Angle",
      default: "left",
      options: [
        { id: "left", label: "Left" },
        { id: "top", label: "Top" },
      ],
    });
  });

  it("is unavailable, saying why, when the server is down or no preset can run", async () => {
    const root = freshDir();
    writePreset(root, ANGLES);
    const down = runner(root, fakeComfy(), () => Promise.reject(new Error("ECONNREFUSED")));
    expect(await down.describe()).toMatchObject({ available: false, reason: "ComfyUI is not answering at http://comfy.test" });
    const empty = freshDir();
    expect(await runner(empty, fakeComfy()).describe()).toMatchObject({ available: false, reason: `no image presets in ${empty}` });
    const blocked = freshDir();
    writePreset(blocked, { ...ANGLES, id: "relight", name: "Relight" }, { "1": { class_type: "IC_Light", inputs: {} } });
    expect(await runner(blocked, fakeComfy()).describe()).toMatchObject({ available: false, reason: "Relight: the server has no IC_Light node" });
  });

  it("uploads the reference, queues the filled graph, shows its steps and saves the output", async () => {
    const root = freshDir();
    const workDir = freshDir();
    writePreset(root, ANGLES);
    const comfy = fakeComfy();
    const notes: string[] = [];
    const out = await runner(root, comfy).run(input(workDir, undefined, notes));
    expect(out).toEqual({ path: join(workDir, "out.png"), mimeType: "image/png" });
    expect([...readFileSync(out.path)]).toEqual([137, 80, 78, 71]);
    const queued = comfy.calls.find((call) => call.path === "/prompt")?.body as { prompt: typeof WORKFLOW };
    expect(queued.prompt["3"].inputs.image).toBe("relay-job-1.png");
    expect(queued.prompt["4"].inputs.prompt).toBe("Bird's-eye view from directly above. keep the logo");
    expect(queued.prompt["5"].inputs.seed).toBe(5);
    expect(notes).toContain("Step 2 of 4");
    expect(notes).not.toContain("Step 9 of 9");
    expect(comfy.calls.at(-1)?.path).toBe("/view?filename=angles_00001_.png&subfolder=studio&type=output");
    expect(comfy.socket.closed).toBe(true);
  });

  it("unloads the server's models before a preset of another family, not before one of the same", async () => {
    const root = freshDir();
    writePreset(root, { ...ANGLES, family: "qwen" });
    writePreset(root, { ...ANGLES, id: "relight", name: "Relight", family: "qwen" });
    writePreset(root, { ...ANGLES, id: "upscale", name: "Upscale" });
    const comfy = fakeComfy();
    const studio = runner(root, comfy);
    const runOf = (model: string): Promise<unknown> => studio.run({ ...input(freshDir()), spec: spec({ model }) });
    await runOf("angles");
    await runOf("relight");
    await runOf("upscale");
    const order = comfy.calls.map((call) => call.path).filter((path) => path === "/free" || path === "/prompt");
    expect(order).toEqual(["/prompt", "/prompt", "/free", "/prompt"]);
  });

  it("fails with the node and message ComfyUI reports", async () => {
    const root = freshDir();
    writePreset(root, ANGLES);
    await expect(runner(root, fakeComfy({ fail: "MPS out of memory\n" })).run(input(freshDir()))).rejects.toThrow(
      "ComfyUI failed in KSampler: MPS out of memory",
    );
  });

  it("a cancel takes the prompt off the queue and interrupts it", async () => {
    const root = freshDir();
    writePreset(root, ANGLES);
    const comfy = fakeComfy({ never: true });
    const controller = new AbortController();
    const running = runner(root, comfy).run(input(freshDir(), controller.signal));
    await comfy.polled;
    controller.abort();
    await expect(running).rejects.toThrow();
    const posts = comfy.calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]);
    expect(posts).toContainEqual(["/queue", { delete: ["p1"] }]);
    expect(posts).toContainEqual(["/interrupt", { prompt_id: "p1" }]);
  });
});

describe("preset specs", () => {
  const backend = {
    ...BACKEND_BASE.comfyui,
    available: true,
    models: [
      {
        id: "angles",
        name: "Angles",
        mode: "image" as const,
        resolutions: [{ id: "1mp", label: "1 MP", aspect: "1:1" as const }],
        seconds: [],
        frames: [],
        refs: 1,
        inputs: [{ kind: "choice" as const, id: "angle", label: "Angle", options: [{ id: "left", label: "Left" }], default: "left" }],
      },
      { id: "upscale", name: "Upscale", mode: "image" as const, resolutions: [{ id: "2x", label: "2x", aspect: "1:1" as const }], seconds: [], frames: [], refs: 1, minRefs: 1, prompt: false },
    ],
  };
  const lookup = (id: string) => ({ id, kind: "image" as const, mimeType: "image/png", width: 1, height: 1, size: 1, path: "/p", thumb: "/t", origin: "upload" as const, createdAt: 0 });

  it("checks references and settings against the preset, not the backend", () => {
    expect(validateSpec(spec(), backend, lookup)).toBeNull();
    expect(validateSpec(spec({ refs: ["a", "b"] }), backend, lookup)).toBe("Angles takes at most 1 reference images");
    expect(validateSpec(spec({ refs: [] }), backend, lookup)).toBe("Add a reference image to edit");
    expect(validateSpec(spec({ params: { angle: "under" } }), backend, lookup)).toBe("Angle has no option under");
    expect(validateSpec(spec({ params: { tilt: 3 } }), backend, lookup)).toBe("Angles has no setting tilt");
    expect(validateSpec(spec({ model: "upscale", resolution: "2x" }), backend, lookup)).toBeNull();
  });
});
