/**
 * Save to Photos, Copy (images only) and Share for any image or video the app shows: a host drop,
 * an https URL, an attachment's data URI or a local file. `openMediaActions` is the action sheet a
 * long press (or a viewer's share button) opens. Remote bytes are fetched once into the cache under
 * a hash of their URL and named by what they are (sniffed from their first bytes, since a drop URL
 * carries no extension and Photos goes by the file's extension). Each action ends in a short notice
 * (`state/mediaNotice.ts`): a success, or one line saying what failed.
 */
import { ActionSheetIOS, Share } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { warn } from "@/connection/log";
import { PHOTOS_DENIED, photosAccess, saveToPhotos } from "@/drops/actions";
import { copyImage } from "@/lib/clipboard";
import { notifyHaptic } from "@/lib/haptics";
import { useMediaNotice } from "@/state/mediaNotice";

export interface MediaRef {
  /** http(s) URL, `data:` URI or `file://` URI. */
  uri: string;
  kind: "image" | "video";
}

/** Bytes needed to tell the formats below apart. */
const SNIFF_BYTES = 16;

/** The file extension for media bytes from their start, or null when they are none of these. */
export function sniffExtension(head: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "qt  ") return "mov";
    if (brand === "avif") return "avif";
    if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
    return "mp4";
  }
  return null;
}

const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** The fallback when the bytes don't say: Photos takes a JPEG or an MP4 name for most of what is shown. */
const KIND_EXTENSION = { image: "jpg", video: "mp4" } as const;

/** FNV-1a 32 of the URI with its length: one cache folder per piece of media. */
function mediaKey(uri: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uri.length; i++) {
    hash ^= uri.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${uri.length.toString(16)}`;
}

/**
 * The media as a named local file: a `file://` URI as is, a data URI written out, a remote one
 * downloaded once (`onDownload` runs just before a fetch, so a slow video can say so).
 */
export async function mediaFile(media: MediaRef, onDownload?: () => void): Promise<File> {
  if (media.uri.startsWith("file://")) return new File(media.uri);
  const folder = new Directory(Paths.cache, "media", mediaKey(media.uri));
  folder.create({ intermediates: true, idempotent: true });
  const cached = folder.list().find((entry): entry is File => entry instanceof File && entry.name !== "download");
  if (cached !== undefined) return cached;
  const data = /^data:([^;,]+);base64,/.exec(media.uri);
  if (data !== null) {
    const file = new File(folder, `relay-${media.kind}.${MIME_EXTENSION[data[1] ?? ""] ?? KIND_EXTENSION[media.kind]}`);
    file.write(media.uri.slice(data[0].length), { encoding: "base64" });
    return file;
  }
  onDownload?.();
  const file = new File(folder, "download");
  await File.downloadFileAsync(media.uri, file, { idempotent: true });
  const handle = file.open();
  let head: Uint8Array;
  try {
    head = handle.readBytes(SNIFF_BYTES);
  } finally {
    handle.close();
  }
  file.rename(`relay-${media.kind}.${sniffExtension(head) ?? KIND_EXTENSION[media.kind]}`);
  return file;
}

function say(notice: string): void {
  useMediaNotice.getState().say(notice);
}

/** The local file, or null after saying the fetch failed. */
async function fetched(media: MediaRef): Promise<File | null> {
  try {
    return await mediaFile(media, () => {
      if (media.kind === "video") say("Downloading video…");
    });
  } catch (error) {
    warn("media", "download failed", error);
    say(`Couldn't download the ${media.kind}`);
    return null;
  }
}

/** Saves to Photos, asking for add-only access the first time; a refusal fetches nothing. */
export async function saveMedia(media: MediaRef): Promise<void> {
  try {
    if (!(await photosAccess())) {
      say(PHOTOS_DENIED);
      return;
    }
  } catch (error) {
    warn("media", "photos access failed", error);
    say("Couldn't reach Photos");
    return;
  }
  const file = await fetched(media);
  if (file === null) return;
  try {
    if (!(await saveToPhotos(file))) {
      say(PHOTOS_DENIED);
      return;
    }
  } catch (error) {
    warn("media", "save failed", error);
    say(`Photos couldn't save this ${media.kind}`);
    return;
  }
  notifyHaptic("success");
  say("Saved to Photos");
}

/** Puts the image on the clipboard. */
export async function copyMedia(media: MediaRef): Promise<void> {
  const file = await fetched(media);
  if (file === null) return;
  try {
    await copyImage(await file.base64());
  } catch (error) {
    warn("media", "copy failed", error);
    say("Couldn't copy the image");
    return;
  }
  notifyHaptic("success");
  say("Copied");
}

/** Opens the share sheet with the file itself, so Save to Files, AirDrop and Messages get the bytes. */
export async function shareMedia(media: MediaRef): Promise<void> {
  const file = await fetched(media);
  if (file === null) return;
  try {
    await Share.share({ url: file.uri });
  } catch (error) {
    warn("media", "share failed", error);
    say(`Couldn't share the ${media.kind}`);
  }
}

/** The action sheet for one image or video: Save to Photos, Copy (images), Share. */
export function openMediaActions(media: MediaRef): void {
  const actions: { label: string; run: (media: MediaRef) => Promise<void> }[] = [
    { label: "Save to Photos", run: saveMedia },
    ...(media.kind === "image" ? [{ label: "Copy", run: copyMedia }] : []),
    { label: "Share…", run: shareMedia },
  ];
  ActionSheetIOS.showActionSheetWithOptions(
    { options: [...actions.map((action) => action.label), "Cancel"], cancelButtonIndex: actions.length },
    (index) => {
      void actions[index]?.run(media);
    },
  );
}
