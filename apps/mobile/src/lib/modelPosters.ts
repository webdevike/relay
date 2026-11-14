/**
 * Still images of 3D models, so every model view that is not live (`lib/liveModel.ts`) still shows
 * its model. Once a live view has drawn, the app's root view is snapshotted (Skia's
 * `MakeImageFromViewTag`, already in the binary) and the model's frame cropped out of it, scaled to
 * at most `POSTER_WIDTH` px, and kept as a JPEG in the cache folder `model-posters/`, one file per
 * model `src`, at most `MAX_POSTERS` files (oldest go first). A snapshot that comes back blank
 * (SceneKit not drawn into it) is dropped, and the model is marked tried so the poster slot moves on.
 *
 * Why the root view and not the model's own: Skia's native side calls `RCTFatal` when the tag it
 * looks up on the main thread has no view, and a Fabric mount queued before the snapshot can still
 * apply a later commit that deletes the model's row first. The root view lives as long as the app.
 */
import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";
import { loadSkia } from "@/dictation/skia";
import type { Rect } from "@/lib/liveModel";

/** Poster files kept on the phone; each is a few tens of KB. */
export const MAX_POSTERS = 48;
/** Srcs remembered per run (disk misses, blank snapshots) before the oldest are forgotten. */
const MAX_REMEMBERED = 256;
/** Stored poster width, px: the live view is about 1080 px wide at 3x, 2x is plenty for a still. */
const POSTER_WIDTH = 720;
const JPEG_QUALITY = 85;
/** Pixels sampled to tell a real snapshot from a blank one. */
const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 24;
/** A frame that moved more than this between locating it and the snapshot gets no poster yet, pt. */
const DRIFT = 1;

/** The poster's file name for a model `src`: FNV-1a 32 of the src plus its length. */
export function posterName(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${String(key.length)}.jpg`;
}

/**
 * Whether straight RGBA pixels hold nothing: fully transparent, or one flat color (a Metal layer
 * the snapshot could not read comes back black). Both the alpha and the alpha-weighted luminance
 * must stay flat, so a dark model on a transparent background still counts.
 */
export function isBlankSnapshot(rgba: Uint8Array): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return true;
  let alpha = 0;
  let alphaSq = 0;
  let lum = 0;
  let lumSq = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const a = rgba[i + 3] ?? 0;
    const l = ((0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0)) * a) / 255;
    alpha += a;
    alphaSq += a * a;
    lum += l;
    lumSq += l * l;
  }
  const spread = (sum: number, sq: number) => Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
  return spread(alpha, alphaSq) < 2 && spread(lum, lumSq) < 2;
}

/** Names of the files past the newest `cap`, oldest last in the input order of age. */
export function postersOverCap(files: readonly { name: string; modified: number }[], cap: number = MAX_POSTERS): string[] {
  return [...files].sort((a, b) => b.modified - a.modified).slice(cap).map((file) => file.name);
}

/** `made` a poster, the snapshot was `blank` (no poster this run), or try again `later`. */
export type CaptureResult = "made" | "blank" | "later";

interface PosterStore {
  /** Model src -> poster file URI, for posters made or found this run. */
  files: ReadonlyMap<string, string>;
  /** Model srcs whose snapshot came back blank this run: no poster, and no more poster-slot turns. */
  tried: ReadonlySet<string>;
}

export const usePosterStore = create<PosterStore>(() => ({ files: new Map(), tried: new Set() }));

const folder = () => new Directory(Paths.cache, "model-posters");
/** Disk lookups already made this run (src -> file URI, or null when there was none). */
const onDisk = new Map<string, string | null>();

function markTried(key: string): void {
  usePosterStore.setState((state) => {
    const tried = new Set(state.tried).add(key);
    for (const old of tried) {
      if (tried.size <= MAX_REMEMBERED) break;
      tried.delete(old);
    }
    return { tried };
  });
}

/** The poster for a model `src`: made this run, or left on disk by an earlier one; null when none. */
export function usePoster(key: string): { uri: string | null; tried: boolean } {
  const made = usePosterStore((state) => state.files.get(key));
  const tried = usePosterStore((state) => state.tried.has(key));
  if (made !== undefined) return { uri: made, tried };
  if (!onDisk.has(key)) {
    let found: string | null = null;
    try {
      const file = new File(folder(), posterName(key));
      found = file.exists ? file.uri : null;
    } catch {
      found = null;
    }
    onDisk.set(key, found);
    for (const old of onDisk.keys()) {
      if (onDisk.size <= MAX_REMEMBERED) break;
      onDisk.delete(old);
    }
  }
  return { uri: onDisk.get(key) ?? null, tried };
}

function save(key: string, bytes: Uint8Array): void {
  const dir = folder();
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, posterName(key));
  file.write(bytes);
  onDisk.delete(key);
  usePosterStore.setState((state) => ({ files: new Map(state.files).set(key, file.uri) }));
  const listed = dir.list().filter((entry): entry is File => entry instanceof File);
  const drop = new Set(postersOverCap(listed.map((entry) => ({ name: entry.name, modified: entry.modificationTime ?? 0 }))));
  if (drop.size === 0) return;
  for (const entry of listed) if (drop.has(entry.name)) entry.delete();
  const gone = (uri: string | null) => uri !== null && drop.has(uri.slice(uri.lastIndexOf("/") + 1));
  for (const [src, uri] of onDisk) if (gone(uri)) onDisk.delete(src);
  usePosterStore.setState((state) => ({ files: new Map([...state.files].filter(([, uri]) => !gone(uri))) }));
}

let stopped = false;

/** The app is about to reload (OTA): no snapshot may start after this, the root view goes away. */
export function stopPosterCaptures(): void {
  stopped = true;
}

export interface PosterShot {
  /** The model `src` the poster is kept under. */
  key: string;
  /** The app's root tag (`RootTagContext`). */
  rootTag: number;
  /** Where the model's frame is in the window now, pt; null when it cannot tell. */
  locate: () => Promise<Rect | null>;
  /** Whether a frame there can be snapshotted now: the list at rest, the frame clear of all chrome. */
  clear: (rect: Rect) => boolean;
  /** Window width, pt (the root view's width). */
  windowWidth: number;
}

/**
 * Snapshots the root view, crops the model's frame out and keeps it as the poster for `key`.
 * `later` (nothing kept, nothing marked) when the frame is not clear or moved during the snapshot;
 * `blank` marks `key` tried.
 */
export async function capturePoster({ key, rootTag, locate, clear, windowWidth }: PosterShot): Promise<CaptureResult> {
  const before = await locate();
  if (before === null || !clear(before)) return "later";
  let result: CaptureResult = "blank";
  try {
    const skia = loadSkia();
    // Tag 0 is RootTagContext's default outside an app root: no view has it, and Skia would RCTFatal.
    if (skia === null || rootTag <= 0 || windowWidth <= 0) return result;
    const { Skia, ImageFormat, ColorType, AlphaType, FilterMode, MipmapMode } = skia;
    // Checked in the same tick as the native call: once a reload began, the root view may be detached.
    if (stopped) {
      result = "later";
      return result;
    }
    const screen = await Skia.Image.MakeImageFromViewTag(rootTag);
    if (screen === null) return result;
    try {
      const after = await locate();
      if (after === null || Math.abs(after.x - before.x) > DRIFT || Math.abs(after.y - before.y) > DRIFT) {
        result = "later";
        return result;
      }
      const px = screen.width() / windowWidth;
      const from = Skia.XYWHRect(before.x * px, before.y * px, before.width * px, before.height * px);
      if (from.x < 0 || from.y < 0 || from.x + from.width > screen.width() || from.y + from.height > screen.height()) {
        result = "later";
        return result;
      }
      const sample = Skia.Surface.Make(SAMPLE_WIDTH, SAMPLE_HEIGHT);
      sample?.getCanvas().drawImageRectOptions(screen, from, Skia.XYWHRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT), FilterMode.Linear, MipmapMode.None);
      const pixels = sample?.makeImageSnapshot().readPixels(0, 0, { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
      sample?.dispose();
      if (!(pixels instanceof Uint8Array) || isBlankSnapshot(pixels)) return result;
      const width = Math.round(Math.min(POSTER_WIDTH, from.width));
      const height = Math.round((from.height * width) / from.width);
      const surface = Skia.Surface.Make(width, height);
      if (surface === null) return result;
      surface.getCanvas().drawImageRectOptions(screen, from, Skia.XYWHRect(0, 0, width, height), FilterMode.Linear, MipmapMode.None);
      const still = surface.makeImageSnapshot();
      save(key, still.encodeToBytes(ImageFormat.JPEG, JPEG_QUALITY));
      still.dispose();
      surface.dispose();
      result = "made";
      return result;
    } finally {
      screen.dispose();
    }
  } catch {
    return result;
  } finally {
    if (result === "blank") markTried(key);
  }
}
