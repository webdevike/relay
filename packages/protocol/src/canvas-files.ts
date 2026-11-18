// ---------------------------------------------------------------------------------------------
// Canvas boards served by the host: a desktop on another Mac (a thin client) keeps no boards of its
// own and reads and writes the host's boards folder (`<slug>.json`, the images beside them) through
// `canvas.file.req`, so every Mac opens the same board. The host answers each request with
// `canvas.file.res` (same `rid`) and tells every socket that sent `canvas.files.watch` when a board
// changes: `slug` for a board's text, null when a board came or went; `origin` is the writer's
// launch id for a write through these frames, null for a change made on the host itself (an agent,
// a live room). Only sent to a host whose `welcome.features` has CANVAS_FILES_FEATURE.
// ---------------------------------------------------------------------------------------------

import { z } from "zod";

export const CANVAS_FILES_FEATURE = "canvas.files";

/** A board's text at most this many characters. */
export const MAX_CANVAS_BOARD_TEXT = 8_000_000;
/** An image read or written through the frames at most this many bytes (before base64). */
export const MAX_CANVAS_ASSET_BYTES = 12 * 1024 * 1024;

export const CanvasSlug = z.string().regex(/^[a-z0-9-]{1,80}$/);
export const CanvasFileRid = z.string().min(1).max(64);

/**
 * `list`: every board's text and mtime. `read`: one board's text (null when there is none).
 * `write`: replaces a board's text atomically; with `ifRevision` (the sha1 hex of the text the
 * writer read, `none` for no board) only while the file is still that text, else it answers
 * `conflict` and writes nothing (the writer reads again and redoes its change). An older host
 * ignores `ifRevision`. `remove`: deletes a board (none is fine).
 * `exists`: whether a board is there. `history`: appends `text` (one line) to `<slug>.history.jsonl`.
 * `asset.read` / `asset.write`: an image file by `src`, relative to the boards folder (never
 * absolute, never `..`), its bytes as base64 in `data`.
 */
export const CanvasFileOp = z.enum([
  "list",
  "read",
  "write",
  "remove",
  "exists",
  "history",
  "asset.read",
  "asset.write",
]);
export type CanvasFileOp = z.infer<typeof CanvasFileOp>;

export const CanvasFileReq = z.object({
  t: z.literal("canvas.file.req"),
  rid: CanvasFileRid,
  op: CanvasFileOp,
  slug: CanvasSlug.optional(),
  text: z.string().max(MAX_CANVAS_BOARD_TEXT).optional(),
  src: z.string().min(1).max(1000).optional(),
  data: z
    .string()
    .max(Math.ceil((MAX_CANVAS_ASSET_BYTES * 4) / 3) + 4)
    .optional(),
  /** The writer's launch id, echoed in `canvas.files.changed`. */
  origin: z.string().min(1).max(200).optional(),
  /** `write`: land only while the board is still this revision (see above). */
  ifRevision: z.string().min(1).max(64).optional(),
});
export type CanvasFileReq = z.infer<typeof CanvasFileReq>;

export const CanvasFileEntry = z.object({
  slug: CanvasSlug,
  text: z.string().max(MAX_CANVAS_BOARD_TEXT),
  modifiedMs: z.number(),
});
export type CanvasFileEntry = z.infer<typeof CanvasFileEntry>;

export const CanvasFileRes = z.object({
  t: z.literal("canvas.file.res"),
  rid: CanvasFileRid,
  ok: z.boolean(),
  /** `read`: the board's text, null when there is none. */
  text: z.string().max(MAX_CANVAS_BOARD_TEXT).nullable().optional(),
  /** `list`: every board. */
  files: z.array(CanvasFileEntry).max(5000).optional(),
  /** `exists`. */
  exists: z.boolean().optional(),
  /** `asset.read`: the file's bytes as base64. */
  data: z.string().optional(),
  /** `conflict`: a `write` whose `ifRevision` the board no longer is. */
  code: z.enum(["not-found", "invalid", "too-large", "internal", "conflict"]).optional(),
  error: z.string().max(2000).optional(),
});
export type CanvasFileRes = z.infer<typeof CanvasFileRes>;

/** Frames a desktop sends. */
export const CanvasFilesClientFrames = [
  CanvasFileReq,
  /** Get `canvas.files.changed` from now on. */
  z.object({ t: z.literal("canvas.files.watch") }),
] as const;

/** Frames the host sends. */
export const CanvasFilesServerFrames = [
  CanvasFileRes,
  z.object({
    t: z.literal("canvas.files.changed"),
    slug: CanvasSlug.nullable(),
    origin: z.string().min(1).max(200).nullable(),
  }),
] as const;
