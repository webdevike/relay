import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config";
import { handle } from "../src/server";
import { buildManifest, latestUpdate, multipartMixed, uuidFromSha256, type Manifest } from "../src/updates";

const publicUrl = "https://ota.example.ts.net:8447";
let config: ServerConfig;

const bundle = "_expo/static/js/ios/entry-abc.hbc";
const png = "assets/7d40544b395c5949f4646f5e150fe020";

async function writeUpdate(stamp: string, bundleText: string, withMetadata = true): Promise<void> {
  const dir = path.join(config.dataRoot, "updates", "0.1.0", "ios", stamp);
  await mkdir(path.join(dir, "_expo/static/js/ios"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, bundle), bundleText);
  await writeFile(path.join(dir, png), "png-bytes");
  await writeFile(path.join(dir, "expoConfig.json"), JSON.stringify({ name: "Relay", version: "0.1.0" }));
  if (!withMetadata) return;
  // expo export repeats an asset once per importing module.
  const metadata = {
    version: 0,
    bundler: "metro",
    fileMetadata: { ios: { bundle, assets: [{ path: png, ext: "png" }, { path: png, ext: "png" }] } },
  };
  await writeFile(path.join(dir, "metadata.json"), JSON.stringify(metadata));
}

const get = (pathname: string, headers: Record<string, string> = {}): Promise<Response> =>
  handle(new Request(`http://127.0.0.1:8477${pathname}`, { headers }), config);

const manifestHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  "expo-protocol-version": "1",
  "expo-platform": "ios",
  "expo-runtime-version": "0.1.0",
  accept: "application/expo+json;q=0.9, application/json;q=0.8, multipart/mixed",
  ...extra,
});

/** The JSON parts of a multipart/mixed body, by name. */
async function parts(response: Response): Promise<Record<string, unknown>> {
  const boundary = /boundary=(.+)$/.exec(response.headers.get("content-type") ?? "")?.[1];
  if (boundary === undefined) throw new Error("no boundary");
  const body = await response.text();
  const result: Record<string, unknown> = {};
  for (const chunk of body.split(`--${boundary}`).slice(1, -1)) {
    const [head = "", json = ""] = chunk.split("\r\n\r\n");
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? "";
    result[name] = JSON.parse(json.trim());
  }
  return result;
}

beforeAll(async () => {
  config = { dataRoot: await mkdtemp(path.join(os.tmpdir(), "relay-ota-")), port: 0, publicUrl };
  await writeUpdate("1000", "old bundle");
  await writeUpdate("2000", "new bundle");
  // Newer but still being published: no metadata.json yet.
  await writeUpdate("3000", "half copied", false);
  await mkdir(path.join(config.dataRoot, "updates", "0.1.0", "ios", ".staging-4000"));
});

afterAll(async () => {
  await rm(config.dataRoot, { recursive: true, force: true });
});

describe("latestUpdate", () => {
  it("picks the newest complete update and ignores staging dirs", async () => {
    expect((await latestUpdate(config.dataRoot, "0.1.0", "ios"))?.stamp).toBe("2000");
  });

  it("returns null for an unknown runtime or an unsafe one", async () => {
    expect(await latestUpdate(config.dataRoot, "9.9.9", "ios")).toBeNull();
    expect(await latestUpdate(config.dataRoot, "..", "ios")).toBeNull();
  });
});

describe("buildManifest", () => {
  it("describes the bundle and assets the way expo export does", async () => {
    const update = await latestUpdate(config.dataRoot, "0.1.0", "ios");
    if (update === null) throw new Error("no update");
    const manifest = await buildManifest(update, publicUrl);

    expect(manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(manifest.createdAt).toBe(new Date(2000).toISOString());
    expect(manifest.runtimeVersion).toBe("0.1.0");
    expect(manifest.metadata).toEqual({});
    expect(manifest.extra).toEqual({ expoClient: { name: "Relay", version: "0.1.0" } });

    expect(manifest.launchAsset).toEqual({
      hash: createHash("sha256").update("new bundle").digest("base64url"),
      key: createHash("md5").update("new bundle").digest("hex"),
      contentType: "application/javascript",
      url: `${publicUrl}/assets/0.1.0/ios/2000/_expo/static/js/ios/entry-abc.hbc`,
    });
    expect(manifest.assets).toEqual([
      {
        hash: createHash("sha256").update("png-bytes").digest("base64url"),
        key: createHash("md5").update("png-bytes").digest("hex"),
        contentType: "image/png",
        fileExtension: ".png",
        url: `${publicUrl}/assets/0.1.0/ios/2000/${png}`,
      },
    ]);
  });

  it("derives the id from metadata.json and the expo config", async () => {
    const at = (stamp: string) => ({
      runtimeVersion: "0.1.0",
      platform: "ios" as const,
      stamp,
      dir: path.join(config.dataRoot, "updates", "0.1.0", "ios", stamp),
    });
    // Fixtures 1000 and 2000 share both files (real exports hash the bundle into its file name).
    const older = await buildManifest(at("1000"), publicUrl);
    expect((await buildManifest(at("2000"), publicUrl)).id).toBe(older.id);

    await writeUpdate("1500", "old bundle");
    await writeFile(path.join(at("1500").dir, "expoConfig.json"), JSON.stringify({ name: "Relay 2" }));
    expect((await buildManifest(at("1500"), publicUrl)).id).not.toBe(older.id);
  });

  it("formats any digest as a version 8 UUID", () => {
    expect(uuidFromSha256("f".repeat(64))).toBe("ffffffff-ffff-8fff-bfff-ffffffffffff");
    expect(uuidFromSha256("0".repeat(64))).toBe("00000000-0000-8000-8000-000000000000");
  });
});

describe("multipartMixed", () => {
  it("frames JSON parts with content-disposition names", () => {
    expect(multipartMixed([{ name: "directive", body: { type: "noUpdateAvailable" } }], "b")).toBe(
      '--b\r\ncontent-type: application/json; charset=utf-8\r\ncontent-disposition: form-data; name="directive"\r\n\r\n{"type":"noUpdateAvailable"}\r\n--b--\r\n',
    );
  });
});

describe("handle", () => {
  it("serves the newest manifest as multipart/mixed with protocol headers", async () => {
    const response = await get("/api/manifest", manifestHeaders());
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    const manifest = (await parts(response))["manifest"] as Manifest;
    expect(manifest.createdAt).toBe(new Date(2000).toISOString());
  });

  it("answers noUpdateAvailable when the client already runs the newest update", async () => {
    const first = (await parts(await get("/api/manifest", manifestHeaders())))["manifest"] as Manifest;
    const response = await get("/api/manifest", manifestHeaders({ "expo-current-update-id": first.id }));
    expect(await parts(response)).toEqual({ directive: { type: "noUpdateAvailable" } });
  });

  it("serves JSON when multipart is not accepted", async () => {
    const response = await get("/api/manifest", manifestHeaders({ accept: "application/expo+json" }));
    expect(response.headers.get("content-type")).toBe("application/expo+json");
    expect(((await response.json()) as Manifest).runtimeVersion).toBe("0.1.0");
  });

  it("rejects bad requests and says when nothing is published", async () => {
    expect((await get("/api/manifest", manifestHeaders({ "expo-platform": "web" }))).status).toBe(400);
    expect((await get("/api/manifest", manifestHeaders({ "expo-protocol-version": "0" }))).status).toBe(406);
    const missing = await get("/api/manifest", manifestHeaders({ "expo-runtime-version": "9.9.9" }));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("No update published for runtime 9.9.9 on ios");
  });

  it("serves manifest assets with their content type and nothing else", async () => {
    const manifest = (await parts(await get("/api/manifest", manifestHeaders())))["manifest"] as Manifest;
    const asset = manifest.assets[0];
    if (asset === undefined) throw new Error("no asset");
    const response = await get(new URL(asset.url).pathname);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("base64url")).toBe(asset.hash);

    const bundleResponse = await get(new URL(manifest.launchAsset.url).pathname);
    expect(bundleResponse.headers.get("content-type")).toBe("application/javascript");
    expect(await bundleResponse.text()).toBe("new bundle");

    expect((await get("/assets/0.1.0/ios/2000/expoConfig.json")).status).toBe(404);
    expect((await get("/assets/0.1.0/ios/2000/..%2F1000%2Fmetadata.json")).status).toBe(404);
  });
});
