// Studio's library on the host: batches, projects, lineage, favorites, the trash and its purge of every copy
// (ComfyUI's own included), saved references, SAM 2.1 segments and masked edits, the machine-wide GPU lock,
// and the index migration. Every backend is a fake (or a real runner against a fake server); nothing generates.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STUDIO_UNDO_MS,
  STUDIO_UNSORTED,
  type StudioAsset,
  type StudioBackendId,
  type StudioJob,
  type StudioOp,
  type StudioResult,
  type StudioSpec,
} from "@relay/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "../src/studio/codex";
import { ComfyUIRunner } from "../src/studio/comfyui";
import { FlockGpuLock } from "../src/studio/gpu-lock";
import type { StudioRunner } from "../src/studio/runner";
import { GPU_BUSY_NOTE } from "../src/studio/service";
import { flush, imageSpec, ltxSpec, paidSpec, PNG, studioHarness, type StudioHarness } from "./studio-fakes";

const dirs: string[] = [];
const harnesses: StudioHarness[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-studio-library-"));
  dirs.push(dir);
  return dir;
}

function harness(dir = freshDir(), real?: Partial<Record<StudioBackendId, StudioRunner>>): StudioHarness {
  const h = studioHarness(dir, undefined, real);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.service.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jobOf(h: StudioHarness, id: string): StudioJob {
  const job = h.service.state().jobs.find((candidate) => candidate.id === id);
  if (job === undefined) throw new Error(`no job ${id}`);
  return job;
}

async function ok(h: StudioHarness, op: StudioOp): Promise<Omit<StudioResult, "rid">> {
  const result = await h.service.handle(op);
  if (!result.ok) throw new Error(`${op.kind} refused: ${result.error ?? "?"}`);
  return result;
}

/** A finished Codex image: its job and output. */
async function output(h: StudioHarness, spec: StudioSpec = imageSpec()): Promise<{ readonly job: StudioJob; readonly asset: StudioAsset }> {
  const { job } = await ok(h, { kind: "create", spec, origin: "desktop" });
  if (job === undefined) throw new Error("no job");
  const runs = h.runners[spec.backend].runs;
  runs.at(-1)?.succeed();
  await flush();
  const done = jobOf(h, job.id);
  const asset = done.outputs[0];
  if (asset === undefined) throw new Error(`job ${done.state}: ${done.error ?? "no output"}`);
  return { job: done, asset };
}

function filesOf(dir: string, id: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(id));
}

function kontextSpec(ref: string, over: Partial<StudioSpec> = {}): StudioSpec {
  return { mode: "image", backend: "kontext", prompt: "make it red", aspect: "9:16", resolution: "576x1024", refs: [ref], ...over };
}

describe("studio create", () => {
  it("queues count jobs in one batch with consecutive seeds, in its project and with its parent, kept across a restart", async () => {
    const h = harness();
    const parent = await output(h);
    const project = (await ok(h, { kind: "project.create", name: "Trip" })).project;
    if (project === undefined) throw new Error("no project");
    const result = await ok(h, {
      kind: "create",
      spec: ltxSpec(),
      origin: "desktop",
      count: 3,
      project: project.id,
      parent: { asset: parent.asset.id, how: "video" },
    });
    const jobs = result.jobs ?? [];
    expect(jobs.map((job) => job.seed)).toEqual([42, 43, 44]);
    expect(result.job?.id).toBe(jobs[0]?.id);
    const batch = jobs[0]?.batch?.id ?? "";
    expect(jobs.map((job) => job.batch)).toEqual([0, 1, 2].map((index) => ({ id: batch, index, count: 3 })));
    expect(jobs.map((job) => [job.project, job.parent])).toEqual(
      Array.from({ length: 3 }, () => [project.id, { asset: parent.asset.id, how: "video" }]),
    );
    expect(jobs.map((job) => job.state)).toEqual(["running", "queued", "queued"]);
    expect(h.runners.ltx.runs.map((run) => run.input.seed)).toEqual([42]);

    const single = await ok(h, { kind: "create", spec: imageSpec(), origin: "phone", project: STUDIO_UNSORTED });
    expect(single.jobs).toHaveLength(1);
    expect(single.job?.batch).toBeUndefined();
    expect(single.job?.project).toBeUndefined();

    h.service.stop();
    const again = harness(h.dir);
    const kept = again.service.state().jobs.filter((job) => job.batch?.id === batch);
    expect(kept.map((job) => [job.batch?.index, job.seed, job.project, job.parent?.how])).toEqual([
      [2, 44, project.id, "video"],
      [1, 43, project.id, "video"],
      [0, 42, project.id, "video"],
    ]);
    expect(again.service.state().projects).toEqual([project]);
  });

  it("refuses a gone project, a gone parent and more than one paid job at once", async () => {
    const h = harness();
    expect(await h.service.handle({ kind: "create", spec: imageSpec(), origin: "phone", project: "nope" })).toEqual({
      ok: false,
      error: "That project is gone; pick another",
    });
    expect(
      await h.service.handle({ kind: "create", spec: imageSpec(), origin: "phone", parent: { asset: "nope", how: "vary" } }),
    ).toEqual({ ok: false, error: "The image it was made from is gone" });
    expect(
      await h.service.handle({ kind: "create", spec: paidSpec({ confirmCredits: 10 }), origin: "phone", count: 2 }),
    ).toEqual({ ok: false, error: "Paid jobs run one at a time; make one" });
    expect(h.service.state().jobs).toEqual([]);
  });
});

describe("studio library ops", () => {
  it("favorites, moves, trashes and restores outputs within the undo window, telling every device", async () => {
    const h = harness();
    const { job, asset } = await output(h);
    const project = (await ok(h, { kind: "project.create", name: "Trip" })).project;
    if (project === undefined) throw new Error("no project");

    await ok(h, { kind: "favorite", assets: [asset.id], value: true });
    expect(jobOf(h, job.id).outputs[0]?.favorite).toBe(true);
    expect(h.sent.at(-1)).toMatchObject({ t: "studio.job", job: { id: job.id, outputs: [{ favorite: true }] } });
    await ok(h, { kind: "favorite", assets: [asset.id], value: false });
    expect(jobOf(h, job.id).outputs[0]?.favorite).toBeUndefined();

    await ok(h, { kind: "move", assets: [asset.id], project: project.id });
    expect(jobOf(h, job.id).project).toBe(project.id);
    expect(await h.service.handle({ kind: "move", assets: [asset.id], project: "nope" })).toEqual({
      ok: false,
      error: "That project is gone; pick another",
    });
    await ok(h, { kind: "move", assets: [asset.id], project: STUDIO_UNSORTED });
    expect(jobOf(h, job.id).project).toBeUndefined();

    const trashedAt = h.clock.now();
    await ok(h, { kind: "trash", assets: [asset.id] });
    expect(jobOf(h, job.id).outputs[0]?.deletedAt).toBe(trashedAt);
    expect(h.sent.at(-1)).toMatchObject({ t: "studio.job", job: { outputs: [{ deletedAt: trashedAt }] } });
    h.clock.advance(STUDIO_UNDO_MS - 1);
    await ok(h, { kind: "restore", assets: [asset.id] });
    expect(jobOf(h, job.id).outputs[0]?.deletedAt).toBeUndefined();
    h.clock.advance(2 * STUDIO_UNDO_MS);
    expect(filesOf(h.dir, asset.id)).toHaveLength(2);
    expect(jobOf(h, job.id).outputs).toHaveLength(1);

    expect(await h.service.handle({ kind: "favorite", assets: ["nope"], value: true })).toEqual({ ok: false, error: "That image is gone" });
  });

  it("deletes the project, not its images: they go to Unsorted; create, rename and delete reach every device", async () => {
    const h = harness();
    const { job, asset } = await output(h);
    const created = await ok(h, { kind: "project.create", name: " Trip " });
    const project = created.project;
    if (project === undefined) throw new Error("no project");
    expect(project.name).toBe("Trip");
    expect(h.sent.at(-1)).toEqual({ t: "studio.library", projects: [project], references: [] });
    expect(await h.service.handle({ kind: "project.create", name: "Again", id: project.id })).toEqual({
      ok: false,
      error: "That project already exists",
    });
    const renamed = (await ok(h, { kind: "project.rename", id: project.id, name: "Paris" })).project;
    expect(renamed).toEqual({ ...project, name: "Paris" });
    expect(h.sent.at(-1)).toEqual({ t: "studio.library", projects: [renamed], references: [] });
    await ok(h, { kind: "move", assets: [asset.id], project: project.id });

    await ok(h, { kind: "project.delete", id: project.id });
    expect(jobOf(h, job.id).project).toBeUndefined();
    expect(h.sent).toContainEqual({ t: "studio.job", job: jobOf(h, job.id) });
    expect(h.sent.at(-1)).toEqual({ t: "studio.library", projects: [], references: [] });
    expect(h.service.state().projects).toEqual([]);

    // An Undo brings it back under its own id.
    const back = (await ok(h, { kind: "project.create", name: "Paris", id: project.id })).project;
    expect(back?.id).toBe(project.id);
  });

  it("saves a reference as the host's own copy: it outlives the image it came from and works as a ref", async () => {
    const h = harness();
    const { job, asset } = await output(h);
    const reference = (await ok(h, { kind: "reference.create", asset: asset.id, referenceKind: "character", name: "Milo" })).reference;
    if (reference === undefined) throw new Error("no reference");
    expect(reference).toMatchObject({ kind: "character", name: "Milo", asset: { kind: "image", mimeType: "image/png" } });
    expect(reference.asset.id).not.toBe(asset.id);
    expect(h.sent.at(-1)).toEqual({ t: "studio.library", projects: [], references: [reference] });
    expect(h.service.state().references).toEqual([reference]);

    await ok(h, { kind: "delete", id: job.id });
    expect(filesOf(h.dir, asset.id)).toEqual([]);
    const token = reference.asset.path.split("/")[3] ?? "";
    expect(h.service.open(reference.asset.id, token)).toMatchObject({ mimeType: "image/png" });

    const edit = await ok(h, { kind: "create", spec: imageSpec({ backend: "codex-edit", refs: [reference.asset.id] }), origin: "desktop" });
    expect(edit.job?.state).toBe("running");
    expect(h.runners["codex-edit"].runs[0]?.input.refs).toEqual([join(h.dir, `${reference.asset.id}.png`)]);

    await ok(h, { kind: "reference.delete", id: reference.id });
    expect(filesOf(h.dir, reference.asset.id)).toEqual([]);
    expect(h.sent.at(-1)).toEqual({ t: "studio.library", projects: [], references: [] });
  });
});

/** A ComfyUI server on this "Mac": it keeps uploads in `input/` and saved images in `output/studio/` like the real one. */
interface ComfyServer {
  readonly fetch: Fetch;
  readonly inputDir: string;
  readonly outputDir: string;
}

function comfyServer(root: string, options: { readonly viewFails?: boolean } = {}): ComfyServer {
  const inputDir = join(root, "input");
  const outputDir = join(root, "output");
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(join(outputDir, "studio"), { recursive: true });
  let saved = 0;
  const fetch: Fetch = async (target, init) => {
    const url = new URL(target);
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
    if (url.pathname === "/object_info") return json({ LoadImage: { input: { required: {} } }, SaveImage: { input: { required: {} } } });
    if (url.pathname === "/upload/image" && init.body instanceof FormData) {
      const file = init.body.get("image");
      if (!(file instanceof File)) throw new Error("no image in the upload");
      writeFileSync(join(inputDir, file.name), new Uint8Array(await file.arrayBuffer()));
      return json({ name: file.name, subfolder: "", type: "input" });
    }
    if (url.pathname === "/prompt") {
      saved += 1;
      writeFileSync(join(outputDir, "studio", `angles_${String(saved).padStart(5, "0")}_.png`), PNG);
      return json({ prompt_id: `p${String(saved)}` });
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.slice("/history/".length);
      const filename = `angles_${id.slice(1).padStart(5, "0")}_.png`;
      return json({ [id]: { status: { completed: true, status_str: "success", messages: [] }, outputs: { "9": { images: [{ filename, subfolder: "studio", type: "output" }] } } } });
    }
    if (url.pathname === "/view") return new Response(options.viewFails === true ? "gone" : PNG, { status: options.viewFails === true ? 500 : 200 });
    return json({});
  };
  return { fetch, inputDir, outputDir };
}

function comfyRunner(server: ComfyServer): ComfyUIRunner {
  const presets = freshDir();
  mkdirSync(join(presets, "angles"));
  writeFileSync(
    join(presets, "angles", "preset.json"),
    JSON.stringify({ id: "angles", name: "Angles", mode: "image", refs: 1, resolutions: [{ id: "1mp", label: "1 MP", aspect: "1:1" }] }),
  );
  writeFileSync(
    join(presets, "angles", "workflow.json"),
    JSON.stringify({
      "1": { class_type: "LoadImage", inputs: { image: "{{image}}" } },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "studio/angles" } },
    }),
  );
  return new ComfyUIRunner(
    {
      backend: "comfyui",
      url: "http://comfy.test",
      presetsDir: presets,
      fetch: server.fetch,
      socket: () => ({ onmessage: null, close: () => undefined }),
      readFile: (path) => readFile(path),
      outputDir: server.outputDir,
      inputDir: server.inputDir,
    },
    1,
  );
}

const anglesSpec = (ref: string): StudioSpec => ({ mode: "image", backend: "comfyui", model: "angles", prompt: "Angles", aspect: "1:1", resolution: "1mp", refs: [ref] });

describe("studio trash", () => {
  it("deletes every copy once the undo window passes (store file, thumb, ComfyUI's output; its upload right after the run) and then refuses a restore", async () => {
    const server = comfyServer(freshDir());
    const h = harness(freshDir(), { comfyui: comfyRunner(server) });
    const source = await output(h);
    const { job } = await ok(h, { kind: "create", spec: anglesSpec(source.asset.id), origin: "desktop" });
    if (job === undefined) throw new Error("no job");
    await vi.waitFor(() => {
      expect(jobOf(h, job.id).state).toBe("done");
    });
    const asset = jobOf(h, job.id).outputs[0];
    if (asset === undefined) throw new Error("no output");
    const comfyCopy = join(server.outputDir, "studio", "angles_00001_.png");
    // The upload was only for the run; ComfyUI's saved output lives as long as the image.
    expect(readdirSync(server.inputDir)).toEqual([]);
    expect(existsSync(comfyCopy)).toBe(true);
    expect(filesOf(h.dir, asset.id).sort()).toEqual([`${asset.id}.png`, `${asset.id}.thumb.jpg`]);
    expect(h.lock.granted).toEqual([expect.stringContaining("(relay studio comfyui)")]);

    await ok(h, { kind: "trash", assets: [asset.id] });
    h.clock.advance(STUDIO_UNDO_MS - 1);
    expect(existsSync(comfyCopy)).toBe(true);
    expect(filesOf(h.dir, asset.id)).toHaveLength(2);

    h.clock.advance(1);
    expect(existsSync(comfyCopy)).toBe(false);
    expect(filesOf(h.dir, asset.id)).toEqual([]);
    expect(readdirSync(join(h.dir, "work")).filter((name) => name.includes(job.id))).toEqual([]);
    expect(h.service.state().jobs.map((candidate) => candidate.id)).toEqual([source.job.id]);
    expect(h.sent.at(-1)).toEqual({ t: "studio.removed", id: job.id });
    expect(readFileSync(join(h.dir, "index.json"), "utf8")).not.toContain(asset.id);
    expect(await h.service.handle({ kind: "restore", assets: [asset.id] })).toEqual({
      ok: false,
      error: "Too late to undo; the image is deleted",
    });
  });

  it("a failed ComfyUI run leaves no copy behind", async () => {
    const server = comfyServer(freshDir(), { viewFails: true });
    const h = harness(freshDir(), { comfyui: comfyRunner(server) });
    const source = await output(h);
    const { job } = await ok(h, { kind: "create", spec: anglesSpec(source.asset.id), origin: "desktop" });
    if (job === undefined) throw new Error("no job");
    await vi.waitFor(() => {
      expect(jobOf(h, job.id).state).toBe("failed");
    });
    expect(readdirSync(server.inputDir)).toEqual([]);
    expect(readdirSync(join(server.outputDir, "studio"))).toEqual([]);
  });

  it("keeps trash timestamps across a restart, and deletes on start what came due while the host was down", async () => {
    const h = harness();
    const copy = join(freshDir(), "backend-copy.png");
    writeFileSync(copy, PNG);
    const { job } = await ok(h, { kind: "create", spec: imageSpec(), origin: "desktop" });
    if (job === undefined) throw new Error("no job");
    h.runners["codex-image"].runs[0]?.succeed([copy]);
    await flush();
    const asset = jobOf(h, job.id).outputs[0];
    if (asset === undefined) throw new Error("no output");
    await ok(h, { kind: "trash", assets: [asset.id] });
    const trashedAt = jobOf(h, job.id).outputs[0]?.deletedAt;
    h.service.stop();

    const again = harness(h.dir);
    expect(jobOf(again, job.id).outputs[0]?.deletedAt).toBe(trashedAt);
    again.service.stop();

    // Backdate the trash past the window, as if the host had been down meanwhile.
    const path = join(h.dir, "index.json");
    writeFileSync(path, readFileSync(path, "utf8").replace(`"deletedAt":${String(trashedAt)}`, '"deletedAt":0'));
    const later = harness(h.dir);
    expect(later.service.state().jobs).toEqual([]);
    expect(later.sent).toContainEqual({ t: "studio.removed", id: job.id });
    expect(filesOf(h.dir, asset.id)).toEqual([]);
    expect(existsSync(copy)).toBe(false);
  });

  it("delete removes every copy at once, and a job cancelled mid-run keeps none", async () => {
    const h = harness();
    const copies = [join(freshDir(), "kept.png"), join(freshDir(), "cancelled.png")];
    for (const copy of copies) writeFileSync(copy, PNG);
    const { job } = await ok(h, { kind: "create", spec: imageSpec(), origin: "desktop" });
    if (job === undefined) throw new Error("no job");
    h.runners["codex-image"].runs[0]?.succeed([copies[0] ?? ""]);
    await flush();
    await ok(h, { kind: "delete", id: job.id });
    expect(existsSync(copies[0] ?? "")).toBe(false);

    const { job: cancelled } = await ok(h, { kind: "create", spec: imageSpec(), origin: "desktop" });
    if (cancelled === undefined) throw new Error("no job");
    await ok(h, { kind: "cancel", id: cancelled.id });
    h.runners["codex-image"].runs[1]?.succeed([copies[1] ?? ""]);
    await flush();
    expect(existsSync(copies[1] ?? "")).toBe(false);
    expect(jobOf(h, cancelled.id).outputs).toEqual([]);
  });
});

describe("studio segments", () => {
  it("segments an image once under the GPU lock, pushes each step, serves masks and cut-outs, and keeps the result", async () => {
    const h = harness();
    const { asset } = await output(h);
    const first = await ok(h, { kind: "segment", asset: asset.id });
    expect(first.segments).toEqual({ asset: asset.id, state: "running", segments: [] });
    expect(h.sent.flatMap((message) => (message.t === "studio.segments" ? [message.state] : []))).toEqual(["queued", "running"]);
    await flush();
    expect(h.lock.granted).toEqual([expect.stringContaining("(relay studio sam segments)")]);
    expect(h.segmenter.runs.map((run) => run.image)).toEqual([join(h.dir, `${asset.id}.png`)]);
    h.segmenter.runs[0]?.finish();
    await flush();
    const done = h.sent.at(-1);
    if (done?.t !== "studio.segments") throw new Error(`expected studio.segments, got ${String(done?.t)}`);
    expect(done).toMatchObject({ asset: asset.id, state: "done" });
    expect(done.segments.map((segment) => [segment.label, segment.box, segment.area])).toEqual([
      ["Object 1", [0.1, 0.2, 0.5, 0.6], 0.3],
      ["Background", [0, 0, 1, 1], 0.7],
    ]);
    const segment = done.segments[0];
    if (segment === undefined) throw new Error("no segment");
    const [, , id, token] = segment.mask.split("/");
    expect(id).toBe(segment.id);
    expect(segment.thumb).toBe(`${segment.mask}/thumb`);
    expect(h.service.open(segment.id, token ?? "")).toMatchObject({ mimeType: "image/png", path: join(h.dir, `${segment.id}.mask.png`) });
    expect(h.service.openThumb(segment.id, token ?? "")).toMatchObject({ mimeType: "image/png", path: join(h.dir, `${segment.id}.cutout.png`) });
    expect(h.service.open(segment.id, "0".repeat(64))).toBeNull();
    expect(h.lock.held).toBe(0);

    expect((await ok(h, { kind: "segment", asset: asset.id })).segments).toEqual({ asset: asset.id, state: "done", segments: done.segments });
    expect(h.segmenter.runs).toHaveLength(1);
    h.service.stop();
    const again = harness(h.dir);
    expect((await ok(again, { kind: "segment", asset: asset.id })).segments?.segments).toEqual(done.segments);
    expect(again.segmenter.runs).toEqual([]);
  });

  it("reports a failed run and runs again when asked; the segments go with their image", async () => {
    const h = harness();
    const { job, asset } = await output(h);
    await ok(h, { kind: "segment", asset: asset.id });
    await flush();
    h.segmenter.runs[0]?.fail("SAM 2.1 ran out of memory");
    await flush();
    expect(h.sent.at(-1)).toEqual({ t: "studio.segments", asset: asset.id, state: "failed", segments: [], error: "SAM 2.1 ran out of memory" });
    expect((await ok(h, { kind: "segment", asset: asset.id })).segments?.state).toBe("running");
    await flush();
    h.segmenter.runs[1]?.finish();
    await flush();
    const ids = h.sent.flatMap((message) => (message.t === "studio.segments" && message.state === "done" ? message.segments.map((segment) => segment.id) : []));
    expect(ids).toHaveLength(2);
    await ok(h, { kind: "delete", id: job.id });
    for (const id of ids) expect(filesOf(h.dir, id)).toEqual([]);
    expect(await h.service.handle({ kind: "segment", asset: asset.id })).toEqual({ ok: false, error: "No such image" });
  });

  it("a masked edit runs on the whole image, then keeps the edit inside the selected object; a cutout takes the mask itself", async () => {
    const h = harness();
    const { asset } = await output(h);
    const other = await output(h);
    await ok(h, { kind: "segment", asset: asset.id });
    await flush();
    h.segmenter.runs[0]?.finish();
    await flush();
    const mask = h.sent.flatMap((message) => (message.t === "studio.segments" && message.state === "done" ? message.segments : []))[0];
    if (mask === undefined) throw new Error("no segment");
    const maskPath = join(h.dir, `${mask.id}.mask.png`);

    expect(await h.service.handle({ kind: "create", spec: kontextSpec(other.asset.id, { mask: mask.id }), origin: "desktop" })).toEqual({
      ok: false,
      error: "The selected object belongs to another image",
    });
    expect(await h.service.handle({ kind: "create", spec: kontextSpec(asset.id, { mask: "nope" }), origin: "desktop" })).toEqual({
      ok: false,
      error: "The selected object is gone; pick it again",
    });

    const { job } = await ok(h, { kind: "create", spec: kontextSpec(asset.id, { mask: mask.id }), origin: "desktop", parent: { asset: asset.id, how: "edit" } });
    if (job === undefined) throw new Error("no job");
    await flush();
    const run = h.runners.kontext.runs[0];
    expect(run?.input.mask).toBe(maskPath);
    run?.succeed();
    await flush();
    expect(h.media.compositeCalls).toEqual([
      { source: join(h.dir, `${asset.id}.png`), edited: join(run?.input.workDir ?? "", "out.png"), mask: maskPath, out: join(run?.input.workDir ?? "", "masked.png") },
    ]);
    expect(jobOf(h, job.id)).toMatchObject({ state: "done", outputs: [{ mimeType: "image/png" }], parent: { asset: asset.id, how: "edit" } });

    const cutout = await ok(h, {
      kind: "create",
      spec: { mode: "image", backend: "sam", model: "cutout", prompt: "Remove background", aspect: "9:16", resolution: "source", refs: [asset.id], mask: mask.id },
      origin: "desktop",
    });
    await flush();
    expect(h.runners.sam.runs[0]?.input.mask).toBe(maskPath);
    h.runners.sam.runs[0]?.succeed();
    await flush();
    expect(jobOf(h, cutout.job?.id ?? "").state).toBe("done");
    expect(h.media.compositeCalls).toHaveLength(1);
  });
});

describe("studio GPU lock", () => {
  it("holds it for LTX, Kontext, ComfyUI and SAM one at a time, waits with the busy note while another process has it, leaves it to MOSS's own script", async () => {
    const h = harness();
    const { asset } = await output(h);
    h.lock.holdElsewhere();
    const { job: edit } = await ok(h, { kind: "create", spec: kontextSpec(asset.id), origin: "desktop" });
    if (edit === undefined) throw new Error("no job");
    await flush();
    expect(h.runners.kontext.runs).toEqual([]);
    expect(jobOf(h, edit.id)).toMatchObject({ state: "running", progress: 0, note: GPU_BUSY_NOTE });
    h.lock.freeElsewhere();
    await flush();
    expect(h.runners.kontext.runs).toHaveLength(1);
    expect(jobOf(h, edit.id).note).toBeUndefined();
    expect(h.lock.granted).toEqual([expect.stringContaining("(relay studio kontext)")]);

    // LTX waits its turn in the GPU pool and takes the lock itself; MOSS takes it in its own script.
    const { job: video } = await ok(h, { kind: "create", spec: ltxSpec(), origin: "desktop" });
    const { job: image } = await ok(h, {
      kind: "create",
      spec: { mode: "image", backend: "moss", model: "moss-image", prompt: "a lamp", aspect: "9:16", resolution: "768x1344" },
      origin: "desktop",
    });
    expect(video?.state).toBe("queued");
    h.runners.kontext.runs[0]?.succeed();
    await flush();
    expect(h.runners.ltx.runs).toHaveLength(1);
    expect(h.lock.granted.at(-1)).toContain("(relay studio ltx)");
    h.runners.ltx.runs[0]?.succeed();
    await flush();
    expect(h.runners.moss.runs).toHaveLength(1);
    h.runners.moss.runs[0]?.succeed();
    await flush();
    expect(jobOf(h, image?.id ?? "").state).toBe("done");
    expect(h.lock.granted).toHaveLength(2);

    // With the GPU busy (LTX again), a segment run asked after a ComfyUI job still goes first: it takes seconds.
    await ok(h, { kind: "create", spec: ltxSpec(), origin: "desktop" });
    await ok(h, { kind: "create", spec: anglesSpec(asset.id), origin: "desktop" });
    expect((await ok(h, { kind: "segment", asset: asset.id })).segments?.state).toBe("queued");
    h.runners.ltx.runs[1]?.succeed();
    await flush();
    expect(h.lock.granted.at(-1)).toContain("(relay studio sam segments)");
    expect(h.runners.comfyui.runs).toEqual([]);
    h.segmenter.runs[0]?.finish();
    await flush();
    expect(h.lock.granted.at(-1)).toContain("(relay studio comfyui)");
    expect(h.runners.comfyui.runs).toHaveLength(1);
    expect(h.lock.maxHeld).toBe(1);
  });

  it("takes the real lock file like draft.py: a second taker waits, says so, and gets it on release; a cancel gives up the wait", async () => {
    const path = join(freshDir(), "cache", "eva-gpu.lock");
    const lock = new FlockGpuLock(path);
    const said: boolean[] = [];
    const first = await lock.acquire({ holder: "pid 1 (first)", signal: new AbortController().signal, waiting: (waiting) => said.push(waiting) });
    expect(readFileSync(path, "utf8")).toBe("pid 1 (first)");
    const second = lock.acquire({ holder: "pid 2 (second)", signal: new AbortController().signal, waiting: (waiting) => said.push(waiting) });
    await vi.waitFor(() => {
      expect(said).toEqual([true]);
    });
    await first();
    const release = await second;
    expect(said).toEqual([true, false]);
    expect(readFileSync(path, "utf8")).toBe("pid 2 (second)");

    const controller = new AbortController();
    const waiting: boolean[] = [];
    const third = lock.acquire({ holder: "pid 3", signal: controller.signal, waiting: (value) => waiting.push(value) });
    await vi.waitFor(() => {
      expect(waiting).toEqual([true]);
    });
    controller.abort();
    await expect(third).rejects.toThrow("Cancelled");
    await release();
    const again = await lock.acquire({ holder: "pid 4", signal: new AbortController().signal, waiting: () => undefined });
    await again();
  });
});

describe("studio index migration", () => {
  it("reads a v1 index: every job Unsorted, no projects, references or segments; writes v2", () => {
    const dir = freshDir();
    const token = "a".repeat(64);
    const asset: StudioAsset = {
      id: "out1",
      kind: "image",
      mimeType: "image/png",
      width: 100,
      height: 200,
      size: PNG.length,
      path: `/studio/out1/${token}`,
      thumb: `/studio/out1/${token}/thumb`,
      origin: "output",
      createdAt: 5,
    };
    const job: StudioJob = { id: "j1", spec: imageSpec(), state: "done", origin: "phone", createdAt: 1, progress: 1, outputs: [asset] };
    writeFileSync(join(dir, "out1.png"), PNG);
    writeFileSync(join(dir, "index.json"), JSON.stringify({ jobs: [job], uploads: [], files: { out1: { token, file: "out1.png" } }, calibration: {} }));
    const h = harness(dir);
    const state = h.service.state();
    expect(state.jobs).toEqual([job]);
    expect(state.jobs[0]?.project).toBeUndefined();
    expect(state.projects).toEqual([]);
    expect(state.references).toEqual([]);
    expect(h.service.open("out1", token)).toMatchObject({ mimeType: "image/png" });
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))).toMatchObject({ version: 2, projects: [], references: [], segments: {} });
  });
});
