import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STUDIO_JOBS, MAX_STUDIO_UPLOADS, type StudioAsset, type StudioJob, type StudioSpec } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BACKEND_BASE, baseEstimateMs, ltxFrames, ltxGenerationSize, validateSpec } from "../src/studio/backends";
import { handleStudioRequest } from "../src/studio/http";
import { GPU_NOTE, STUDIO_TICK_MS, type StudioService } from "../src/studio/service";
import { RESTART_ERROR, StudioStore, type StudioStoreOptions } from "../src/studio/store";
import { fakeMedia, flush, imageSpec, ltxSpec, paidSpec, PNG, studioHarness, type StudioHarness } from "./studio-fakes";

const dirs: string[] = [];
const harnesses: StudioHarness[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-studio-"));
  dirs.push(dir);
  return dir;
}

function harness(dir = freshDir()): StudioHarness {
  const h = studioHarness(dir);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.service.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function create(service: StudioService, spec: StudioSpec): Promise<StudioJob> {
  const result = await service.handle({ kind: "create", spec, origin: "phone" });
  if (result.job === undefined) throw new Error(`create refused: ${result.error ?? "?"}`);
  return result.job;
}

async function upload(service: StudioService): Promise<StudioAsset> {
  const result = await service.handle({ kind: "upload", image: { mimeType: "image/png", data: Buffer.from(PNG).toString("base64") } });
  if (result.asset === undefined) throw new Error(`upload refused: ${result.error ?? "?"}`);
  return result.asset;
}

function jobOf(h: StudioHarness, id: string): StudioJob {
  const job = h.service.state().jobs.find((candidate) => candidate.id === id);
  if (job === undefined) throw new Error(`no job ${id}`);
  return job;
}

function lastJobFrame(h: StudioHarness, id: string): StudioJob | undefined {
  const frames = h.sent.flatMap((message) => (message.t === "studio.job" && message.job.id === id ? [message.job] : []));
  return frames.at(-1);
}

/** The token and file name of an asset path `/studio/<id>/<token>`. */
function tokenOf(asset: StudioAsset): string {
  return asset.path.split("/")[3] ?? "";
}

describe("studio queue", () => {
  it("runs LTX jobs one at a time, first in first out; the waiting job says so with an ETA through the job ahead", async () => {
    const h = harness();
    const first = await create(h.service, ltxSpec());
    const second = await create(h.service, ltxSpec({ prompt: "a hen in rain" }));
    expect(first.state).toBe("running");
    expect(first.seed).toBe(42);
    expect(second.state).toBe("queued");
    const estimate = baseEstimateMs(ltxSpec());
    const waiting = jobOf(h, second.id);
    expect(waiting.note).toBe(GPU_NOTE);
    expect(waiting.etaMs).toBeCloseTo(2 * estimate, 0);
    expect(h.runners.ltx.runs).toHaveLength(1);
    expect(h.runners.ltx.runs[0]?.input.seed).toBe(42);
    expect(existsSync(h.runners.ltx.runs[0]?.input.workDir ?? "")).toBe(true);

    h.runners.ltx.runs[0]?.succeed();
    await flush();
    const done = jobOf(h, first.id);
    expect(done.state).toBe("done");
    expect(done.progress).toBe(1);
    expect(done.etaMs).toBeUndefined();
    expect(done.outputs).toEqual([expect.objectContaining({ kind: "video", mimeType: "video/mp4", width: 480, height: 848, durationMs: 5000, origin: "output" })]);
    expect(h.runners.ltx.runs).toHaveLength(2);
    expect(h.runners.ltx.runs[1]?.input.spec.prompt).toBe("a hen in rain");
    const started = jobOf(h, second.id);
    expect(started.state).toBe("running");
    expect(started.note).toBeUndefined();
  });

  it("runs up to three Codex jobs at once across both Codex backends, and two Higgsfield jobs", async () => {
    const h = harness();
    const ref = await upload(h.service);
    for (let i = 0; i < 3; i++) await create(h.service, imageSpec({ prompt: `kite ${String(i)}` }));
    const edit = await create(h.service, imageSpec({ backend: "codex-edit", refs: [ref.id] }));
    expect(h.runners["codex-image"].runs).toHaveLength(3);
    expect(edit.state).toBe("queued");
    expect(jobOf(h, edit.id).note).toBe("Waiting for a free slot");
    h.runners["codex-image"].runs[1]?.succeed();
    await flush();
    expect(jobOf(h, edit.id).state).toBe("running");
    expect(h.runners["codex-edit"].runs[0]?.input.refs).toEqual([join(h.dir, `${ref.id}.png`)]);

    for (let i = 0; i < 3; i++) await create(h.service, paidSpec({ confirmCredits: 10 }));
    expect(h.runners.higgsfield.runs).toHaveLength(2);
    expect(h.service.state().jobs.filter((job) => job.spec.backend === "higgsfield" && job.state === "queued")).toHaveLength(1);
  });

  it("ticks progress and ETA every 2 s from the estimate, short of done, and learns from how long jobs took", async () => {
    const h = harness();
    const spec = ltxSpec();
    const estimate = baseEstimateMs(spec);
    const job = await create(h.service, spec);
    expect(job.etaMs).toBeCloseTo(estimate, 0);
    h.clock.advance(STUDIO_TICK_MS);
    expect(lastJobFrame(h, job.id)).toMatchObject({ state: "running", progress: STUDIO_TICK_MS / estimate, etaMs: estimate - STUDIO_TICK_MS });
    h.clock.advance(2 * estimate - STUDIO_TICK_MS);
    expect(lastJobFrame(h, job.id)).toMatchObject({ progress: 0.97, etaMs: 0 });
    h.runners.ltx.runs[0]?.succeed();
    await flush();
    // Took twice the estimate: the next one is expected to take 1 + 0.3 * (2 - 1) times as long.
    const next = await create(h.service, spec);
    expect(next.etaMs).toBeCloseTo(1.3 * estimate, 0);
  });

  it("cancels a queued job at once and a running one through its runner's signal; the GPU frees when the runner stops", async () => {
    const h = harness();
    const a = await create(h.service, ltxSpec({ prompt: "a" }));
    const b = await create(h.service, ltxSpec({ prompt: "b" }));
    const c = await create(h.service, ltxSpec({ prompt: "c" }));

    const cancelledB = await h.service.handle({ kind: "cancel", id: b.id });
    expect(cancelledB).toMatchObject({ ok: true, job: { id: b.id, state: "cancelled" } });
    expect(jobOf(h, b.id).note).toBeUndefined();
    expect(jobOf(h, c.id).state).toBe("queued");

    const run = h.runners.ltx.runs[0];
    expect(await h.service.handle({ kind: "cancel", id: a.id })).toMatchObject({ ok: true, job: { state: "cancelled" } });
    expect(run?.input.signal.aborted).toBe(true);
    expect(jobOf(h, c.id).state).toBe("queued");
    run?.fail("Cancelled");
    await flush();
    expect(jobOf(h, a.id).state).toBe("cancelled");
    expect(jobOf(h, a.id).error).toBeUndefined();
    expect(jobOf(h, c.id).state).toBe("running");
    expect(await h.service.handle({ kind: "cancel", id: a.id })).toEqual({ ok: false, error: "The job already ended" });
  });

  it("fails a job with the runner's reason", async () => {
    const h = harness();
    const job = await create(h.service, imageSpec());
    h.runners["codex-image"].runs[0]?.fail("Codex refused (HTTP 400):\n  safety system");
    await flush();
    expect(jobOf(h, job.id)).toMatchObject({ state: "failed", error: "Codex refused (HTTP 400): safety system" });
  });

  it("deletes finished jobs and uploads with their files, and refuses active jobs", async () => {
    const h = harness();
    const ref = await upload(h.service);
    expect(ref).toMatchObject({ kind: "image", mimeType: "image/png", width: 100, height: 200, origin: "upload" });
    expect(ref.durationMs).toBeUndefined();
    expect(ref.path).toMatch(new RegExp(`^/studio/${ref.id}/[0-9a-f]{64}$`));
    expect(ref.thumb).toBe(`${ref.path}/thumb`);
    expect(h.sent.at(-1)).toMatchObject({ t: "studio.state", uploads: [{ id: ref.id }] });
    expect(existsSync(join(h.dir, `${ref.id}.png`))).toBe(true);
    expect(existsSync(join(h.dir, `${ref.id}.thumb.jpg`))).toBe(true);

    const job = await create(h.service, imageSpec());
    expect(await h.service.handle({ kind: "delete", id: job.id })).toEqual({ ok: false, error: "Cancel the job before deleting it" });
    h.runners["codex-image"].runs[0]?.succeed();
    await flush();
    const output = jobOf(h, job.id).outputs[0];
    expect(output).toMatchObject({ kind: "image", mimeType: "image/png" });
    const outputFile = join(h.dir, `${output?.id ?? ""}.png`);
    expect(existsSync(outputFile)).toBe(true);

    expect(await h.service.handle({ kind: "delete", id: job.id })).toEqual({ ok: true });
    expect(h.sent.at(-1)).toEqual({ t: "studio.removed", id: job.id });
    expect(existsSync(outputFile)).toBe(false);
    expect(h.service.state().jobs).toEqual([]);

    expect(await h.service.handle({ kind: "delete", id: ref.id })).toEqual({ ok: true });
    expect(h.sent).toContainEqual({ t: "studio.removed", id: ref.id });
    expect(existsSync(join(h.dir, `${ref.id}.png`))).toBe(false);
    expect(existsSync(join(h.dir, `${ref.id}.thumb.jpg`))).toBe(false);
    expect(h.service.state().uploads).toEqual([]);
    expect(await h.service.handle({ kind: "delete", id: ref.id })).toEqual({ ok: false, error: "No such job or upload" });
  });

  it("after a restart fails the jobs that were running and runs the queued ones again", async () => {
    const h = harness();
    const running = await create(h.service, ltxSpec({ prompt: "first" }));
    const queued = await create(h.service, ltxSpec({ prompt: "second" }));
    h.service.stop();

    const again = harness(h.dir);
    expect(jobOf(again, running.id)).toMatchObject({ state: "failed", error: RESTART_ERROR });
    expect(jobOf(again, running.id).etaMs).toBeUndefined();
    expect(jobOf(again, queued.id).state).toBe("running");
    expect(again.runners.ltx.runs.map((run) => run.input.spec.prompt)).toEqual(["second"]);
  });

  it("grabs a video's last frame (and copies an image) as a new upload", async () => {
    const h = harness();
    const job = await create(h.service, ltxSpec());
    h.runners.ltx.runs[0]?.succeed();
    await flush();
    const video = jobOf(h, job.id).outputs[0];
    if (video === undefined) throw new Error("no output");
    const frame = await h.service.handle({ kind: "frame", asset: video.id, at: "last" });
    expect(frame).toMatchObject({ ok: true, asset: { kind: "image", mimeType: "image/png", origin: "upload" } });
    expect(h.media.frameCalls).toEqual([{ src: join(h.dir, `${video.id}.mp4`), at: "last" }]);
    const copy = await h.service.handle({ kind: "frame", asset: frame.asset?.id ?? "", at: "first" });
    expect(copy.asset?.id).not.toBe(frame.asset?.id);
    expect(h.service.state().uploads.map((asset) => asset.id)).toEqual([copy.asset?.id, frame.asset?.id]);
    expect(await h.service.handle({ kind: "frame", asset: "nope", at: "first" })).toEqual({ ok: false, error: "No such image or video" });
  });

  it("serves files and thumbs only to the right token, with ranges", async () => {
    const h = harness();
    const asset = await upload(h.service);
    const token = tokenOf(asset);
    const get = (path: string, init?: RequestInit): Response => handleStudioRequest(h.service, new Request(`http://host${path}`, init), path);

    const whole = get(asset.path);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("image/png");
    expect(whole.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(PNG);
    const thumb = get(asset.thumb);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    const ranged = get(asset.path, { headers: { range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(PNG.slice(0, 4));
    expect(get(asset.path, { method: "HEAD" }).status).toBe(200);

    expect(get(`/studio/${asset.id}/${"0".repeat(64)}`).status).toBe(404);
    expect(get(`/studio/${asset.id}/${token.slice(0, 10)}`).status).toBe(404);
    expect(get(`/studio/${asset.id}/${token}/poster`).status).toBe(404);
    expect(get(`/studio/${asset.id}/${token}/thumb/x`).status).toBe(404);
    expect(get(asset.path, { method: "POST", body: "x" }).status).toBe(405);
    expect(handleStudioRequest(null, new Request(`http://host${asset.path}`), asset.path).status).toBe(404);
  });
});

describe("studio paid jobs", () => {
  it("refuses agents, jobs without a confirmed price, and a price that rose; charges the confirmed quote", async () => {
    const h = harness();
    expect(await h.service.handle({ kind: "create", spec: paidSpec({ confirmCredits: 50 }), origin: "agent" })).toEqual({
      ok: false,
      error: "Paid jobs need Isaac's confirm tap in Studio",
    });
    expect(await h.service.handle({ kind: "create", spec: paidSpec(), origin: "phone" })).toEqual({ ok: false, error: "Paid jobs need a confirmed price; get a quote and confirm it" });
    expect(h.runners.higgsfield.quotes).toEqual([]);

    h.runners.higgsfield.price = 12;
    expect(await h.service.handle({ kind: "create", spec: paidSpec({ confirmCredits: 10 }), origin: "desktop" })).toEqual({
      ok: false,
      error: "The price changed to 12 credits; confirm again",
    });
    expect(h.runners.higgsfield.runs).toEqual([]);

    expect(await h.service.handle({ kind: "quote", spec: paidSpec() })).toEqual({ ok: true, credits: 12, balance: 100 });
    const created = await h.service.handle({ kind: "create", spec: paidSpec({ confirmCredits: 12 }), origin: "phone" });
    expect(created).toMatchObject({ ok: true, job: { credits: 12, state: "running" } });
    expect(created.job?.seed).toBeUndefined();

    h.runners.higgsfield.credits = 88;
    h.runners.higgsfield.runs[0]?.succeed();
    await flush();
    const state = h.sent.filter((message) => message.t === "studio.state").at(-1);
    expect(state?.t === "studio.state" ? state.backends.find((backend) => backend.id === "higgsfield")?.balance : null).toBe(88);
  });

  it("quotes free backends at zero", async () => {
    const h = harness();
    expect(await h.service.handle({ kind: "quote", spec: ltxSpec() })).toEqual({ ok: true, credits: 0 });
  });

  it("refuses a backend that is unavailable, with its reason", async () => {
    const h = harness();
    await flush(); // a refresh while the first read runs joins it
    h.runners.ltx.backend = { ...BACKEND_BASE.ltx, reason: "LTX is not set up on this host" };
    await h.service.handle({ kind: "refresh" });
    const state = h.sent.at(-1);
    expect(state?.t === "studio.state" ? state.backends.find((backend) => backend.id === "ltx")?.available : null).toBe(false);
    expect(await h.service.handle({ kind: "create", spec: ltxSpec(), origin: "phone" })).toEqual({
      ok: false,
      error: "Local video (LTX, free) is unavailable: LTX is not set up on this host",
    });
  });
});

describe("studio spec checks", () => {
  const ltx = { ...BACKEND_BASE.ltx, available: true };
  const edit = { ...BACKEND_BASE["codex-edit"], available: true };
  const image: StudioAsset = { id: "img", kind: "image", mimeType: "image/png", width: 1, height: 1, size: 1, path: "/p", thumb: "/p/thumb", origin: "upload", createdAt: 0 };
  const clip: StudioAsset = { ...image, id: "clip", kind: "video", mimeType: "video/mp4" };
  const lookup = (id: string): StudioAsset | undefined => [image, clip].find((asset) => asset.id === id);

  it("accepts what the backend offers", () => {
    expect(validateSpec(ltxSpec(), ltx, lookup)).toBeNull();
    expect(validateSpec(ltxSpec({ frames: { start: "img", mid: "img", end: "img" } }), ltx, lookup)).toBeNull();
    expect(validateSpec(imageSpec({ backend: "codex-edit", refs: ["img"] }), edit, lookup)).toBeNull();
  });

  it("refuses in one line what it doesn't", () => {
    expect(validateSpec(imageSpec({ backend: "ltx" }), ltx, lookup)).toBe("Local video (LTX, free) makes videos");
    expect(validateSpec(ltxSpec({ resolution: "1088x1920" }), ltx, lookup)).toBe("Local video (LTX, free) has no 1088x1920 at 9:16");
    expect(validateSpec(ltxSpec({ aspect: "16:9" }), ltx, lookup)).toBe("Local video (LTX, free) has no 480x848 at 16:9");
    expect(validateSpec(ltxSpec({ seconds: 7 }), ltx, lookup)).toBe("Local video (LTX, free) makes clips of 2, 3, 4, 5, 6, 8 s");
    expect(validateSpec(ltxSpec({ frames: { start: "img" } }), ltx, lookup)).toBe("LTX needs both a start and an end frame, or neither");
    expect(validateSpec(ltxSpec({ frames: { mid: "img" } }), ltx, lookup)).toBe("A mid frame needs a start and an end frame");
    expect(validateSpec(ltxSpec({ frames: { start: "img", end: "gone" } }), ltx, lookup)).toBe("A frame or reference image is gone; pick it again");
    expect(validateSpec(ltxSpec({ frames: { start: "img", end: "clip" } }), ltx, lookup)).toBe("Frames and reference images must be images");
    expect(validateSpec(ltxSpec({ refs: ["img"] }), ltx, lookup)).toBe("Local video (LTX, free) takes no reference images");
    expect(validateSpec(imageSpec({ backend: "codex-edit" }), edit, lookup)).toBe("Add a reference image to edit");
    const higgsfield = { ...BACKEND_BASE.higgsfield, available: true, models: [{ id: "veo", name: "Veo", mode: "video" as const, resolutions: [{ id: "default", label: "Standard", aspect: "16:9" as const }], seconds: [4], frames: ["start" as const] }] };
    expect(validateSpec(paidSpec({ model: undefined }), higgsfield, lookup)).toBe("Pick a model");
    expect(validateSpec(paidSpec({ model: "veo", aspect: "16:9", resolution: "default", seconds: 4, frames: { end: "img" } }), higgsfield, lookup)).toBe("Veo takes no end frame");
  });

  it("estimates LTX like draft.py renders it: 8k+1 frames on the 64-px grid", () => {
    expect(ltxFrames(5)).toBe(121);
    expect(ltxFrames(2)).toBe(49);
    // draft.py's generation_size gives these (checked against it).
    expect(ltxGenerationSize(480, 848)).toEqual([512, 896]);
    expect(ltxGenerationSize(384, 672)).toEqual([320, 576]);
    expect(ltxGenerationSize(848, 480)).toEqual([896, 512]);
    expect(baseEstimateMs(ltxSpec())).toBeCloseTo(210_000, 0);
    expect(baseEstimateMs(ltxSpec({ resolution: "576x1024", seconds: 8 }))).toBeGreaterThan(baseEstimateMs(ltxSpec()));
  });
});

describe("studio store", () => {
  const options = (): StudioStoreOptions => ({ now: () => 5, media: fakeMedia() });

  it("evicts the oldest finished job (and its files) past MAX_STUDIO_JOBS, never an active one", async () => {
    const dir = freshDir();
    const store = new StudioStore(dir, options());
    const base: StudioJob = { id: "x", spec: imageSpec(), state: "done", origin: "phone", createdAt: 0, progress: 1, outputs: [] };
    store.putJob({ ...base, id: "waiting", state: "queued", progress: 0 });
    const output = await store.ingest({ bytes: PNG }, "image/png", "output");
    store.putJob({ ...base, id: "oldest-done", outputs: [output] });
    for (let i = 0; i < MAX_STUDIO_JOBS - 2; i++) store.putJob({ ...base, id: `done-${String(i)}` });
    expect(store.jobs).toHaveLength(MAX_STUDIO_JOBS);
    expect(store.putJob({ ...base, id: "newest" })).toEqual(["oldest-done"]);
    expect(store.jobs).toHaveLength(MAX_STUDIO_JOBS);
    expect(store.job("waiting")).toBeDefined();
    expect(existsSync(join(dir, `${output.id}.png`))).toBe(false);
    expect(new StudioStore(dir, options()).jobs).toHaveLength(MAX_STUDIO_JOBS);
  });

  it("evicts the oldest upload past MAX_STUDIO_UPLOADS", async () => {
    const dir = freshDir();
    const store = new StudioStore(dir, options());
    const first = await store.ingest({ bytes: PNG }, "image/png", "upload");
    store.addUpload(first);
    for (let i = 1; i < MAX_STUDIO_UPLOADS; i++) store.addUpload(await store.ingest({ bytes: PNG }, "image/png", "upload"));
    expect(store.addUpload(await store.ingest({ bytes: PNG }, "image/png", "upload"))).toEqual([first.id]);
    expect(store.uploads).toHaveLength(MAX_STUDIO_UPLOADS);
    expect(existsSync(join(dir, `${first.id}.png`))).toBe(false);
    expect(existsSync(join(dir, `${first.id}.thumb.jpg`))).toBe(false);
  });

  it("prunes files nothing holds on start, and refuses a file it can't read without a fallback size", async () => {
    const dir = freshDir();
    const store = new StudioStore(dir, options());
    const orphan = await store.ingest({ bytes: PNG }, "image/png", "output");
    store.putJob({ id: "j", spec: imageSpec(), state: "queued", origin: "phone", createdAt: 0, progress: 0, outputs: [] });
    expect(existsSync(join(dir, `${orphan.id}.png`))).toBe(true);
    new StudioStore(dir, options());
    expect(existsSync(join(dir, `${orphan.id}.png`))).toBe(false);

    const blind = new StudioStore(dir, { now: () => 5, media: { ...fakeMedia(), probe: () => Promise.resolve({}) } });
    await expect(blind.ingest({ bytes: PNG }, "image/png", "upload")).rejects.toThrow("Could not read the image");
    expect(await blind.ingest({ bytes: PNG }, "image/png", "output", { width: 1088, height: 1920 })).toMatchObject({ width: 1088, height: 1920 });
  });
});
