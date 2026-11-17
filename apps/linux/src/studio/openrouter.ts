// Paid images and edits on OpenRouter's Image API (`POST /api/v1/images`), billed in US dollars to the
// key Isaac approved for agents (`secrets/atomic-agents-openrouter.key`, read per call, never logged).
//
// Models: every model `GET /api/v1/images/models` lists with an image output, with what each accepts
// (`aspect_ratio`, `resolution` tiers, reference images) and its endpoints' prices
// (`/images/models/<id>/endpoints`), read once and kept for CATALOG_TTL_MS. A model whose price is unknown
// (no endpoint prices an output image) or whose only output is a vector (SVG, which Studio cannot keep) is
// left out: Isaac confirms a price before any job, so there must be one. Our three aspects map to the
// nearest `aspect_ratio` the model lists; a model with none gets the orientation in the prompt instead.
//
// A quote is an estimate: the output image's price at the picked tier (per image, per megapixel, or per
// token with a typical token count), the references' input price and a fixed text allowance, the dearest
// endpoint of the model. It depends only on model, tier and reference count, so the host's re-quote at
// `create` equals the one Isaac confirmed. The job records what OpenRouter really billed (`usage.cost`).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  studioPriceLabel,
  type StudioAspect,
  type StudioBackend,
  type StudioModel,
  type StudioResolution,
  type StudioSpec,
} from "@relay/protocol";
import { BACKEND_BASE } from "./backends";
import type { Fetch } from "./codex";
import type { StudioMedia } from "./media";
import { oneLine, type StudioRunInput, type StudioRunner, type StudioRunOutput } from "./runner";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
/** The model Studio lists first, so a draft that names only the backend lands on it. */
export const OPENROUTER_DEFAULT_MODEL = "google/gemini-nano-banana-2.1";
export const OPENROUTER_KEY_FILE = "atomic-agents-openrouter.key";
/** How long the model list and prices are reused. */
export const CATALOG_TTL_MS = 6 * 60 * 60_000;
/** After a failed read, how long before the next one is tried. */
const CATALOG_RETRY_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000;
const GENERATE_TIMEOUT_MS = 5 * 60_000;
const PRICE_READS_AT_ONCE = 8;
/** The resolution id of a model with no `resolution` knob. */
export const AUTO_RESOLUTION = "auto";
/** The tier a model starts on when it offers it. */
const DEFAULT_TIER = "1K";
const ASPECTS: readonly StudioAspect[] = ["1:1", "16:9", "9:16"];

/** The orientation a model with no `aspect_ratio` knob is told in the prompt. */
export const ORIENTATION_SENTENCES: Readonly<Record<StudioAspect, string>> = {
  "1:1": "Square composition, 1:1.",
  "16:9": "Wide landscape composition, 16:9.",
  "9:16": "Tall portrait composition, 9:16.",
};

const Descriptor = z.object({
  type: z.string(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
const ListedModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  architecture: z.object({ output_modalities: z.array(z.string()) }),
  supported_parameters: z.record(z.string(), Descriptor).default({}),
});
const ModelList = z.object({ data: z.array(z.unknown()) });
const PriceLine = z.object({
  billable: z.string(),
  unit: z.string(),
  cost_usd: z.number().nonnegative(),
  variant: z.string().nullish(),
});
const Endpoints = z.object({
  endpoints: z.array(z.object({ pricing: z.array(z.unknown()).default([]) })),
});

type PriceLine = z.infer<typeof PriceLine>;

/** An image model as the runner keeps it: what it takes and what each endpoint charges. */
export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly aspects: readonly string[];
  readonly tiers: readonly string[];
  readonly refs: { readonly min: number; readonly max: number };
  /** One price list per endpoint (provider) of the model. */
  readonly endpoints: readonly (readonly PriceLine[])[];
}

/** `a:b` (`16:9`, `2.35:1`) as a number; null for `auto` and anything else. */
function ratioOf(text: string): number | null {
  const [a, b, ...rest] = text.split(":").map(Number);
  return rest.length === 0 && a !== undefined && b !== undefined && a > 0 && b > 0 ? a / b : null;
}

/** The listed `aspect_ratio` nearest `aspect` (the exact one when listed); undefined when the model lists none. */
export function nearestAspectRatio(
  aspect: StudioAspect,
  listed: readonly string[],
): string | undefined {
  const target = ratioOf(aspect) ?? 1;
  let best: { readonly value: string; readonly gap: number } | undefined;
  for (const value of listed) {
    const ratio = ratioOf(value);
    if (ratio === null) continue;
    const gap = Math.abs(Math.log(ratio / target));
    if (best === undefined || gap < best.gap) best = { value, gap };
  }
  return best?.value;
}

/** Tiers in the order a picker offers them: the default tier first, then smallest to largest. */
function orderedTiers(listed: readonly string[]): string[] {
  const size = (tier: string): number =>
    TIER_MEGAPIXELS[tier.toLowerCase()] ?? Number.POSITIVE_INFINITY;
  const rest = [...listed].sort((a, b) => size(a) - size(b));
  const first = rest.find((tier) => tier.toUpperCase() === DEFAULT_TIER);
  return first === undefined ? rest : [first, ...rest.filter((tier) => tier !== first)];
}

/** Megapixels of a tier, for prices per megapixel. */
const TIER_MEGAPIXELS: Readonly<Record<string, number>> = {
  "512": 0.26,
  "768": 0.59,
  "1k": 1.05,
  "1.5k": 2.36,
  "2k": 4.19,
  "4k": 16.8,
};
/** Output tokens of one image per tier: Gemini's own counts (1K counted high), and a typical count for the rest. */
const GEMINI_TOKENS: Readonly<Record<string, number>> = {
  "512": 747,
  "1k": 1290,
  "1.5k": 1680,
  "2k": 1680,
  "4k": 2520,
};
const OTHER_TOKENS: Readonly<Record<string, number>> = {
  "512": 2500,
  "768": 4000,
  "1k": 6000,
  "1.5k": 9000,
  "2k": 12000,
  "4k": 20000,
};
/** What a model with no tier knob draws, in megapixels and (non-Gemini) tokens. */
const DEFAULT_MEGAPIXELS = 1.5;
const DEFAULT_TOKENS = 6000;
/** Input tokens of one reference image, and of the prompt (its longest: 4000 characters). */
const REF_TOKENS = 1100;
const PROMPT_TOKENS = 1200;

/** The dearest output-image price of one endpoint for `tier`: its tier's line, else its base line, else its dearest. */
function outputLine(lines: readonly PriceLine[], tier: string | null): PriceLine | undefined {
  const outputs = lines.filter(
    (line) => line.billable === "output_image" && line.unit !== "request",
  );
  const dearest = (list: readonly PriceLine[]): PriceLine | undefined =>
    list.reduce<PriceLine | undefined>(
      (a, b) => (a === undefined || b.cost_usd > a.cost_usd ? b : a),
      undefined,
    );
  const named =
    tier === null
      ? []
      : outputs.filter((line) => {
          const variant = line.variant?.toLowerCase();
          return variant === tier || variant?.endsWith(`_${tier}`) === true;
        });
  if (named.length > 0) return dearest(named);
  const base = outputs.filter((line) => line.variant === null || line.variant === undefined);
  return dearest(base.length > 0 ? base : outputs);
}

/** What `refs` reference images cost on one endpoint, from its base input lines. */
function inputUsd(lines: readonly PriceLine[], refs: number): number {
  let usd = 0;
  for (const line of lines) {
    if (line.variant !== null && line.variant !== undefined) continue;
    if (line.billable === "input_text" && line.unit === "token")
      usd += line.cost_usd * PROMPT_TOKENS;
    if (refs === 0) continue;
    if (line.billable === "input_image" || line.billable === "input_reference") {
      if (line.unit === "token") usd += line.cost_usd * REF_TOKENS * refs;
      else if (line.unit === "megapixel") usd += line.cost_usd * refs;
      else if (line.unit === "request") usd += line.cost_usd;
      else usd += line.cost_usd * refs;
    }
  }
  return usd;
}

/** One image's estimated price in US dollars: the dearest endpoint; null when no endpoint prices an output image. */
export function estimateUsd(
  model: Pick<CatalogModel, "id" | "endpoints">,
  resolution: string,
  refs: number,
): number | null {
  const tier = resolution === AUTO_RESOLUTION ? null : resolution.toLowerCase();
  const gemini = model.id.startsWith("google/");
  let dearest: number | null = null;
  for (const lines of model.endpoints) {
    const output = outputLine(lines, tier);
    if (output === undefined) continue;
    let image: number;
    if (output.unit === "token") {
      const tokens =
        tier === null
          ? gemini
            ? (GEMINI_TOKENS["1k"] ?? DEFAULT_TOKENS)
            : DEFAULT_TOKENS
          : ((gemini ? GEMINI_TOKENS : OTHER_TOKENS)[tier] ?? DEFAULT_TOKENS);
      image = output.cost_usd * tokens;
    } else if (output.unit === "megapixel") {
      image =
        output.cost_usd *
        (tier === null ? DEFAULT_MEGAPIXELS : (TIER_MEGAPIXELS[tier] ?? DEFAULT_MEGAPIXELS));
    } else {
      image = output.cost_usd;
    }
    const total = image + inputUsd(lines, refs);
    if (dearest === null || total > dearest) dearest = total;
  }
  // Rounded up to a hundredth of a cent, so the figure Isaac confirms is never below the estimate.
  return dearest === null ? null : Math.ceil(dearest * 10_000 - 1e-9) / 10_000;
}

/** Studio's view of a catalog model: its sizes (each tier at each aspect), reference counts, and a price line. */
export function studioModelOf(model: CatalogModel): StudioModel {
  const tiers = model.tiers.length > 0 ? model.tiers : [AUTO_RESOLUTION];
  const resolutions: StudioResolution[] = ASPECTS.flatMap((aspect) =>
    tiers.map((id) => ({
      id,
      label: id === AUTO_RESOLUTION ? "Default" : /^\d+$/.test(id) ? `${id} px` : id,
      aspect,
    })),
  );
  const from = estimateUsd(model, tiers[0] ?? AUTO_RESOLUTION, 0);
  const refs = Math.min(model.refs.max, BACKEND_BASE["openrouter-image"].refs);
  return {
    id: model.id,
    name: model.name.slice(0, 120),
    mode: "image",
    resolutions,
    seconds: [],
    frames: [],
    ...(from === null
      ? {}
      : {
          description: `About ${studioPriceLabel(from, "usd")} per image${refs > 0 ? `, takes up to ${String(refs)} reference image${refs === 1 ? "" : "s"}` : ""}`,
        }),
    refs,
    minRefs: Math.min(model.refs.min, refs),
  };
}

function rangeOf(descriptor: z.infer<typeof Descriptor> | undefined): {
  readonly min: number;
  readonly max: number;
} {
  return { min: descriptor?.min ?? 0, max: descriptor?.max ?? 0 };
}

const stringValues = (descriptor: z.infer<typeof Descriptor> | undefined): string[] =>
  (descriptor?.values ?? []).map(String);

/** The models of an Image API list that Studio can run, without prices yet. */
export function listedModels(body: unknown): Omit<CatalogModel, "endpoints">[] {
  const list = ModelList.safeParse(body);
  if (!list.success) throw new Error("OpenRouter sent a model list Relay could not read");
  const models: Omit<CatalogModel, "endpoints">[] = [];
  for (const item of list.data.data) {
    const parsed = ListedModel.safeParse(item);
    if (!parsed.success || !parsed.data.architecture.output_modalities.includes("image")) continue;
    const params = parsed.data.supported_parameters;
    const formats = stringValues(params["output_format"]);
    // Vector-only models make SVG, which Studio's gallery cannot show or edit.
    if (formats.length > 0 && formats.every((format) => format === "svg")) continue;
    models.push({
      id: parsed.data.id,
      name: parsed.data.name,
      aspects: stringValues(params["aspect_ratio"]),
      tiers: orderedTiers(stringValues(params["resolution"])),
      refs: rangeOf(params["input_references"]),
    });
  }
  return models;
}

/** The price lines of every endpoint in a `/images/models/<id>/endpoints` reply. */
export function endpointPrices(body: unknown): PriceLine[][] {
  const parsed = Endpoints.safeParse(body);
  if (!parsed.success) throw new Error("OpenRouter sent prices Relay could not read");
  return parsed.data.endpoints.map((endpoint) =>
    endpoint.pricing.flatMap((line) => {
      const price = PriceLine.safeParse(line);
      return price.success ? [price.data] : [];
    }),
  );
}

/** The request body for `spec` on `model`. `images` are JPEG bytes (references). */
export function imageRequestBody(
  model: CatalogModel,
  spec: StudioSpec,
  images: readonly Uint8Array[],
): Record<string, unknown> {
  const aspectRatio = nearestAspectRatio(spec.aspect, model.aspects);
  return {
    model: model.id,
    prompt:
      aspectRatio === undefined
        ? `${spec.prompt} ${ORIENTATION_SENTENCES[spec.aspect]}`
        : spec.prompt,
    ...(aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio }),
    ...(spec.resolution === AUTO_RESOLUTION ? {} : { resolution: spec.resolution }),
    ...(images.length > 0
      ? {
          input_references: images.map((bytes) => ({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` },
          })),
        }
      : {}),
  };
}

const Reply = z.object({
  data: z
    .array(
      z.object({
        b64_json: z.string().min(1).optional(),
        url: z.string().url().optional(),
        media_type: z.string().optional(),
      }),
    )
    .min(1),
  usage: z.object({ cost: z.number().nonnegative().optional() }).optional(),
});
const ErrorReply = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  message: z.string().optional(),
});

/** OpenRouter's own words for a failed request, in one line. */
function openrouterError(status: number, body: string): string {
  let said = body;
  try {
    const parsed = ErrorReply.safeParse(JSON.parse(body));
    if (parsed.success) {
      const { error, message } = parsed.data;
      said = (typeof error === "object" ? error.message : error) ?? message ?? body;
    }
  } catch {
    // Not JSON: the body as is.
  }
  return `OpenRouter refused (HTTP ${String(status)}): ${oneLine(said, 400) || "no reason given"}`;
}

/** The image's file extension and type from its first bytes; null for anything Studio does not keep. */
function imageType(bytes: Uint8Array): { readonly ext: string; readonly mimeType: string } | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { ext: "png", mimeType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { ext: "jpg", mimeType: "image/jpeg" };
  const riff = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (riff.startsWith("RIFF") && riff.endsWith("WEBP"))
    return { ext: "webp", mimeType: "image/webp" };
  return null;
}

/** Reads the API key from its file: trimmed; null when the file is missing or empty. */
export function readKeyFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export interface OpenRouterRunnerDeps {
  /** The API key (never logged); null when there is none. */
  readonly key: () => string | null;
  /** Where the key is looked for, for the reason shown when it is missing. */
  readonly keyHint: string;
  readonly fetch: Fetch;
  readonly now: () => number;
  /** An image file as JPEG bytes (reference images). */
  readonly jpeg: StudioMedia["jpeg"];
}

export class OpenRouterRunner implements StudioRunner {
  private catalog: {
    readonly at: number;
    readonly models: ReadonlyMap<string, CatalogModel>;
  } | null = null;
  private loading: Promise<ReadonlyMap<string, CatalogModel>> | null = null;
  private failedAt: number | null = null;

  constructor(private readonly deps: OpenRouterRunnerDeps) {}

  async describe(): Promise<StudioBackend> {
    const base = BACKEND_BASE["openrouter-image"];
    if (this.deps.key() === null)
      return {
        ...base,
        available: false,
        reason: `No OpenRouter key; put it in ${this.deps.keyHint}`,
      };
    try {
      const models = [...(await this.models()).values()];
      if (models.length === 0)
        return {
          ...base,
          available: false,
          reason: "OpenRouter lists no image models Studio can run",
        };
      return { ...base, available: true, models: models.map(studioModelOf) };
    } catch (error) {
      return { ...base, available: false, reason: oneLine(error, 400) };
    }
  }

  async quote(spec: StudioSpec): Promise<number> {
    const model = await this.model(spec.model);
    const usd = estimateUsd(model, spec.resolution, spec.refs?.length ?? 0);
    if (usd === null) throw new Error(`OpenRouter has no price for ${model.name}`);
    return usd;
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const { spec } = input;
    const key = this.deps.key();
    if (key === null) throw new Error(`No OpenRouter key; put it in ${this.deps.keyHint}`);
    const model = await this.model(spec.model);
    const images = await Promise.all(input.refs.map((path) => this.deps.jpeg(path)));
    input.note("Sending to OpenRouter");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]);
    const response = await this.deps.fetch(`${OPENROUTER_URL}/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Title": "Relay Studio",
      },
      body: JSON.stringify(imageRequestBody(model, spec, images)),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(openrouterError(response.status, text));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("OpenRouter sent a reply Relay could not read");
    }
    const reply = Reply.safeParse(json);
    const first = reply.success ? reply.data.data[0] : undefined;
    if (!reply.success || first === undefined) throw new Error("OpenRouter sent no image");
    let bytes: Uint8Array;
    if (first.b64_json !== undefined) {
      bytes = Buffer.from(first.b64_json, "base64");
    } else if (first.url !== undefined) {
      input.note("Downloading");
      const download = await this.deps.fetch(first.url, { method: "GET", signal });
      if (!download.ok)
        throw new Error(
          `Downloading the OpenRouter image failed (HTTP ${String(download.status)})`,
        );
      bytes = new Uint8Array(await download.arrayBuffer());
    } else {
      throw new Error("OpenRouter sent no image");
    }
    const type = imageType(bytes);
    if (type === null)
      throw new Error(`OpenRouter sent ${first.media_type ?? "a file"} Studio cannot keep`);
    const path = join(input.workDir, `out.${type.ext}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    const cost = reply.data.usage?.cost;
    return { path, mimeType: type.mimeType, ...(cost === undefined ? {} : { cost }) };
  }

  private async model(id: string | undefined): Promise<CatalogModel> {
    const model = id === undefined ? undefined : (await this.models()).get(id);
    if (model === undefined)
      throw new Error(`OpenRouter has no image model ${id ?? "(none picked)"}`);
    return model;
  }

  /** The priced image models: the kept list, or a fresh read when it is old (a failed read keeps the old list). */
  private models(): Promise<ReadonlyMap<string, CatalogModel>> {
    const now = this.deps.now();
    if (this.catalog !== null && now - this.catalog.at < CATALOG_TTL_MS)
      return Promise.resolve(this.catalog.models);
    if (this.loading !== null) return this.loading;
    if (this.failedAt !== null && now - this.failedAt < CATALOG_RETRY_MS && this.catalog !== null)
      return Promise.resolve(this.catalog.models);
    const loading = this.readCatalog().then(
      (models) => {
        this.catalog = { at: this.deps.now(), models };
        this.failedAt = null;
        this.loading = null;
        return models;
      },
      (error: unknown) => {
        this.failedAt = this.deps.now();
        this.loading = null;
        if (this.catalog !== null) return this.catalog.models;
        throw error instanceof Error ? error : new Error(String(error));
      },
    );
    this.loading = loading;
    return loading;
  }

  private async readCatalog(): Promise<ReadonlyMap<string, CatalogModel>> {
    const listed = await this.getJson(`${OPENROUTER_URL}/images/models`);
    const models = listedModels(listed);
    const priced = new Map<string, CatalogModel>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const model = models[next++];
        if (model === undefined) return;
        try {
          const endpoints = endpointPrices(
            await this.getJson(`${OPENROUTER_URL}/images/models/${model.id}/endpoints`),
          );
          const complete: CatalogModel = { ...model, endpoints };
          // Listed only with a price: Isaac confirms one before any job.
          if (estimateUsd(complete, model.tiers[0] ?? AUTO_RESOLUTION, 0) !== null)
            priced.set(model.id, complete);
        } catch {
          // A model whose prices cannot be read is left out until the next read.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRICE_READS_AT_ONCE, models.length) }, worker));
    // The default model first (a draft naming only the backend lands there), then by name.
    const sorted = [...priced.values()].sort(
      (a, b) =>
        Number(b.id === OPENROUTER_DEFAULT_MODEL) - Number(a.id === OPENROUTER_DEFAULT_MODEL) ||
        a.name.localeCompare(b.name),
    );
    return new Map(sorted.map((model) => [model.id, model]));
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.deps.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `OpenRouter's model list failed (HTTP ${String(response.status)}): ${oneLine(text, 200)}`,
      );
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("OpenRouter sent a model list Relay could not read");
    }
  }
}
