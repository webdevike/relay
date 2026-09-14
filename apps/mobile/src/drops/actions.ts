/**
 * What a drop's bytes can do once they are on the phone. Image and file drops live on the host,
 * so every action here first pulls them into the cache under the drop's id; a second Share or
 * Save reuses that copy instead of fetching again. Text and links never come through here.
 */
import { Directory, File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import type { Drop, DropFile } from "@relay/protocol";

/** A drop whose bytes are fetchable: `image` and `file` kinds once the host filled `file` in. */
export type FileDrop = Drop & { readonly file: DropFile };

export function hasFile(drop: Drop): drop is FileDrop {
  return drop.file !== undefined;
}

/** The drop's bytes as a cached local file, fetched from the host on the first call. */
export async function downloadDrop(baseUrl: string, drop: FileDrop): Promise<File> {
  const folder = new Directory(Paths.cache, "drops", drop.id);
  folder.create({ intermediates: true, idempotent: true });
  const target = new File(folder, drop.file.name);
  if (!target.exists) await File.downloadFileAsync(`${baseUrl}${drop.file.path}`, target, { idempotent: true });
  return target;
}

/** Adds the image to the camera roll; `false` when the user declined the add-only permission. */
export async function saveToPhotos(file: File): Promise<boolean> {
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) return false;
  await MediaLibrary.saveToLibraryAsync(file.uri);
  return true;
}
