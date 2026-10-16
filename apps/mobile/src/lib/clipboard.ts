import * as Clipboard from "expo-clipboard";
import type { Photo } from "@/lib/photo";
import type { PendingImage } from "@/dictation/machine";

/** A pasted screenshot re-encoded at this JPEG quality: sharp enough to read text, small enough for one frame. */
const JPEG_QUALITY = 0.85;
const DATA_URI_PREFIX = "data:image/jpeg;base64,";

/** The clipboard's image as a JPEG ready to attach, or null when it holds no image. */
export async function readClipboardImage(): Promise<PendingImage | null> {
  const image = await Clipboard.getImageAsync({ format: "jpeg", jpegQuality: JPEG_QUALITY });
  if (image === null) return null;
  const data = image.data.startsWith(DATA_URI_PREFIX)
    ? image.data.slice(DATA_URI_PREFIX.length)
    : image.data;
  if (data === "") return null;
  return { mimeType: "image/jpeg", data, width: image.size.width, height: image.size.height };
}

/** Whether the clipboard holds an image, without reading it (and so without iOS's paste prompt). */
export async function clipboardHasImage(): Promise<boolean> {
  return Clipboard.hasImageAsync();
}

/** The clipboard's image as a `Photo` (wire bytes plus a data-URI preview), or null when it holds none. */
export async function readClipboardPhoto(): Promise<Photo | null> {
  const pasted = await readClipboardImage();
  if (pasted === null) return null;
  return {
    image: { mimeType: pasted.mimeType, data: pasted.data },
    uri: `data:${pasted.mimeType};base64,${pasted.data}`,
    width: pasted.width,
    height: pasted.height,
  };
}

/** The clipboard's text, or null when it holds none (whitespace counts as none). */
export async function readClipboardText(): Promise<string | null> {
  if (!(await Clipboard.hasStringAsync())) return null;
  const text = await Clipboard.getStringAsync();
  return text.trim() === "" ? null : text;
}

export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}

/** Puts an image (base64, any format iOS decodes) on the clipboard. */
export async function copyImage(base64: string): Promise<void> {
  await Clipboard.setImageAsync(base64);
}
