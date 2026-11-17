import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StudioSpec } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  CATALOG_TTL_MS,
  estimateUsd,
  imageRequestBody,
  listedModels,
  nearestAspectRatio,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_URL,
  OpenRouterRunner,
} from "../src/studio/openrouter";
import type { Fetch } from "../src/studio/codex";
import type { StudioRunInput } from "../src/studio/runner";
import { JPEG, PNG } from "./studio-fakes";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LISTED = {
  data: [
    {
      id: "google/gemini-nano-banana-2.1",
      name: "Google: Nano Banana 2.1",
      architecture: { output_modalities: ["image", "text"] },
      supported_parameters: {
        resolution: { type: "enum", values: ["2K", "4K", "1K"] },
        aspect_ratio: { type: "enum", values: ["1:1", "16:9", "9:16", "4:3"] },
        input_references: { type: "range", min: 0, max: 14 },
      },
    },
    {
      id: "acme/zebra",
      name: "Acme: Zebra",
      architecture: { output_modalities: ["image"] },
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1", "3:2", "2:3", "auto"] },
        input_references: { type: "range", min: 1, max: 2 },
      },
    },
    {
      id: "acme/vector",
      name: "Acme: Vector",
      architecture: { output_modalities: ["image"] },
      supported_parameters: { output_format: { type: "enum", values: ["svg"] } },
    },
    {
      id: "acme/unpriced",
      name: "Acme: Unpriced",
      architecture: { output_modalities: ["image"] },
      supported_parameters: {},
    },
    {
      id: "acme/text",
      name: "Acme: Text",
      architecture: { output_modalities: ["text"] },
      supported_parameters: {},
    },
  ],
};

const PRICES: Record<string, unknown> = {
  "google/gemini-nano-banana-2.1": {
    endpoints: [
      { pricing: [{ billable: "output_image", unit: "token", cost_usd: 0.00003 }] },
      {
        pricing: [
          { billable: "output_image", unit: "token", cost_usd: 0.00003 },
          { billable: "input_image", unit: "token", cost_usd: 0.0000003 },
        ],
      },
    ],
  },
  "acme/zebra": {
    endpoints: [
      {
        pricing: [
          { billable: "output_image", unit: "image", cost_usd: 0.04 },
          { billable: "input_image", unit: "image", cost_usd: 0.01 },
        ],
      },
    ],
  },
  "acme/unpriced": { endpoints: [] },
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** OpenRouter as the runner sees it: the model list, each model's prices, and the image endpoint answering `images`. */
function openrouter(
  images: () => Response = () =>
    Response.json({
      data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }],
      usage: { cost: 0.0391 },
    }),
): { readonly fetch: Fetch; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      if (url === `${OPENROUTER_URL}/images/models`) return Promise.resolve(Response.json(LISTED));
      const endpoints = /\/images\/models\/(.+)\/endpoints$/.exec(url)?.[1];
      if (endpoints !== undefined)
        return Promise.resolve(
          endpoints in PRICES
            ? Response.json(PRICES[endpoints])
            : new Response("nope", { status: 404 }),
        );
      if (url === `${OPENROUTER_URL}/images`) return Promise.resolve(images());
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    },
  };
}

function runner(
  fetch: Fetch,
  key: string | null = "sk-test",
  now: () => number = () => 0,
): OpenRouterRunner {
  return new OpenRouterRunner({
    key: () => key,
    keyHint: "/secrets/key",
    fetch,
    now,
    jpeg: () => Promise.resolve(JPEG),
  });
}

function spec(over: Partial<StudioSpec> = {}): StudioSpec {
  return {
    mode: "image",
    backend: "openrouter-image",
    model: OPENROUTER_DEFAULT_MODEL,
    prompt: "a red kite",
    aspect: "16:9",
    resolution: "1K",
    ...over,
  };
}

function input(over: Partial<StudioRunInput> = {}): StudioRunInput & { readonly notes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "relay-openrouter-"));
  dirs.push(dir);
  const notes: string[] = [];
  return {
    spec: spec(),
    frames: {},
    refs: [],
    workDir: dir,
    signal: new AbortController().signal,
    note: (text) => notes.push(text),
    blocked: () => undefined,
    notes,
    ...over,
  };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(typeof call?.init.body === "string" ? call.init.body : "null") as Record<
    string,
    unknown
  >;
}

describe("OpenRouter aspect and models", () => {
  it("maps our aspects to the nearest ratio a model lists", () => {
    expect(nearestAspectRatio("16:9", ["1:1", "3:2", "2:3", "auto"])).toBe("3:2");
    expect(nearestAspectRatio("9:16", ["1:1", "3:2", "2:3", "auto"])).toBe("2:3");
    expect(nearestAspectRatio("16:9", ["1:1", "21:9", "16:9"])).toBe("16:9");
    expect(nearestAspectRatio("1:1", ["auto"])).toBeUndefined();
    expect(nearestAspectRatio("1:1", [])).toBeUndefined();
  });

  it("lists image models only, leaves out vector-only ones, and offers the 1K tier first", () => {
    const models = listedModels(LISTED);
    expect(models.map((model) => model.id)).toEqual([
      "google/gemini-nano-banana-2.1",
      "acme/zebra",
      "acme/unpriced",
    ]);
    expect(models[0]?.tiers).toEqual(["1K", "2K", "4K"]);
    expect(models[1]).toMatchObject({ tiers: [], refs: { min: 1, max: 2 } });
  });
});

describe("OpenRouter price estimate", () => {
  const model = (lines: readonly unknown[][]) => ({
    id: "acme/m",
    endpoints: lines.map((pricing) => pricing) as never,
  });

  it("prices per image, per megapixel and per token at the tier picked, from the dearest endpoint", () => {
    expect(
      estimateUsd(model([[{ billable: "output_image", unit: "image", cost_usd: 0.04 }]]), "1K", 0),
    ).toBe(0.04);
    const tiered = model([
      [
        { billable: "output_image", unit: "image", cost_usd: 0.03 },
        { billable: "output_image", unit: "image", cost_usd: 0.06, variant: "2k" },
      ],
    ]);
    expect(estimateUsd(tiered, "1K", 0)).toBe(0.03);
    expect(estimateUsd(tiered, "2K", 0)).toBe(0.06);
    expect(
      estimateUsd(
        model([[{ billable: "output_image", unit: "megapixel", cost_usd: 0.03 }]]),
        "1K",
        0,
      ),
    ).toBe(0.0315);
    expect(
      estimateUsd(
        {
          id: "google/g",
          endpoints: [[{ billable: "output_image", unit: "token", cost_usd: 0.00003 }] as never],
        },
        "1K",
        0,
      ),
    ).toBe(0.0387);
    const two = model([
      [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
      [{ billable: "output_image", unit: "image", cost_usd: 0.05 }],
    ]);
    expect(estimateUsd(two, "auto", 0)).toBe(0.05);
  });

  it("adds the references' input price, and has no price without an output image line", () => {
    const lines = [
      [
        { billable: "output_image", unit: "image", cost_usd: 0.04 },
        { billable: "input_image", unit: "image", cost_usd: 0.01 },
      ],
    ];
    expect(estimateUsd(model(lines), "auto", 0)).toBe(0.04);
    expect(estimateUsd(model(lines), "auto", 3)).toBe(0.07);
    expect(estimateUsd(model([[]]), "1K", 0)).toBeNull();
    expect(estimateUsd(model([]), "1K", 0)).toBeNull();
  });
});

describe("OpenRouter runner", () => {
  it("is unavailable, with where the key goes, when there is no key", async () => {
    const { fetch, calls } = openrouter();
    expect(await runner(fetch, null).describe()).toMatchObject({
      id: "openrouter-image",
      paid: true,
      available: false,
      reason: "No OpenRouter key; put it in /secrets/key",
    });
    expect(calls).toEqual([]);
  });

  it("lists every priced image model with its sizes, references and price, the default first, and reads the catalog once", async () => {
    const { fetch, calls } = openrouter();
    let now = 0;
    const subject = runner(fetch, "sk-test", () => now);
    const backend = await subject.describe();
    expect(backend).toMatchObject({ available: true, paid: true, unit: "usd", seed: false });
    expect(backend.models?.map((model) => model.id)).toEqual([
      "google/gemini-nano-banana-2.1",
      "acme/zebra",
    ]);
    const [banana, zebra] = backend.models ?? [];
    expect(banana?.name).toBe("Google: Nano Banana 2.1");
    expect(
      banana?.resolutions
        .filter((resolution) => resolution.aspect === "9:16")
        .map((resolution) => resolution.id),
    ).toEqual(["1K", "2K", "4K"]);
    expect(banana?.description).toBe("About $0.0387 per image, takes up to 4 reference images");
    expect(banana).toMatchObject({ refs: 4, minRefs: 0 });
    expect(zebra?.resolutions.map((resolution) => [resolution.aspect, resolution.id])).toEqual([
      ["1:1", "auto"],
      ["16:9", "auto"],
      ["9:16", "auto"],
    ]);
    expect(zebra).toMatchObject({
      refs: 2,
      minRefs: 1,
      description: "About $0.04 per image, takes up to 2 reference images",
    });
    const reads = calls.length;
    await subject.describe();
    await subject.quote(spec());
    expect(calls).toHaveLength(reads);
    now = CATALOG_TTL_MS + 1;
    await subject.describe();
    expect(calls.length).toBeGreaterThan(reads);
    expect(
      calls.every((call) => !JSON.stringify(call.init.headers ?? {}).includes("sk-test")),
    ).toBe(true);
  });

  it("is unavailable with the reason when the model list cannot be read, and keeps the old list when a re-read fails", async () => {
    const down: Fetch = () => Promise.resolve(new Response("busy", { status: 503 }));
    expect(await runner(down).describe()).toMatchObject({
      available: false,
      reason: "OpenRouter's model list failed (HTTP 503): busy",
    });
    const { fetch } = openrouter();
    let broken = false;
    let now = 0;
    const subject = runner(
      (url, init) => (broken ? down(url, init) : fetch(url, init)),
      "sk-test",
      () => now,
    );
    await subject.describe();
    broken = true;
    now = CATALOG_TTL_MS + 1;
    expect(await subject.describe()).toMatchObject({ available: true });
  });

  it("quotes from model, size and reference count alone, so a confirmed price holds for any prompt", async () => {
    const subject = runner(openrouter().fetch);
    const base = await subject.quote(spec());
    expect(await subject.quote(spec({ prompt: "x".repeat(3000) }))).toBe(base);
    expect(await subject.quote(spec({ resolution: "4K" }))).toBeGreaterThan(base);
    expect(await subject.quote(spec({ refs: ["a", "b"] }))).toBeGreaterThan(base);
    await expect(subject.quote(spec({ model: "acme/nope" }))).rejects.toThrow(
      "OpenRouter has no image model acme/nope",
    );
  });

  it("asks images with the nearest aspect, the tier and references as JPEG data URLs, and reports the billed cost", async () => {
    const { fetch, calls } = openrouter();
    const subject = runner(fetch);
    const job = input({
      spec: spec({ refs: ["r1"], aspect: "9:16", resolution: "2K" }),
      refs: ["/r1.png"],
    });
    const output = await subject.run(job);
    expect(output).toEqual({
      path: join(job.workDir, "out.png"),
      mimeType: "image/png",
      cost: 0.0391,
    });
    expect(new Uint8Array(readFileSync(output.path))).toEqual(PNG);
    const call = calls.find((c) => c.url === `${OPENROUTER_URL}/images`);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
    expect(bodyOf(call)).toEqual({
      model: OPENROUTER_DEFAULT_MODEL,
      prompt: "a red kite",
      aspect_ratio: "9:16",
      resolution: "2K",
      input_references: [
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${Buffer.from(JPEG).toString("base64")}` },
        },
      ],
    });
    expect(job.notes).toContain("Sending to OpenRouter");
  });

  it("sends no resolution for 'auto', and tells a model with no aspect knob the orientation in the prompt", async () => {
    const { fetch, calls } = openrouter();
    await runner(fetch).run(
      input({
        spec: spec({ model: "acme/zebra", aspect: "1:1", resolution: "auto", refs: ["r1"] }),
        refs: ["/r1.png"],
      }),
    );
    const body = bodyOf(calls.find((c) => c.url === `${OPENROUTER_URL}/images`));
    expect(body).toMatchObject({ model: "acme/zebra", aspect_ratio: "1:1", prompt: "a red kite" });
    expect(body).not.toHaveProperty("resolution");
    const bare = {
      id: "acme/bare",
      name: "Acme: Bare",
      aspects: [],
      tiers: [],
      refs: { min: 0, max: 0 },
      endpoints: [],
    };
    expect(
      imageRequestBody(bare, spec({ model: "acme/bare", aspect: "9:16", resolution: "auto" }), []),
    ).toEqual({
      model: "acme/bare",
      prompt: "a red kite Tall portrait composition, 9:16.",
    });
  });

  it("keeps a JPEG or WebP as sent, downloads a linked image, and leaves the cost out when OpenRouter does not say", async () => {
    const jpeg = openrouter(() =>
      Response.json({ data: [{ b64_json: Buffer.from(JPEG).toString("base64") }] }),
    );
    const first = input();
    expect(await runner(jpeg.fetch).run(first)).toEqual({
      path: join(first.workDir, "out.jpg"),
      mimeType: "image/jpeg",
    });
    const webp = new Uint8Array([...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP"), 9]);
    const linked = openrouter(() =>
      Response.json({ data: [{ url: "https://cdn.example/x.webp" }] }),
    );
    const fetchLinked: Fetch = (url, init) =>
      url === "https://cdn.example/x.webp"
        ? Promise.resolve(new Response(webp))
        : linked.fetch(url, init);
    const second = input();
    expect(await runner(fetchLinked).run(second)).toEqual({
      path: join(second.workDir, "out.webp"),
      mimeType: "image/webp",
    });
  });

  it("fails in one line with OpenRouter's words, and refuses an image Studio cannot keep", async () => {
    const refused = openrouter(() =>
      Response.json(
        { error: { message: "Content moderated\nby the provider", code: 403 } },
        { status: 403 },
      ),
    );
    await expect(runner(refused.fetch).run(input())).rejects.toThrow(
      "OpenRouter refused (HTTP 403): Content moderated by the provider",
    );
    const svg = openrouter(() =>
      Response.json({
        data: [{ b64_json: Buffer.from("<svg/>").toString("base64"), media_type: "image/svg+xml" }],
      }),
    );
    await expect(runner(svg.fetch).run(input())).rejects.toThrow(
      "OpenRouter sent image/svg+xml Studio cannot keep",
    );
    await expect(runner(refused.fetch, null).run(input())).rejects.toThrow(
      "No OpenRouter key; put it in /secrets/key",
    );
  });
});
