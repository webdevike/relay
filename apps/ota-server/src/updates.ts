import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Expo Updates protocol v1 types (https://docs.expo.dev/technical-specs/expo-updates-1/). */
export type Platform = "ios" | "android";

export interface ManifestAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension?: string;
  url: string;
}

export interface Manifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: ManifestAsset;
  assets: ManifestAsset[];
  metadata: Record<string, string>;
  extra: { expoClient: unknown };
}

/** One published update: `<dataRoot>/updates/<runtimeVersion>/<platform>/<stamp>/`. */
export interface UpdateRef {
  runtimeVersion: string;
  platform: Platform;
  /** Publish time in epoch milliseconds; the directory name. */
  stamp: string;
  dir: string;
}

export const LAUNCH_ASSET_CONTENT_TYPE = "application/javascript";

const contentTypes: Record<string, string> = {
  hbc: LAUNCH_ASSET_CONTENT_TYPE,
  js: LAUNCH_ASSET_CONTENT_TYPE,
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  glb: "model/gltf-binary",
  html: "text/html",
  css: "text/css",
};

export function contentTypeFor(ext: string): string {
  return contentTypes[ext.toLowerCase()] ?? "application/octet-stream";
}

/** Runtime versions become directory names, so only plain version-like strings are accepted. */
export function isSafeSegment(segment: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(segment) && segment !== "." && segment !== "..";
}

export function isPlatform(value: string | null | undefined): value is Platform {
  return value === "ios" || value === "android";
}

export function platformDir(dataRoot: string, runtimeVersion: string, platform: Platform): string {
  return path.join(dataRoot, "updates", runtimeVersion, platform);
}

/**
 * The newest complete update for a runtime and platform. Publishing stages into a dot directory
 * and renames it into place, so a directory named by digits with a metadata.json is complete.
 */
export async function latestUpdate(
  dataRoot: string,
  runtimeVersion: string,
  platform: Platform,
): Promise<UpdateRef | null> {
  if (!isSafeSegment(runtimeVersion)) return null;
  const parent = platformDir(dataRoot, runtimeVersion, platform);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const stamps = names.filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
  for (const stamp of stamps) {
    const dir = path.join(parent, stamp);
    try {
      await access(path.join(dir, "metadata.json"));
      return { runtimeVersion, platform, stamp, dir };
    } catch {
      continue;
    }
  }
  return null;
}

/** RFC 9562 version 8 (custom) UUID laid over the first 128 bits of a SHA-256 digest. */
export function uuidFromSha256(hex: string): string {
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  const h = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface ExportAsset {
  path: string;
  ext: string;
}

/** The parts of `expo export`'s metadata.json the manifest needs. */
function exportFiles(metadata: unknown, platform: Platform): { bundle: string; assets: ExportAsset[] } {
  const files = (metadata as { fileMetadata?: Record<string, { bundle?: unknown; assets?: unknown }> } | null)
    ?.fileMetadata?.[platform];
  if (typeof files?.bundle !== "string" || !Array.isArray(files.assets)) {
    throw new Error(`metadata.json has no ${platform} bundle`);
  }
  const assets = (files.assets as unknown[]).map((asset) => {
    const { path: assetPath, ext } = asset as Partial<ExportAsset>;
    if (typeof assetPath !== "string" || typeof ext !== "string") throw new Error("metadata.json asset without path/ext");
    return { path: assetPath, ext };
  });
  return { bundle: files.bundle, assets };
}

/** URL of a file inside an update, served by the `/assets/...` route. */
export function assetUrl(publicUrl: string, update: UpdateRef, relativePath: string): string {
  const segments = [update.runtimeVersion, update.platform, update.stamp, ...relativePath.split("/")];
  return `${publicUrl}/assets/${segments.map(encodeURIComponent).join("/")}`;
}

async function describeAsset(
  update: UpdateRef,
  publicUrl: string,
  relativePath: string,
  contentType: string,
): Promise<ManifestAsset> {
  const data = await readFile(path.join(update.dir, relativePath));
  return {
    hash: createHash("sha256").update(data).digest("base64url"),
    key: createHash("md5").update(data).digest("hex"),
    contentType,
    url: assetUrl(publicUrl, update, relativePath),
  };
}

/**
 * Builds the manifest of one update from its `expo export` output and the public expo config
 * captured at publish (`expoConfig.json`). The id hashes both, so republishing identical output
 * keeps the id and clients see nothing new.
 */
export async function buildManifest(update: UpdateRef, publicUrl: string): Promise<Manifest> {
  const metadataBytes = await readFile(path.join(update.dir, "metadata.json"));
  const configBytes = await readFile(path.join(update.dir, "expoConfig.json"));
  const files = exportFiles(JSON.parse(metadataBytes.toString("utf8")), update.platform);

  // expo export lists an asset once per module that imports it; the client stores each key once.
  const unique = new Map(files.assets.map((asset) => [asset.path, asset]));
  const [launchAsset, assets] = await Promise.all([
    describeAsset(update, publicUrl, files.bundle, LAUNCH_ASSET_CONTENT_TYPE),
    Promise.all(
      [...unique.values()].map(async (asset) => ({
        ...(await describeAsset(update, publicUrl, asset.path, contentTypeFor(asset.ext))),
        fileExtension: `.${asset.ext}`,
      })),
    ),
  ]);

  const id = createHash("sha256").update(metadataBytes).update(configBytes).digest("hex");
  return {
    id: uuidFromSha256(id),
    createdAt: new Date(Number(update.stamp)).toISOString(),
    runtimeVersion: update.runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: { expoClient: JSON.parse(configBytes.toString("utf8")) as unknown },
  };
}

export interface MultipartPart {
  name: "manifest" | "directive" | "extensions";
  body: unknown;
}

/** A `multipart/mixed` body as expo-updates parses it: JSON parts named by content-disposition. */
export function multipartMixed(parts: MultipartPart[], boundary: string): string {
  const encoded = parts.map(
    (part) =>
      `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n` +
      `content-disposition: form-data; name="${part.name}"\r\n\r\n${JSON.stringify(part.body)}\r\n`,
  );
  return `${encoded.join("")}--${boundary}--\r\n`;
}
