// Paid video on Higgsfield through its MCP server (JSON-RPC over streamable HTTP), signed in as
// Isaac with the token omp keeps for its Higgsfield tools. omp's credential store is opened
// read-only and never refreshed or written: when the token runs out the backend is unavailable
// until an omp session renews it.
//
// A job: upload the keyframes (`media_upload` hands out presigned PUT URLs, `media_confirm` seals
// them), `generate_video` (audio off), poll `job_status` until the generation ends, then download
// the mp4 its reply links. Prices come from the same `generate_video` with `get_cost: true`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { StudioAspect, type StudioBackend, type StudioFrameSlot, type StudioModel, type StudioSpec } from "@relay/protocol";
import { z } from "zod";
import { BACKEND_BASE } from "./backends";
import type { Fetch } from "./codex";
import { oneLine, type StudioRunInput, type StudioRunner, type StudioRunOutput } from "./runner";

export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";
/** omp's `auth_credentials.provider` for the personal profile's Higgsfield MCP sign-in. */
const CREDENTIAL_PROVIDER = `mcp_oauth:profile:personal:${HIGGSFIELD_MCP_URL}`;
export const HIGGSFIELD_SIGNIN_EXPIRED = "Higgsfield sign-in expired; use the Higgsfield tools in an omp session to renew it";
/** The models Studio offers, in this order, when Higgsfield lists them. */
export const HIGGSFIELD_MODELS = ["seedance_2_0", "kling_o3_flf", "seedance1_5", "kling3_0", "wan2_7", "veo3_1_lite", "minimax_hailuo"];
/** The `resolution` id for a model with no quality knob. */
const DEFAULT_LEVEL = "default";
const LEVEL_LABELS: Readonly<Record<string, string>> = { std: "Standard", pro: "Pro", "4k": "4K", [DEFAULT_LEVEL]: "Standard" };
/** Lengths offered from a model's duration range. */
const SECOND_PICKS = [3, 4, 5, 6, 8, 10, 12, 15];
const POLL_MS = 8000;
const RENDER_LIMIT_MS = 30 * 60_000;
const FAILED_STATES = new Set(["failed", "nsfw", "cancelled", "canceled", "error", "rejected", "expired"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MP4_URL = /https:\/\/[^\s"'<>()[\]]+?\.mp4(?:\?[^\s"'<>()[\]]*)?/;

export interface HiggsfieldCredentials {
  readonly access: string;
  /** Epoch ms. */
  readonly expires: number;
}

const StoredCredential = z.object({ access: z.string().min(1), expires: z.number() });

/** Reads omp's Higgsfield sign-in from `agent.db`, read-only; null when there is none. */
export function ompHiggsfieldCredentials(dbPath: string): () => Promise<HiggsfieldCredentials | null> {
  return async () => {
    if (!existsSync(dbPath)) return null;
    // bun:sqlite exists only under Bun (the host); the vitest suite runs on Node and never gets here.
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query<{ data: string }, [string]>("SELECT data FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY updated_at DESC LIMIT 1")
        .get(CREDENTIAL_PROVIDER);
      if (row === null) return null;
      const parsed = StoredCredential.safeParse(JSON.parse(row.data));
      return parsed.success ? parsed.data : null;
    } finally {
      db.close();
    }
  };
}

const RpcMessage = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
type RpcMessage = z.infer<typeof RpcMessage>;

/** The JSON-RPC message answering `id` in a reply body, plain JSON or server-sent events (`data:` lines). */
export function rpcReply(body: string, id: number): RpcMessage | null {
  const trimmed = body.trim();
  const payloads =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? [trimmed]
      : trimmed.split(/\r?\n\r?\n/).map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n"),
        );
  for (const payload of payloads) {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    const messages: unknown[] = Array.isArray(json) ? json : [json];
    for (const candidate of messages) {
      const message = RpcMessage.safeParse(candidate);
      if (message.success && message.data.id === id) return message.data;
    }
  }
  return null;
}

const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

interface ToolReply {
  /** The text parts, joined. */
  readonly text: string;
  readonly structured: unknown;
}

/** One MCP session: `initialize`, then tool calls carrying the `Mcp-Session-Id` the server gave. */
class McpSession {
  private sessionId: string | null = null;
  private nextId = 1;

  private constructor(
    private readonly token: string,
    private readonly fetch: Fetch,
    private readonly signal: AbortSignal | null,
  ) {}

  static async open(token: string, fetch: Fetch, signal: AbortSignal | null): Promise<McpSession> {
    const session = new McpSession(token, fetch, signal);
    await session.initialize();
    return session;
  }

  /** Rejects with the tool's own error text when it reports `isError`. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const result = ToolResult.safeParse(await this.request("tools/call", { name, arguments: args }, false));
    if (!result.success) throw new Error(`Higgsfield ${name} sent a reply Relay could not read`);
    const text = result.data.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
    if (result.data.isError === true) throw new Error(`Higgsfield ${name}: ${oneLine(text, 400) || "failed"}`);
    return { text, structured: result.data.structuredContent };
  }

  private async initialize(): Promise<void> {
    this.sessionId = null;
    await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "relay-host", version: "1" } }, false);
    const response = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await response.text();
  }

  private async request(method: string, params: unknown, retried: boolean): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    // A server that forgot the session (restarted, idle too long) answers 404: start a new one, once.
    if (response.status === 404 && method !== "initialize" && !retried) {
      await response.text();
      await this.initialize();
      return this.request(method, params, true);
    }
    const body = await response.text();
    if (!response.ok) throw new Error(`Higgsfield ${method}: HTTP ${String(response.status)} ${oneLine(body, 200)}`.trim());
    const reply = rpcReply(body, id);
    if (reply === null) throw new Error(`Higgsfield sent no answer to ${method}`);
    if (reply.error !== undefined) throw new Error(`Higgsfield ${method}: ${oneLine(reply.error.message, 400)}`);
    return reply.result;
  }

  private async post(message: Record<string, unknown>): Promise<Response> {
    const response = await this.fetch(HIGGSFIELD_MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        ...(this.sessionId === null ? {} : { "Mcp-Session-Id": this.sessionId }),
      },
      body: JSON.stringify(message),
      signal: this.signal,
    });
    const session = response.headers.get("mcp-session-id");
    if (session !== null) this.sessionId = session;
    if (response.status === 401 || response.status === 403) throw new Error(HIGGSFIELD_SIGNIN_EXPIRED);
    return response;
  }
}

const HiggsfieldParam = z.object({
  name: z.string(),
  options: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

/** One entry of `models_explore {action: "list"}`, the parts Studio reads. */
export const HiggsfieldModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parameters: z.array(HiggsfieldParam).default([]),
  medias: z.array(z.object({ roles: z.array(z.string()).default([]) })).default([]),
  aspect_ratios: z.array(z.string()).default([]),
});
export type HiggsfieldModel = z.infer<typeof HiggsfieldModel>;

function paramOf(model: HiggsfieldModel, name: string): z.infer<typeof HiggsfieldParam> | undefined {
  return model.parameters.find((param) => param.name === name);
}

/** Our aspects the model lists (in `aspect_ratios` or an `aspect_ratio` param); empty when it picks its own shape. */
function listedAspects(model: HiggsfieldModel): StudioAspect[] {
  const listed = [...model.aspect_ratios, ...(paramOf(model, "aspect_ratio")?.options ?? []).map(String)];
  return StudioAspect.options.filter((aspect) => listed.includes(aspect));
}

/** The model's quality knob: `resolution` (480p, 720p, ...), else `mode` (std, pro, 4k), else none. */
function qualityKnob(model: HiggsfieldModel): "resolution" | "mode" | null {
  if ((paramOf(model, "resolution")?.options?.length ?? 0) > 0) return "resolution";
  if ((paramOf(model, "mode")?.options?.length ?? 0) > 0) return "mode";
  return null;
}

/** The curated models Higgsfield lists, in `HIGGSFIELD_MODELS` order, by id. */
export function curatedModels(items: readonly unknown[]): Map<string, HiggsfieldModel> {
  const byId = new Map<string, HiggsfieldModel>();
  for (const item of items) {
    const parsed = HiggsfieldModel.safeParse(item);
    if (parsed.success && HIGGSFIELD_MODELS.includes(parsed.data.id)) byId.set(parsed.data.id, parsed.data);
  }
  return new Map(HIGGSFIELD_MODELS.flatMap((id) => {
    const model = byId.get(id);
    return model === undefined ? [] : [[id, model] as const];
  }));
}

/** A Higgsfield model as Studio offers it: each quality level at each of our aspects it takes, its lengths and keyframe slots. */
export function studioModel(model: HiggsfieldModel): StudioModel {
  const listed = listedAspects(model);
  // A model that names no aspect (Hailuo) shapes text-to-video clips landscape and follows a start frame's shape.
  const aspects: StudioAspect[] = listed.length > 0 ? listed : ["16:9"];
  const knob = qualityKnob(model);
  const levels = knob === null ? [DEFAULT_LEVEL] : (paramOf(model, knob)?.options ?? []).map(String);
  const duration = paramOf(model, "duration");
  const options = (duration?.options ?? []).filter((option): option is number => typeof option === "number");
  const range = duration?.min !== undefined && duration.max !== undefined ? { min: duration.min, max: duration.max } : null;
  const seconds = options.length > 0 ? options : range === null ? [5] : [range.min, ...SECOND_PICKS].filter((s) => Number.isInteger(s) && s >= range.min && s <= range.max);
  const roles = new Set(model.medias.flatMap((media) => media.roles));
  const frames: StudioFrameSlot[] = [];
  if (roles.has("start_image")) frames.push("start");
  if (roles.has("end_image")) frames.push("end");
  return {
    id: model.id,
    name: model.name.slice(0, 120),
    mode: "video",
    resolutions: aspects
      .flatMap((aspect) => levels.map((id) => ({ id, label: /^\d+$/.test(id) ? `${id}p` : (LEVEL_LABELS[id.toLowerCase()] ?? id), aspect })))
      .slice(0, 20),
    seconds: [...new Set(seconds)].filter((s) => s > 0 && s <= 20).sort((a, b) => a - b).slice(0, 20),
    frames,
  };
}

/** `generate_video`'s params for `spec`: one clip, credits not the unlimited plan, audio off, plus `medias` (uploaded keyframes). */
export function higgsfieldParams(
  model: HiggsfieldModel,
  spec: StudioSpec,
  medias: readonly { readonly value: string; readonly role: string }[] = [],
): Record<string, unknown> {
  const knob = qualityKnob(model);
  return {
    model: model.id,
    prompt: spec.prompt,
    ...(listedAspects(model).includes(spec.aspect) ? { aspect_ratio: spec.aspect } : {}),
    ...(spec.seconds === undefined ? {} : { duration: spec.seconds }),
    ...(knob === null ? {} : { [knob]: spec.resolution }),
    ...(paramOf(model, "generate_audio") === undefined ? {} : { generate_audio: false }),
    ...(paramOf(model, "sound") === undefined ? {} : { sound: "off" }),
    count: 1,
    use_unlim: false,
    ...(medias.length > 0 ? { medias } : {}),
  };
}

/** The `-H "Name: value"` pairs in a presigned upload's curl instructions. */
export function curlHeaders(instructions: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [, , name, value] of instructions.matchAll(/-H\s+(["'])([^:"']+):\s*(.*?)\1/g)) {
    if (name !== undefined && value !== undefined) headers[name.trim()] = value;
  }
  return headers;
}

const Balance = z.object({ credits: z.number() });
const Catalog = z.object({ items: z.array(z.unknown()) });
const Cost = z.object({ cost: z.object({ credits: z.number().nonnegative() }) });
const PresetNotice = z.object({
  notice: z.object({ type: z.literal("preset_recommendation"), data: z.object({ preset: z.object({ id: z.string().min(1) }) }) }),
});
const Uploads = z.object({
  uploads: z
    .array(z.object({ upload_url: z.string().url(), media_id: z.string().min(1), instructions: z.union([z.string(), z.array(z.string())]).optional() }))
    .min(1),
});
const JobStatus = z.object({
  generation: z.object({ status: z.string().optional() }).optional(),
  status: z.string().optional(),
  poll_after_seconds: z.number().optional(),
});

export interface HiggsfieldRunnerDeps {
  readonly credentials: () => Promise<HiggsfieldCredentials | null>;
  readonly fetch: Fetch;
  readonly now: () => number;
  /** Waits between `job_status` polls; rejects once `signal` aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class HiggsfieldRunner implements StudioRunner {
  /** The curated models from the last catalog read, by id. */
  private catalog = new Map<string, HiggsfieldModel>();
  /** The session quotes, balance and catalog reads share (the composer asks a quote per setting); jobs open their own. */
  private shared: { readonly access: string; readonly session: Promise<McpSession> } | null = null;

  constructor(private readonly deps: HiggsfieldRunnerDeps) {}

  async describe(): Promise<StudioBackend> {
    const base = BACKEND_BASE.higgsfield;
    try {
      const session = await this.session(null);
      const balance = await this.readBalance(session);
      const models = await this.loadModels(session);
      const known = balance === undefined ? {} : { balance };
      if (models.length === 0) return { ...base, ...known, available: false, reason: "Higgsfield lists none of the video models Studio knows" };
      return { ...base, ...known, available: true, models };
    } catch (error) {
      return { ...base, available: false, reason: oneLine(error, 400) };
    }
  }

  async quote(spec: StudioSpec): Promise<number> {
    const session = await this.session(null);
    const model = await this.model(session, spec.model);
    const reply = await this.generate(session, { ...higgsfieldParams(model, spec), get_cost: true });
    const cost = Cost.safeParse(reply.structured);
    if (!cost.success) throw new Error("Higgsfield gave no price for this job");
    return cost.data.cost.credits;
  }

  async balance(): Promise<number | undefined> {
    try {
      return await this.readBalance(await this.session(null));
    } catch {
      return undefined;
    }
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const { spec, signal } = input;
    const session = await this.session(signal);
    const model = await this.model(session, spec.model);
    const medias = await this.uploadFrames(session, input);
    input.note("Sending to Higgsfield");
    const submitted = await this.generate(session, higgsfieldParams(model, spec, medias));
    const jobId = UUID.exec(submitted.text)?.[0] ?? UUID.exec(JSON.stringify(submitted.structured ?? null))?.[0];
    if (jobId === undefined) throw new Error("Higgsfield did not say which job it started");
    input.note("Rendering on Higgsfield");
    const url = await this.poll(session, jobId, signal);
    input.note("Downloading");
    const response = await this.deps.fetch(url, { method: "GET", signal });
    if (!response.ok) throw new Error(`Downloading the Higgsfield video failed (HTTP ${String(response.status)})`);
    const path = join(input.workDir, "out.mp4");
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
    return { path, mimeType: "video/mp4" };
  }

  /** A fresh session bound to `signal` for a job; the shared one (opened again for a new token) without. */
  private async session(signal: AbortSignal | null): Promise<McpSession> {
    const credentials = await this.deps.credentials();
    // A minute of margin: a token that dies mid-job fails the job after it was charged.
    if (credentials === null || credentials.expires - 60_000 <= this.deps.now()) throw new Error(HIGGSFIELD_SIGNIN_EXPIRED);
    if (signal !== null) return McpSession.open(credentials.access, this.deps.fetch, signal);
    if (this.shared?.access === credentials.access) return this.shared.session;
    const session = McpSession.open(credentials.access, this.deps.fetch, null);
    const shared = { access: credentials.access, session };
    this.shared = shared;
    // A session that failed to open is forgotten, so the next call opens a new one.
    void session.catch(() => {
      if (this.shared === shared) this.shared = null;
    });
    return session;
  }

  private async readBalance(session: McpSession): Promise<number | undefined> {
    const balance = Balance.safeParse((await session.call("balance", {})).structured);
    return balance.success ? balance.data.credits : undefined;
  }

  private async loadModels(session: McpSession): Promise<StudioModel[]> {
    const catalog = Catalog.safeParse((await session.call("models_explore", { action: "list", type: "video", limit: 100 })).structured);
    if (!catalog.success) throw new Error("Higgsfield sent a model list Relay could not read");
    this.catalog = curatedModels(catalog.data.items);
    return [...this.catalog.values()].map(studioModel);
  }

  private async model(session: McpSession, id: string | undefined): Promise<HiggsfieldModel> {
    if (this.catalog.size === 0) await this.loadModels(session);
    const model = id === undefined ? undefined : this.catalog.get(id);
    if (model === undefined) throw new Error(`Higgsfield has no model ${id ?? "(none picked)"}`);
    return model;
  }

  /** `generate_video`, declining a preset Higgsfield recommends instead of running the request. */
  private async generate(session: McpSession, params: Record<string, unknown>): Promise<ToolReply> {
    const reply = await session.call("generate_video", { params });
    const notice = PresetNotice.safeParse(reply.structured);
    if (!notice.success) return reply;
    return session.call("generate_video", { params: { ...params, declined_preset_id: notice.data.notice.data.preset.id } });
  }

  /** Uploads the start/end frames; the `medias` entries naming them. */
  private async uploadFrames(session: McpSession, input: StudioRunInput): Promise<{ value: string; role: string }[]> {
    const frames = (["start", "end"] as const).flatMap((slot) => {
      const path = input.frames[slot];
      return path === undefined ? [] : [{ slot, path }];
    });
    if (frames.length === 0) return [];
    input.note("Uploading frames");
    const reply = await session.call("media_upload", { files: frames.map((frame) => ({ filename: `${frame.slot}${extname(frame.path)}` })) });
    const parsed = Uploads.safeParse(reply.structured);
    if (!parsed.success || parsed.data.uploads.length < frames.length) throw new Error("Higgsfield gave no upload links for the frames");
    const medias: { value: string; role: string }[] = [];
    for (const [i, frame] of frames.entries()) {
      const upload = parsed.data.uploads[i];
      if (upload === undefined) continue;
      const instructions = Array.isArray(upload.instructions) ? upload.instructions.join("\n") : (upload.instructions ?? "");
      const put = await this.deps.fetch(upload.upload_url, { method: "PUT", headers: curlHeaders(instructions), body: readFileSync(frame.path), signal: input.signal });
      if (put.status !== 200) throw new Error(`Uploading the ${frame.slot} frame to Higgsfield failed (HTTP ${String(put.status)})`);
      medias.push({ value: upload.media_id, role: `${frame.slot}_image` });
    }
    await session.call("media_confirm", { type: "image", media_ids: medias.map((media) => media.value) });
    return medias;
  }

  /** Polls `job_status` until the generation ends; the mp4 URL it links. */
  private async poll(session: McpSession, jobId: string, signal: AbortSignal): Promise<string> {
    const deadline = this.deps.now() + RENDER_LIMIT_MS;
    for (;;) {
      const reply = await session.call("job_status", { jobId });
      const status = JobStatus.safeParse(reply.structured);
      const state = status.success ? (status.data.generation?.status ?? status.data.status ?? "") : "";
      if (state === "completed") {
        const url = MP4_URL.exec(reply.text)?.[0] ?? MP4_URL.exec(JSON.stringify(reply.structured ?? null))?.[0];
        if (url === undefined) throw new Error("Higgsfield finished without a video link");
        return url;
      }
      if (FAILED_STATES.has(state)) throw new Error(`Higgsfield ${state}: ${oneLine(reply.text, 300)}`);
      if (this.deps.now() > deadline) throw new Error("Higgsfield did not finish within 30 minutes");
      const after = status.success ? status.data.poll_after_seconds : undefined;
      await this.deps.sleep(after === undefined ? POLL_MS : Math.max(2000, after * 1000), signal);
    }
  }
}
