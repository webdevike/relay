import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StudioSpec } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { chatgptAccountId, CODEX_IMAGE_MODEL, codexImageRequest, CodexRunner, type Fetch } from "../src/studio/codex";
import {
  curatedModels,
  curlHeaders,
  HIGGSFIELD_MCP_URL,
  HIGGSFIELD_MODELS,
  HIGGSFIELD_SIGNIN_EXPIRED,
  higgsfieldParams,
  HiggsfieldRunner,
  type HiggsfieldModel,
  rpcReply,
  studioModel,
} from "../src/studio/higgsfield";
import { findTool } from "../src/drops/video";
import { ltxArgv, LtxRunner, runProcessGroup } from "../src/studio/ltx";
import { ffmpegMedia } from "../src/studio/media";
import type { StudioRunInput } from "../src/studio/runner";
import { fakeMedia, imageSpec, JPEG, ltxSpec, MP4, paidSpec, PNG } from "./studio-fakes";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-studio-run-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runInput(spec: StudioSpec, over: Partial<StudioRunInput> = {}): StudioRunInput & { notes: string[] } {
  const notes: string[] = [];
  return {
    spec,
    frames: {},
    refs: [],
    workDir: freshDir(),
    signal: new AbortController().signal,
    note: (text) => notes.push(text),
    notes,
    ...over,
  };
}

// The process-group tests run real processes: nothing signals when a shell has written its pid
// file or when a reparented grandchild is finally reaped, so these two poll real time briefly.

/** Polls until `pid` is gone (a killed child can linger a moment as a zombie of its new parent). */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setTimeout(() => {
      resolve(undefined);
    }, 20);
    await promise;
  }
  return false;
}

/** A shell script in a temp dir that starts `sleep 30` in the background, writes both pids, and waits. */
function sleeperScript(prefix = ""): { readonly script: string; readonly pids: () => number[] } {
  const dir = freshDir();
  const script = join(dir, "sleeper.sh");
  writeFileSync(script, `${prefix}\necho $$ > "${dir}/pids"\nsleep 30 &\necho $! >> "${dir}/pids"\nwait\n`);
  return {
    script,
    pids: () => {
      const path = join(dir, "pids");
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter((line) => line !== "").map(Number) : [];
    },
  };
}

async function untilPids(pids: () => number[], count: number): Promise<number[]> {
  for (let i = 0; i < 200; i++) {
    const found = pids();
    if (found.length >= count) return found;
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setTimeout(() => {
      resolve(undefined);
    }, 10);
    await promise;
  }
  throw new Error("the script never started its sleep");
}

describe("LTX runner", () => {
  it("builds draft.py's argv: prompt, length, size, seed, out, then keyframes with the mid one halfway", () => {
    expect(ltxArgv("/py", "/draft.py", { spec: ltxSpec(), seed: 7, frames: {} }, "/w/out.mp4")).toEqual([
      "/py", "/draft.py", "--prompt", "a fox in snow", "--seconds", "5", "--res", "480x848", "--seed", "7", "--out", "/w/out.mp4",
    ]);
    expect(ltxArgv("/py", "/draft.py", { spec: ltxSpec({ seconds: 3, resolution: "512x512" }), seed: 1, frames: { start: "/a.png", mid: "/m.png", end: "/b.png" } }, "/o.mp4")).toEqual([
      "/py", "/draft.py", "--prompt", "a fox in snow", "--seconds", "3", "--res", "512x512", "--seed", "1", "--out", "/o.mp4",
      "--start", "/a.png", "--end", "/b.png", "--mid", "/m.png@0.5",
    ]);
  });

  it("is available only with draft.py and its venv's python, and runs it with Homebrew on PATH", async () => {
    const dir = freshDir();
    const missing = await new LtxRunner(dir).describe();
    expect(missing).toMatchObject({ id: "ltx", available: false });
    expect(missing.reason).toContain("draft.py");
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    writeFileSync(join(dir, "draft.py"), "");
    // A stand-in python: records its argv and PATH, then writes the --out file like draft.py would.
    const python = join(dir, ".venv", "bin", "python");
    writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\necho "$PATH" > "${dir}/path"\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--out" ]; then echo clip > "$2"; fi\n  shift\ndone\n`);
    chmodSync(python, 0o755);
    const runner = new LtxRunner(dir);
    expect(await runner.describe()).toMatchObject({ id: "ltx", available: true, serial: true, seed: true });
    const input = runInput(ltxSpec(), { seed: 9 });
    const output = await runner.run(input);
    expect(output).toEqual({ path: join(input.workDir, "out.mp4"), mimeType: "video/mp4" });
    expect(readFileSync(join(dir, "argv"), "utf8").split("\n")).toContain("--seed");
    expect(readFileSync(join(dir, "path"), "utf8")).toMatch(/^\/opt\/homebrew\/bin:\/usr\/local\/bin:/);
  });

  it("fails with the last lines of stderr", async () => {
    const dir = freshDir();
    const script = join(dir, "fail.sh");
    writeFileSync(script, "echo 'Traceback (most recent call last):' >&2\necho 'ValueError: bad size' >&2\necho 'generation failed (exit 1)' >&2\nexit 1\n");
    await expect(runProcessGroup(["/bin/sh", script], { env: process.env, signal: new AbortController().signal, graceMs: 100 })).rejects.toThrow(
      "Traceback (most recent call last): | ValueError: bad size | generation failed (exit 1)",
    );
  });

  it("on cancel SIGTERMs the whole process group, children included", async () => {
    const { script, pids } = sleeperScript();
    const controller = new AbortController();
    const run = runProcessGroup(["/bin/sh", script], { env: process.env, signal: controller.signal, graceMs: 5000 });
    const [shell, sleep] = await untilPids(pids, 2);
    controller.abort();
    await expect(run).rejects.toThrow("Cancelled");
    expect(await gone(shell ?? 0)).toBe(true);
    expect(await gone(sleep ?? 0)).toBe(true);
  });

  it("SIGKILLs a group that ignores SIGTERM once the grace period is over", async () => {
    const { script, pids } = sleeperScript("trap '' TERM");
    const controller = new AbortController();
    const run = runProcessGroup(["/bin/sh", script], { env: process.env, signal: controller.signal, graceMs: 150 });
    const [shell, sleep] = await untilPids(pids, 2);
    const at = Date.now();
    controller.abort();
    await expect(run).rejects.toThrow("Cancelled");
    expect(Date.now() - at).toBeGreaterThanOrEqual(100);
    expect(await gone(shell ?? 0)).toBe(true);
    expect(await gone(sleep ?? 0)).toBe(true);
  });
});

/** An unsigned JWT whose claims carry a ChatGPT account. */
const TOKEN = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.y`;

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function capturingFetch(reply: () => Response): { readonly fetch: Fetch; readonly calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(reply());
    },
  };
}

function bodyOf(call: Captured | undefined): Record<string, unknown> {
  const body = call?.init.body;
  return JSON.parse(typeof body === "string" ? body : "null") as Record<string, unknown>;
}

describe("Codex runner", () => {
  it("reads the ChatGPT account from the token's claims", () => {
    expect(chatgptAccountId(TOKEN)).toBe("acct-1");
    expect(chatgptAccountId("not-a-jwt")).toBeNull();
    expect(chatgptAccountId(`x.${Buffer.from("{}").toString("base64url")}.y`)).toBeNull();
  });

  it("asks images/generations like the Codex CLI, naming the orientation, and crops the reply to the size picked", async () => {
    const { fetch, calls } = capturingFetch(() => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }));
    const media = fakeMedia();
    const runner = new CodexRunner({ backend: "codex-image", token: () => Promise.resolve(TOKEN), fetch, jpeg: media.jpeg, cover: media.cover });
    expect(await runner.describe()).toMatchObject({ id: "codex-image", available: true, seed: false });
    const input = runInput(imageSpec());
    const output = await runner.run(input);
    expect(output).toEqual({ path: join(input.workDir, "out.png"), mimeType: "image/png" });
    expect(media.coverCalls).toEqual([{ src: join(input.workDir, "raw.png"), dest: output.path, width: 1088, height: 1920 }]);
    expect(new Uint8Array(readFileSync(join(input.workDir, "raw.png")))).toEqual(PNG);
    const [call] = calls;
    expect(call?.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "chatgpt-account-id": "acct-1",
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.200.0",
      "Content-Type": "application/json",
    });
    expect(call?.init.signal).toBe(input.signal);
    expect(bodyOf(call)).toEqual({ prompt: "a red kite Vertical 9:16 portrait image, taller than wide.", model: CODEX_IMAGE_MODEL, n: 1, quality: "high", size: "1088x1920" });
  });

  it("names each aspect in the prompt it sends, leaving the spec's prompt alone", () => {
    const prompt = (spec: StudioSpec): unknown => bodyOf(codexImageRequest("codex-image", spec, TOKEN, "acct-1", []))["prompt"];
    const landscape = imageSpec({ aspect: "16:9", resolution: "1920x1088" });
    expect(prompt(landscape)).toBe("a red kite Horizontal 16:9 landscape image, wider than tall.");
    expect(landscape.prompt).toBe("a red kite");
    expect(prompt(imageSpec({ aspect: "1:1", resolution: "1280x1280" }))).toBe("a red kite Square 1:1 image.");
  });

  it("sends edit references as JPEG data URLs to images/edits", async () => {
    const { fetch, calls } = capturingFetch(() => Response.json({ data: [{ b64_json: Buffer.from(JPEG).toString("base64") }] }));
    const converted: string[] = [];
    const media = fakeMedia();
    const runner = new CodexRunner({
      backend: "codex-edit",
      token: () => Promise.resolve(TOKEN),
      fetch,
      jpeg: (path) => {
        converted.push(path);
        return Promise.resolve(JPEG);
      },
      cover: media.cover,
    });
    const input = runInput(imageSpec({ backend: "codex-edit", aspect: "1:1", resolution: "1280x1280", refs: ["a", "b"] }), { refs: ["/a.png", "/b.webp"] });
    expect(await runner.run(input)).toEqual({ path: join(input.workDir, "out.png"), mimeType: "image/png" });
    expect(media.coverCalls).toEqual([{ src: join(input.workDir, "raw.jpg"), dest: join(input.workDir, "out.png"), width: 1280, height: 1280 }]);
    expect(converted).toEqual(["/a.png", "/b.webp"]);
    expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    const jpeg = `data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}`;
    expect(bodyOf(calls[0])).toEqual({ images: [{ image_url: jpeg }, { image_url: jpeg }], prompt: "a red kite Square 1:1 image.", model: CODEX_IMAGE_MODEL, n: 1, quality: "high", size: "1280x1280" });
  });

  it("surfaces the server's refusal in one line, and is unavailable without a token", async () => {
    const { fetch } = capturingFetch(() => Response.json({ error: { message: "Your request was rejected\nby the safety system." } }, { status: 400 }));
    const media = fakeMedia();
    const runner = new CodexRunner({ backend: "codex-image", token: () => Promise.resolve(TOKEN), fetch, jpeg: media.jpeg, cover: media.cover });
    await expect(runner.run(runInput(imageSpec()))).rejects.toThrow("Codex refused (HTTP 400): Your request was rejected by the safety system.");
    expect(media.coverCalls).toEqual([]);
    const signedOut = new CodexRunner({ backend: "codex-image", token: () => Promise.reject(new Error("omp token openai-codex failed: not logged in")), fetch, jpeg: media.jpeg, cover: media.cover });
    expect(await signedOut.describe()).toMatchObject({ available: false, reason: "omp token openai-codex failed: not logged in" });
  });
});

const catalog = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "higgsfield-models.json"), "utf8")) as { items: unknown[] };

function model(id: string): HiggsfieldModel {
  const found = curatedModels(catalog.items).get(id);
  if (found === undefined) throw new Error(`no ${id} in the fixture`);
  return found;
}

describe("Higgsfield models", () => {
  it("keeps the curated models Higgsfield lists, in Studio's order", () => {
    expect([...curatedModels(catalog.items).keys()]).toEqual(HIGGSFIELD_MODELS);
  });

  it("maps a mode knob, a duration range and start/end roles", () => {
    expect(studioModel(model("kling3_0"))).toEqual({
      id: "kling3_0",
      name: "Kling v3.0",
      mode: "video",
      resolutions: (["9:16", "16:9", "1:1"] as const).flatMap((aspect) => [
        { id: "std", label: "Standard", aspect },
        { id: "pro", label: "Pro", aspect },
        { id: "4k", label: "4K", aspect },
      ]),
      seconds: [3, 4, 5, 6, 8, 10, 12, 15],
      frames: ["start", "end"],
    });
  });

  it("maps resolution options, listed durations, and models that pick their own shape", () => {
    const seedance = studioModel(model("seedance1_5"));
    expect(seedance.resolutions.filter((resolution) => resolution.aspect === "9:16")).toEqual([
      { id: "480p", label: "480p", aspect: "9:16" },
      { id: "720p", label: "720p", aspect: "9:16" },
      { id: "1080p", label: "1080p", aspect: "9:16" },
    ]);
    expect(seedance.seconds).toEqual([4, 8, 12]);
    expect(studioModel(model("seedance_2_0")).seconds).toEqual([4, 5, 6, 8, 10, 12, 15]);
    expect(studioModel(model("wan2_7")).seconds).toEqual([2, 3, 4, 5, 6, 8, 10, 12, 15]);
    const hailuo = studioModel(model("minimax_hailuo"));
    expect(hailuo.resolutions).toEqual([
      { id: "512", label: "512p", aspect: "16:9" },
      { id: "768", label: "768p", aspect: "16:9" },
      { id: "1080", label: "1080p", aspect: "16:9" },
    ]);
    expect(hailuo.seconds).toEqual([6, 10]);
    const veo = studioModel(model("veo3_1_lite"));
    expect(veo.resolutions).toEqual([
      { id: "default", label: "Standard", aspect: "9:16" },
      { id: "default", label: "Standard", aspect: "16:9" },
    ]);
  });

  it("builds generate_video params with audio off and the quality knob the model has", () => {
    expect(higgsfieldParams(model("kling3_0"), paidSpec({ resolution: "pro", seconds: 10 }))).toEqual({
      model: "kling3_0",
      prompt: "a slow pan",
      aspect_ratio: "9:16",
      duration: 10,
      mode: "pro",
      sound: "off",
      count: 1,
      use_unlim: false,
    });
    expect(higgsfieldParams(model("seedance1_5"), paidSpec({ model: "seedance1_5", resolution: "720p", seconds: 4 }), [{ value: "m1", role: "start_image" }])).toEqual({
      model: "seedance1_5",
      prompt: "a slow pan",
      aspect_ratio: "9:16",
      duration: 4,
      resolution: "720p",
      generate_audio: false,
      count: 1,
      use_unlim: false,
      medias: [{ value: "m1", role: "start_image" }],
    });
    expect(higgsfieldParams(model("minimax_hailuo"), paidSpec({ model: "minimax_hailuo", aspect: "16:9", resolution: "768", seconds: 6 }))).not.toHaveProperty("aspect_ratio");
    expect(higgsfieldParams(model("veo3_1_lite"), paidSpec({ model: "veo3_1_lite", resolution: "default", seconds: 4 }))).not.toHaveProperty("resolution");
  });
});

describe("Higgsfield MCP", () => {
  it("finds the reply with its id in SSE or JSON bodies", () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
    expect(rpcReply(sse, 3)).toEqual({ id: 3, result: { ok: true } });
    expect(rpcReply('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"nope"}}', 1)).toMatchObject({ error: { message: "nope" } });
    expect(rpcReply(sse, 9)).toBeNull();
  });

  it("reads curl -H pairs from upload instructions", () => {
    expect(curlHeaders(`curl -X PUT -H "Content-Type: image/png" -H 'x-amz-acl: private' --data-binary @start.png "https://up"`)).toEqual({
      "Content-Type": "image/png",
      "x-amz-acl": "private",
    });
  });

  /**
   * A fake Higgsfield MCP server: JSON-RPC over POST (initialize hands out a session id), SSE replies
   * for tool calls, tool results from `tools`; any other URL is a PUT upload or the mp4 download.
   */
  function fakeServer(tools: Record<string, (args: Record<string, unknown>) => unknown>): { readonly fetch: Fetch; readonly calls: { name: string; args: Record<string, unknown>; session: string | null }[]; readonly other: Captured[] } {
    const calls: { name: string; args: Record<string, unknown>; session: string | null }[] = [];
    const other: Captured[] = [];
    const fetch: Fetch = (url, init) => {
      if (url !== HIGGSFIELD_MCP_URL) {
        other.push({ url, init });
        return Promise.resolve(init.method === "PUT" ? new Response(null, { status: 200 }) : new Response(MP4));
      }
      const message = JSON.parse(typeof init.body === "string" ? init.body : "{}") as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      const headers = new Headers(init.headers);
      if (message.method === "initialize") return Promise.resolve(Response.json({ jsonrpc: "2.0", id: message.id, result: {} }, { headers: { "mcp-session-id": "sess-1" } }));
      if (message.id === undefined) return Promise.resolve(new Response(null, { status: 202 }));
      const { name, arguments: args } = message.params ?? { name: "", arguments: {} };
      calls.push({ name, args, session: headers.get("mcp-session-id") });
      const result = tools[name]?.(args) ?? { content: [{ type: "text", text: `no tool ${name}` }], isError: true };
      return Promise.resolve(new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    };
    return { fetch, calls, other };
  }

  const structured = (value: unknown, text = ""): unknown => ({ content: [{ type: "text", text }], structuredContent: value });
  const signedIn = (): Promise<{ access: string; expires: number }> => Promise.resolve({ access: "hf-token", expires: Date.now() + 3_600_000 });

  it("describes the models and balance, and quotes a job, declining a recommended preset", async () => {
    const server = fakeServer({
      balance: () => structured({ credits: 379.8 }),
      models_explore: () => structured(catalog),
      generate_video: (args) => {
        const params = args["params"] as Record<string, unknown>;
        if (params["declined_preset_id"] === undefined) return structured({ notice: { type: "preset_recommendation", data: { preset: { id: "preset-9" } } } });
        return structured({ cost: { credits: 42 } });
      },
    });
    const runner = new HiggsfieldRunner({ credentials: signedIn, fetch: server.fetch, now: Date.now, sleep: () => Promise.resolve() });
    const backend = await runner.describe();
    expect(backend).toMatchObject({ id: "higgsfield", available: true, paid: true, balance: 379.8 });
    expect(backend.models?.map((entry) => entry.id)).toEqual(HIGGSFIELD_MODELS);
    expect(await runner.quote(paidSpec())).toBe(42);
    const quotes = server.calls.filter((call) => call.name === "generate_video").map((call) => call.args["params"]);
    expect(quotes).toEqual([
      expect.objectContaining({ model: "kling3_0", get_cost: true, sound: "off", use_unlim: false }),
      expect.objectContaining({ get_cost: true, declined_preset_id: "preset-9" }),
    ]);
    expect(server.calls.every((call) => call.session === "sess-1")).toBe(true);
  });

  it("is unavailable when omp's sign-in has expired", async () => {
    const runner = new HiggsfieldRunner({ credentials: () => Promise.resolve({ access: "old", expires: Date.now() - 1 }), fetch: fakeServer({}).fetch, now: Date.now, sleep: () => Promise.resolve() });
    expect(await runner.describe()).toMatchObject({ available: false, reason: HIGGSFIELD_SIGNIN_EXPIRED });
    const missing = new HiggsfieldRunner({ credentials: () => Promise.resolve(null), fetch: fakeServer({}).fetch, now: Date.now, sleep: () => Promise.resolve() });
    await expect(missing.quote(paidSpec())).rejects.toThrow(HIGGSFIELD_SIGNIN_EXPIRED);
  });

  it("uploads the frames, starts the job with audio off, polls it and downloads the clip", async () => {
    const jobId = "1b2c3d4e-0000-4000-8000-000000000001";
    let polls = 0;
    const server = fakeServer({
      models_explore: () => structured(catalog),
      media_upload: () =>
        structured({
          uploads: [
            { upload_url: "https://upload.example/a", media_id: "media-a", instructions: `curl -X PUT -H "Content-Type: image/png" --data-binary @start.png "https://upload.example/a"` },
            { upload_url: "https://upload.example/b", media_id: "media-b", instructions: `curl -X PUT -H "Content-Type: image/png" --data-binary @end.png "https://upload.example/b"` },
          ],
        }),
      media_confirm: () => structured({ confirmed: true }),
      generate_video: () => structured({ jobs: 1 }, `Started job ${jobId}.`),
      job_status: () => {
        polls += 1;
        return polls === 1
          ? structured({ generation: { status: "in_progress" }, poll_after_seconds: 1 })
          : structured({ generation: { status: "completed" } }, "Done: [video](https://cdn.example/out/clip.mp4?sig=1)");
      },
    });
    const sleeps: number[] = [];
    const runner = new HiggsfieldRunner({
      credentials: signedIn,
      fetch: server.fetch,
      now: Date.now,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const frames = freshDir();
    writeFileSync(join(frames, "a.png"), PNG);
    writeFileSync(join(frames, "b.png"), PNG);
    const input = runInput(paidSpec({ frames: { start: "a", end: "b" } }), { frames: { start: join(frames, "a.png"), end: join(frames, "b.png") } });
    const output = await runner.run(input);
    expect(output).toEqual({ path: join(input.workDir, "out.mp4"), mimeType: "video/mp4" });
    expect(new Uint8Array(readFileSync(output.path))).toEqual(MP4);
    expect(server.calls.map((call) => call.name)).toEqual(["models_explore", "media_upload", "media_confirm", "generate_video", "job_status", "job_status"]);
    expect(server.calls[1]?.args).toEqual({ files: [{ filename: "start.png" }, { filename: "end.png" }] });
    expect(server.calls[2]?.args).toEqual({ type: "image", media_ids: ["media-a", "media-b"] });
    expect(server.calls[3]?.args["params"]).toEqual({
      model: "kling3_0",
      prompt: "a slow pan",
      aspect_ratio: "9:16",
      duration: 5,
      mode: "std",
      sound: "off",
      count: 1,
      use_unlim: false,
      medias: [
        { value: "media-a", role: "start_image" },
        { value: "media-b", role: "end_image" },
      ],
    });
    expect(server.calls[4]?.args).toEqual({ jobId });
    expect(sleeps).toEqual([2000]);
    expect(server.other.map((call) => [call.init.method, call.url])).toEqual([
      ["PUT", "https://upload.example/a"],
      ["PUT", "https://upload.example/b"],
      ["GET", "https://cdn.example/out/clip.mp4?sig=1"],
    ]);
    expect(server.other[0]?.init.headers).toEqual({ "Content-Type": "image/png" });
    expect(input.notes).toEqual(["Uploading frames", "Sending to Higgsfield", "Rendering on Higgsfield", "Downloading"]);
  });

  it("fails a job Higgsfield fails, with its words", async () => {
    const server = fakeServer({
      models_explore: () => structured(catalog),
      generate_video: () => structured({}, "Job 1b2c3d4e-0000-4000-8000-000000000002 queued"),
      job_status: () => structured({ generation: { status: "nsfw" } }, "Content flagged by moderation"),
    });
    const runner = new HiggsfieldRunner({ credentials: signedIn, fetch: server.fetch, now: Date.now, sleep: () => Promise.resolve() });
    await expect(runner.run(runInput(paidSpec()))).rejects.toThrow("Higgsfield nsfw: Content flagged by moderation");
  });
});

const ffmpeg = findTool("ffmpeg");

describe.skipIf(ffmpeg === null || findTool("ffprobe") === null)("Studio media on the real ffmpeg", () => {
  it("sizes a clip, thumbs it within 640 px, grabs its last frame, turns an image into JPEG and cuts images to exact sizes", async () => {
    const dir = freshDir();
    const clip = join(dir, "clip.mp4");
    const made = spawnSync(ffmpeg ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    expect(made.status).toBe(0);
    const logs: string[] = [];
    const media = ffmpegMedia((line) => logs.push(line));
    expect(await media.probe(clip)).toMatchObject({ width: 1280, height: 720 });

    const thumb = join(dir, "clip.thumb.jpg");
    expect(await media.thumb(clip, thumb)).toBe(true);
    expect(await media.probe(thumb)).toMatchObject({ width: 640, height: 360 });

    const last = join(dir, "last.png");
    await media.frame(clip, "last", last);
    expect(await media.probe(last)).toMatchObject({ width: 1280, height: 720 });
    expect([...(await media.jpeg(last)).slice(0, 2)]).toEqual([0xff, 0xd8]);

    // What Codex sends back for a portrait or an unshaped prompt, cut to Studio's exact sizes.
    for (const [source, width, height] of [["941x1672", 1088, 1920], ["1536x1024", 1280, 1280], ["1536x1024", 1920, 1088]] as const) {
      const raw = join(dir, `raw-${source}.png`);
      expect(spawnSync(ffmpeg ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${source}`, "-frames:v", "1", raw]).status).toBe(0);
      const out = join(dir, `out-${source}-${String(width)}.png`);
      await media.cover(raw, out, width, height);
      expect(await media.probe(out)).toMatchObject({ width, height });
    }
    expect(logs).toEqual([]);
  });
});
