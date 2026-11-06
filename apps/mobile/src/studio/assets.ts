/**
 * Studio files on the phone: their host URLs and what Save does with the bytes (download into the
 * cache once, then add to Photos).
 */
import { Directory, File, Paths } from "expo-file-system";
import type { StudioAsset } from "@relay/protocol";
import { hostBaseUrl } from "@/connection";
import { useConnectionStore } from "@/state/connection";
import { saveToPhotos } from "@/drops/actions";
import { mediaClock } from "@/lib/format";
import { toast } from "./actions";
import { imageCount } from "./library";

/** `http://host:port` of the connected host, or null; re-renders when the connection changes. */
export function useHostBase(): string | null {
  useConnectionStore((state) => state.status);
  return hostBaseUrl();
}

/** "0:05" for a video, undefined for an image. */
export function assetLength(asset: StudioAsset): string | undefined {
  return asset.durationMs === undefined ? undefined : mediaClock(asset.durationMs / 1000);
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

/** The asset's bytes as a cached local file, fetched from the host on the first call. */
async function downloadAsset(baseUrl: string, asset: StudioAsset): Promise<File> {
  const folder = new Directory(Paths.cache, "studio", asset.id);
  folder.create({ intermediates: true, idempotent: true });
  const target = new File(folder, `${asset.id}.${EXTENSIONS[asset.mimeType] ?? asset.mimeType.split("/")[1] ?? "bin"}`);
  if (!target.exists) await File.downloadFileAsync(`${baseUrl}${asset.path}`, target, { idempotent: true });
  return target;
}

/** Saves the files to Photos one by one and says how it went. */
export async function saveAssets(assets: readonly StudioAsset[]): Promise<void> {
  const base = hostBaseUrl();
  if (base === null) {
    toast("Not connected to your Mac.");
    return;
  }
  try {
    for (const asset of assets) {
      if (!(await saveToPhotos(await downloadAsset(base, asset)))) {
        toast("Relay needs Photos access in Settings");
        return;
      }
    }
    toast(assets.length === 1 ? "Saved to Photos" : `Saved ${imageCount(assets.length)} to Photos`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Something went wrong.");
  }
}
