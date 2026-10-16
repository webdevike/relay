// Reads an omp session transcript (JSONL) into the inbox rows the phone and EvaOS show. Shared by
// the relay-bridge omp extension (live messages and the seed of a resumed thread) and by the host's
// assistant service (the earlier transcripts of Eva's thread). The extension runs under omp's bun
// with no node_modules and imports this by relative path, so this file may only use node built-ins
// and must stay free of the repo's packages (no zod, no @relay/protocol).

import { createHash } from "node:crypto";

export type Role = "user" | "assistant" | "tool" | "system";
export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

/** Image bytes as they cross the socket in both directions. */
export interface Image {
  mimeType: ImageMimeType;
  data: string;
}

export interface ImageRef {
  id: string;
  mimeType: ImageMimeType;
  width?: number;
  height?: number;
}

export interface InboxMessage {
  id: string;
  role: Role;
  text: string;
  at: number;
  tool?: { name: string; summary: string };
  images?: ImageRef[];
  streaming?: boolean;
}

export const MAX_SUMMARY = 120;
/** Transcript images kept per session for the phone to fetch; older ones answer null. */
export const MAX_IMAGES = 32;
export const IMAGE_ID_LENGTH = 16;

export function firstLine(text: string): string {
  const line = text.trim().split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

export function summarizeArguments(args: Record<string, unknown>): string {
  const intent = args["i"];
  if (typeof intent === "string" && intent.length > 0) return firstLine(intent);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") parts.push(`${key}=${firstLine(value)}`);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${String(value)}`);
    if (parts.join(" ").length > MAX_SUMMARY) break;
  }
  return firstLine(parts.join(" "));
}

/** Text of a user/assistant message: string content or the joined text parts. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

/** PNG by signature, JPEG by SOI, WebP by RIFF header (omp re-encodes attachments to WebP); anything else is skipped. */
function sniffMimeType(bytes: Buffer): ImageMimeType | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** WebP size from the first chunk: VP8X canvas, VP8L 14-bit fields, or the VP8 key frame header. */
function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/** Pixel size from the PNG IHDR, the WebP header, or the first JPEG SOF marker; null when the header is not there. */
function imageSize(bytes: Buffer, mimeType: ImageMimeType): { width: number; height: number } | null {
  if (mimeType === "image/png") {
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mimeType === "image/webp") return webpSize(bytes);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // fill byte before a marker
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any frame header
    const length = bytes.readUInt16BE(offset + 2);
    // Frame headers (SOFn) carry the dimensions; DHT (C4), JPG (C8) and DAC (CC) share the range but do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** An image content part of an omp message: base64 `data`. */
interface ImagePart {
  type: "image";
  data: string;
}

/** Stores one transcript image in `images` under its content hash (newest MAX_IMAGES kept) and returns the ref for the phone. */
function internImage(images: Map<string, Image>, part: ImagePart): ImageRef | null {
  const bytes = Buffer.from(part.data, "base64");
  const mimeType = sniffMimeType(bytes);
  if (mimeType === null) return null;
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, IMAGE_ID_LENGTH);
  images.delete(id); // re-insert so a repeated image counts as newest
  images.set(id, { mimeType, data: part.data });
  while (images.size > MAX_IMAGES) {
    const oldest = images.keys().next();
    if (oldest.done === true) break;
    images.delete(oldest.value);
  }
  const ref: ImageRef = { id, mimeType };
  const size = imageSize(bytes, mimeType);
  if (size !== null) {
    ref.width = size.width;
    ref.height = size.height;
  }
  return ref;
}

/**
 * Image refs for every image part of a message's content; string content has none. A null `images`
 * skips them all (the host reads old transcripts for their text only: it holds no bytes to serve).
 */
export function imageRefsOf(images: Map<string, Image> | null, content: unknown): ImageRef[] {
  if (images === null || !Array.isArray(content)) return [];
  const refs: ImageRef[] = [];
  for (const part of content as { type?: unknown; data?: unknown }[]) {
    if (part.type !== "image" || typeof part.data !== "string") continue;
    const ref = internImage(images, { type: "image", data: part.data });
    if (ref !== null) refs.push(ref);
  }
  return refs;
}

/** The transcript rows one finished omp message contributes: the same shapes the live session streams. */
export function rowsOf(message: Record<string, unknown>, images: Map<string, Image> | null, nextId: () => string): InboxMessage[] {
  const at = typeof message["timestamp"] === "number" ? message["timestamp"] : Date.now();
  const content = message["content"];
  const rows: InboxMessage[] = [];
  switch (message["role"]) {
    case "user": {
      const text = textOf(content);
      const refs = imageRefsOf(images, content);
      if (text.length === 0 && refs.length === 0) break;
      const row: InboxMessage = { id: nextId(), role: message["synthetic"] === true ? "system" : "user", text, at };
      if (refs.length > 0) row.images = refs;
      rows.push(row);
      break;
    }
    case "toolResult": {
      const refs = imageRefsOf(images, content);
      const name = typeof message["toolName"] === "string" ? message["toolName"] : "tool";
      if (refs.length > 0) rows.push({ id: nextId(), role: "tool", text: "", at, tool: { name, summary: "" }, images: refs });
      break;
    }
    case "assistant": {
      const text = textOf(content);
      if (text.length > 0) rows.push({ id: nextId(), role: "assistant", text, at });
      if (!Array.isArray(content)) break;
      for (const part of content as { type?: unknown; name?: unknown; arguments?: unknown }[]) {
        if (part.type !== "toolCall" || typeof part.name !== "string") continue;
        const summary = typeof part.arguments === "object" && part.arguments !== null ? summarizeArguments(part.arguments as Record<string, unknown>) : "";
        rows.push({ id: nextId(), role: "tool", text: summary, at, tool: { name: part.name, summary } });
      }
      break;
    }
  }
  return rows;
}

/**
 * Every row of a session file's text, in order. The file holds one JSON entry per line; only
 * `message` entries are rows and a line that does not parse is skipped (a half-written tail).
 */
export function parseSessionRows(raw: string, images: Map<string, Image> | null, nextId: () => string): InboxMessage[] {
  const rows: InboxMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: { type?: unknown; message?: unknown };
    try {
      entry = JSON.parse(line) as { type?: unknown; message?: unknown };
    } catch {
      continue;
    }
    if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
    rows.push(...rowsOf(entry.message as Record<string, unknown>, images, nextId));
  }
  return rows;
}
