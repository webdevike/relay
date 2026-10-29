/**
 * Studio files on the phone: their host URLs, lookups by id, and what the viewer's actions do with
 * the bytes (download into the cache once, save to Photos, share, upload a reference frame).
 */
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { StudioAsset, StudioJob } from "@relay/protocol";
import { hostBaseUrl, studioRequest } from "@/connection";
import { useConnectionStore } from "@/state/connection";
import { choosePhoto } from "@/lib/photo";
import { mediaClock } from "@/lib/format";

/** Reference frames keep more detail than chat photos; the host scales them to the job. */
const UPLOAD_EDGE = 2048;

/** `http://host:port` of the connected host, or null; re-renders when the connection changes. */
export function useHostBase(): string | null {
  useConnectionStore((state) => state.status);
  return hostBaseUrl();
}

/** A finished output in the gallery with the job that made it. */
export interface GalleryItem {
  asset: StudioAsset;
  job: StudioJob;
}

/** Every finished output, newest job first. */
export function galleryItems(jobs: readonly StudioJob[]): GalleryItem[] {
  return jobs.filter((job) => job.state === "done").flatMap((job) => job.outputs.map((asset) => ({ asset, job })));
}

/** Outputs and uploads by id, to show what the composer's slots hold. */
export function assetsById(jobs: readonly StudioJob[], uploads: readonly StudioAsset[]): Map<string, StudioAsset> {
  const byId = new Map<string, StudioAsset>();
  for (const job of jobs) for (const output of job.outputs) byId.set(output.id, output);
  for (const upload of uploads) byId.set(upload.id, upload);
  return byId;
}

/** "0:05" for a video, undefined for an image. */
export function assetLength(asset: StudioAsset): string | undefined {
  return asset.durationMs === undefined ? undefined : mediaClock(asset.durationMs / 1000);
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

/** The asset's bytes as a cached local file, fetched from the host on the first call. */
export async function downloadAsset(baseUrl: string, asset: StudioAsset): Promise<File> {
  const folder = new Directory(Paths.cache, "studio", asset.id);
  folder.create({ intermediates: true, idempotent: true });
  const target = new File(folder, `${asset.id}.${EXTENSIONS[asset.mimeType] ?? asset.mimeType.split("/")[1] ?? "bin"}`);
  if (!target.exists) await File.downloadFileAsync(`${baseUrl}${asset.path}`, target, { idempotent: true });
  return target;
}

/** The system share sheet for a downloaded asset. */
export async function shareFile(file: File, mimeType: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(file.uri, { mimeType });
}

/** A library photo, scaled to 2048 px JPEG and kept on the host as an upload; null when Isaac backs out. */
export async function uploadFromDevice(): Promise<StudioAsset | null> {
  const photo = await choosePhoto("library", UPLOAD_EDGE);
  if (photo === null) return null;
  const result = await studioRequest({ kind: "upload", image: photo.image, name: "Phone photo" });
  if (!result.ok || result.asset === undefined) throw new Error(result.error ?? "Your Mac did not keep the photo.");
  return result.asset;
}
