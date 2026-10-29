// Drop bytes over HTTP with single byte-range support. iOS AVPlayer (the phone's expo-video) only
// plays a URL whose server answers its `Range: bytes=0-1` probe with a 206, and seeking or
// resuming a video asks for arbitrary ranges; HEAD answers the same headers without a body.

import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { DropBlob } from "../seams";

/** Whether `given` is the blob token `expected`, compared in constant time. */
export function sameToken(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A blob's GET/HEAD response: 200 whole, 206 for a satisfiable single range, 416 past the end. */
export function serveBlob(request: Request, blob: DropBlob): Response {
  const media = /^(image|video|audio)\//.test(blob.mimeType);
  const headers = new Headers({
    "content-type": blob.mimeType,
    "accept-ranges": "bytes",
    "content-disposition": `${media ? "inline" : "attachment"}; filename="${encodeURIComponent(blob.name)}"`,
  });
  const range = byteRange(request.headers.get("range"), blob.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${String(blob.size)}`);
    return new Response(null, { status: 416, headers });
  }
  const head = request.method === "HEAD";
  const [start, end] = range ?? [0, blob.size - 1];
  // Under Bun the body is a Bun.file slice: sent with sendfile and a Content-Length. A stream body
  // goes out chunked, which AVPlayer won't play from. Node (the vitest suite) has no Bun.file.
  const body = (): Blob | ReadableStream =>
    typeof Bun === "undefined"
      ? (Readable.toWeb(createReadStream(blob.path, { start, end })) as ReadableStream)
      : Bun.file(blob.path).slice(start, end + 1);
  if (range === null) {
    headers.set("content-length", String(blob.size));
    return new Response(head || blob.size === 0 ? null : body(), { status: 200, headers });
  }
  headers.set("content-range", `bytes ${String(start)}-${String(end)}/${String(blob.size)}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(head ? null : body(), { status: 206, headers });
}

/**
 * The inclusive `[start, end]` a `Range` header asks of `size` bytes: `bytes=a-b`, `bytes=a-` or
 * the suffix `bytes=-n`, the end clamped to the last byte. null (serve it all, as RFC 9110
 * allows) for no header, another unit, several ranges or a malformed one; "unsatisfiable" when
 * the range starts past the end.
 */
export function byteRange(header: string | null, size: number): readonly [number, number] | null | "unsatisfiable" {
  const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "") {
    if (last === "") return null;
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  if (last === "") return [start, size - 1];
  const end = Number(last);
  if (end < start) return null;
  return [start, Math.min(end, size - 1)];
}
