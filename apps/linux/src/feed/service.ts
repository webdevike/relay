// Isaac's discovery feed for the phone: `<hub>/work/discovery-feed/feed.json` (ranked by `fetch.ts`)
// read on every `feed.list`, and each `feed.signal` appended to the same dir's `signals.jsonl`, the
// files Relay Desktop's Feed page reads and writes. Thumbnails the container cached from hosts that
// are blocked on Isaac's devices are `local:media/<file>` in the feed and are served at
// `GET /feed/media/<file>` (`handleFeedMedia`); the phone prefixes the host's own address.

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { FeedAction, FeedItem, type FeedSnapshot } from "@relay/protocol";
import { z } from "zod";
import { serveBlob } from "../drops/serve";
import type { DropBlob } from "../seams";

export const EMPTY_FEED: FeedSnapshot = { generatedAt: null, items: [], acted: {} };
/** Thumbnails the fetcher cached are capped at 700 KB; anything bigger is not ours. */
const MAX_MEDIA_BYTES = 1_000_000;
const MAX_ITEMS = 300;
const MEDIA_FILE = /^[0-9a-f]{6,64}\.(jpg|jpeg|png|webp|gif)$/;
const MEDIA_TYPES: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

export const FEED_MEDIA_PREFIX = "/feed/media/";

const FeedFile = z.object({ generatedAt: z.string().optional(), items: z.array(z.unknown()) });
const SignalLine = z.object({ id: z.string(), action: FeedAction });

/** What a phone session needs from the feed. */
export interface FeedDeck {
  snapshot(): FeedSnapshot;
  signal(id: string, action: FeedAction, title: string, source: string): void;
  /** The cached thumbnail `<file>` (a bare file name), or null. */
  openMedia(file: string): DropBlob | null;
}

/** `$RELAY_FEED_DIR`, else `<agentHome>/work/discovery-feed`. */
export function defaultFeedDir(agentHome: string | null): string | null {
  const override = process.env["RELAY_FEED_DIR"];
  if (override !== undefined && override !== "") return override;
  return agentHome === null ? null : join(agentHome, "work", "discovery-feed");
}

/** The phone-facing image of a feed card: its https URL, a host path for a cached thumbnail, else none. */
export function imageOf(image: string | undefined): string | undefined {
  if (image === undefined) return undefined;
  if (image.startsWith("https://")) return image;
  if (!image.startsWith("local:media/")) return undefined;
  const file = basename(image);
  return MEDIA_FILE.test(file) ? `${FEED_MEDIA_PREFIX}${file}` : undefined;
}

export class FeedService implements FeedDeck {
  constructor(private readonly dir: string) {}

  snapshot(): FeedSnapshot {
    let feed: z.infer<typeof FeedFile>;
    try {
      feed = FeedFile.parse(JSON.parse(readFileSync(join(this.dir, "feed.json"), "utf8")));
    } catch {
      return EMPTY_FEED;
    }
    const acted: Record<string, FeedAction> = {};
    let signals = "";
    try {
      signals = readFileSync(join(this.dir, "signals.jsonl"), "utf8");
    } catch {
      // No signals yet.
    }
    for (const line of signals.split("\n")) {
      try {
        const signal = SignalLine.safeParse(JSON.parse(line));
        if (signal.success) acted[signal.data.id] = signal.data.action;
      } catch {
        // A blank or torn line is skipped.
      }
    }
    const items: FeedItem[] = [];
    for (const entry of feed.items) {
      if (items.length >= MAX_ITEMS) break;
      const parsed = FeedItem.safeParse(entry);
      // A skipped card is gone for good, as on the desktop.
      if (!parsed.success || acted[parsed.data.id] === "skip") continue;
      const { image, ...card } = parsed.data;
      const phoneImage = imageOf(image);
      items.push(phoneImage === undefined ? card : { ...card, image: phoneImage });
    }
    return { generatedAt: feed.generatedAt ?? null, items, acted };
  }

  signal(id: string, action: FeedAction, title: string, source: string): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "signals.jsonl"), `${JSON.stringify({ id, action, title, source, ts: Date.now() })}\n`);
  }

  openMedia(file: string): DropBlob | null {
    if (!MEDIA_FILE.test(file)) return null;
    const path = join(this.dir, "media", file);
    try {
      const { size } = statSync(path);
      return size > MAX_MEDIA_BYTES ? null : { path, size, name: file, mimeType: MEDIA_TYPES[extname(file)] ?? "image/jpeg" };
    } catch {
      return null;
    }
  }
}

/** `GET`/`HEAD /feed/media/<file>`. Thumbnails are public images; the path only ever travels to paired phones. */
export function handleFeedMedia(feed: FeedDeck | null, request: Request, path: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const blob = feed?.openMedia(path.slice(FEED_MEDIA_PREFIX.length)) ?? null;
  if (blob === null) return new Response("not found", { status: 404 });
  const response = serveBlob(request, blob);
  response.headers.set("cache-control", "private, max-age=86400");
  return response;
}
