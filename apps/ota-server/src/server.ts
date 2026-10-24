import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "./config";
import {
  assetUrl,
  buildManifest,
  isPlatform,
  isSafeSegment,
  latestUpdate,
  multipartMixed,
  platformDir,
  type Manifest,
  type UpdateRef,
} from "./updates";

const protocolHeaders = {
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
  "cache-control": "private, max-age=0",
};

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Update directories never change once renamed into place, so each manifest is built once. */
const manifests = new Map<string, Promise<Manifest>>();

function manifestFor(update: UpdateRef, publicUrl: string): Promise<Manifest> {
  let manifest = manifests.get(update.dir);
  if (manifest === undefined) {
    manifest = buildManifest(update, publicUrl);
    manifests.set(update.dir, manifest);
    manifest.catch(() => manifests.delete(update.dir));
  }
  return manifest;
}

async function manifestResponse(request: Request, url: URL, config: ServerConfig): Promise<Response> {
  const protocol = request.headers.get("expo-protocol-version");
  if (protocol !== null && protocol !== "1") return text(406, `Unsupported expo-protocol-version ${protocol}`);
  // Query parameters stand in for the headers so a browser or plain curl can inspect the feed.
  const platform = request.headers.get("expo-platform") ?? url.searchParams.get("platform");
  const runtimeVersion = request.headers.get("expo-runtime-version") ?? url.searchParams.get("runtime-version");
  if (!isPlatform(platform)) return text(400, "expo-platform must be ios or android");
  if (runtimeVersion === null || !isSafeSegment(runtimeVersion)) return text(400, "Missing or invalid expo-runtime-version");

  const update = await latestUpdate(config.dataRoot, runtimeVersion, platform);
  if (update === null) return text(404, `No update published for runtime ${runtimeVersion} on ${platform}`);
  const manifest = await manifestFor(update, config.publicUrl);

  const accept = request.headers.get("accept") ?? "*/*";
  if (accept.includes("multipart/mixed") || accept.includes("*/*")) {
    const current = request.headers.get("expo-current-update-id");
    const part =
      current?.toLowerCase() === manifest.id
        ? ({ name: "directive", body: { type: "noUpdateAvailable" } } as const)
        : ({ name: "manifest", body: manifest } as const);
    const boundary = `relay-ota-${randomUUID()}`;
    return new Response(multipartMixed([part], boundary), {
      headers: { ...protocolHeaders, "content-type": `multipart/mixed; boundary=${boundary}` },
    });
  }
  const json = accept.includes("application/expo+json")
    ? "application/expo+json"
    : accept.includes("application/json")
      ? "application/json"
      : null;
  if (json === null) return text(406, "Accept multipart/mixed, application/expo+json or application/json");
  return new Response(JSON.stringify(manifest), { headers: { ...protocolHeaders, "content-type": json } });
}

/**
 * `/assets/<runtimeVersion>/<platform>/<stamp>/<path inside the export>`, immutable. Only files the
 * update's manifest lists are served, with the content type the manifest gives them (exported
 * assets are named by hash, without an extension).
 */
async function assetResponse(segments: string[], config: ServerConfig): Promise<Response> {
  const [runtimeVersion, platform, stamp, ...rest] = segments;
  if (
    runtimeVersion === undefined ||
    !isSafeSegment(runtimeVersion) ||
    !isPlatform(platform) ||
    stamp === undefined ||
    !/^\d+$/.test(stamp) ||
    !rest.every(isSafeSegment)
  ) {
    return text(404, "Not found");
  }
  const dir = path.join(platformDir(config.dataRoot, runtimeVersion, platform), stamp);
  const update: UpdateRef = { runtimeVersion, platform, stamp, dir };
  let manifest: Manifest;
  try {
    manifest = await manifestFor(update, config.publicUrl);
  } catch {
    return text(404, "Not found");
  }
  const target = assetUrl(config.publicUrl, update, rest.join("/"));
  const asset = [manifest.launchAsset, ...manifest.assets].find((candidate) => candidate.url === target);
  if (asset === undefined) return text(404, "Not found");
  const data = await readFile(path.join(dir, ...rest));
  return new Response(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
    headers: { "content-type": asset.contentType, "cache-control": "public, max-age=31536000, immutable" },
  });
}

export async function handle(request: Request, config: ServerConfig): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  const url = new URL(request.url);
  if (url.pathname === "/health") return text(200, "ok");
  if (url.pathname === "/api/manifest") return manifestResponse(request, url, config);
  if (url.pathname.startsWith("/assets/")) {
    const segments = url.pathname.slice("/assets/".length).split("/").map(decodeURIComponent);
    return assetResponse(segments, config);
  }
  return text(404, "Not found");
}
