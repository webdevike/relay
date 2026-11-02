// Images in Reviews markdown, served from the host (port of evaos-electron's
// main/reviews/review-media.ts and slack-media.ts). GitHub's uploads (`github.com/user-attachments`,
// `private-user-images`) open only with gh's login, Linear's with the key, and GitHub writes most of
// them as HTML `<img>` tags: each is downloaded once into `ReviewMedia.dir` and the markdown points at
// the host path `/reviews/media/<file>/<token>`, which the phone prefixes with the host URL. Slack's
// files come through the Slack desktop app on this Mac (its debugging port, 127.0.0.1:9333): one
// read-only script in its app.slack.com page asks `files.info` and fetches the file with the page's
// session. Nothing is typed, clicked, navigated or written there.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Fetch, ReviewMedia } from "./linear";

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** `![alt](url)`, `![alt](<url>)` and `<img ... src="url" ...>`. */
const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*>/gi;

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m?.[2] ?? m?.[3];
}

const cleanAlt = (alt: string): string => alt.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();

export interface MediaSource {
  /** Whether an image at this URL is downloaded (else it stays as it is). */
  match: (url: string) => boolean;
  /** Request headers for one download (auth). */
  headers: () => Promise<Record<string, string>>;
}

export const isGithubUpload = (url: string): boolean =>
  /^https:\/\/(?:github\.com\/user-attachments\/assets\/|private-user-images\.githubusercontent\.com\/)/.test(url);
export const isLinearUpload = (url: string): boolean => url.startsWith("https://uploads.linear.app/");

/** A file of `media` named `<sha1 of key><ext>`, when it is there. */
function kept(media: ReviewMedia, key: string): string | undefined {
  const sha = createHash("sha1").update(key).digest("hex");
  return existsSync(media.dir) ? readdirSync(media.dir).find((f) => f.startsWith(`${sha}.`) && !f.endsWith(".part")) : undefined;
}

/** Writes `bytes` as `<sha1 of key><ext>` (0600); answers the file name. */
function keep(media: ReviewMedia, key: string, ext: string, bytes: Buffer): string {
  const name = `${createHash("sha1").update(key).digest("hex")}${ext}`;
  mkdirSync(media.dir, { recursive: true, mode: 0o700 });
  const part = join(media.dir, `.${name}.${String(process.pid)}.part`);
  writeFileSync(part, bytes, { mode: 0o600 });
  renameSync(part, join(media.dir, name));
  return name;
}

const inflight = new Map<string, Promise<string>>();

/** `url` as a host media path, downloaded once with `source`'s headers; the URL itself on failure. */
function download(url: string, media: ReviewMedia, source: MediaSource, fetchFn: Fetch): Promise<string> {
  const have = kept(media, url);
  if (have !== undefined) return Promise.resolve(media.path(have));
  const running = inflight.get(url);
  if (running !== undefined) return running;
  const job = (async (): Promise<string> => {
    try {
      const res = await fetchFn(url, { headers: await source.headers(), signal: AbortSignal.timeout(20_000) });
      const ext = EXT[(res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""];
      if (!res.ok || ext === undefined) return url;
      return media.path(keep(media, url, ext, Buffer.from(await res.arrayBuffer())));
    } catch {
      return url;
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, job);
  return job;
}

/**
 * Every image in `md` as markdown: `<img>` tags become `![alt](src)`, and images a source matches
 * point at the host's copy. An image that fails to download keeps its URL.
 */
export async function localizeImages(md: string, media: ReviewMedia, sources: readonly MediaSource[], fetchFn: Fetch): Promise<string> {
  const urls = new Set<string>();
  for (const m of md.matchAll(IMAGE)) {
    const url = m[0].startsWith("<") ? attr(m[0], "src") : m[2];
    if (url !== undefined) urls.add(url);
  }
  const local = new Map(
    await Promise.all(
      [...urls].map(async (url) => {
        const source = sources.find((s) => s.match(url));
        return [url, source === undefined ? url : await download(url, media, source, fetchFn)] as const;
      }),
    ),
  );
  return md.replace(IMAGE, (whole: string, alt: string | undefined, mdUrl: string | undefined) => {
    const html = whole.startsWith("<");
    const url = html ? attr(whole, "src") : mdUrl;
    if (url === undefined) return whole;
    return `![${cleanAlt(html ? (attr(whole, "alt") ?? "") : (alt ?? ""))}](${local.get(url) ?? url})`;
  });
}

export const SLACK_CDP = "http://127.0.0.1:9333";
const MAX_FULL_BYTES = 12 * 1024 * 1024;

/** The script run in Slack's page: `files.info` with Slack's own session, then the image as base64. */
export function slackFetchScript(fileId: string, maxBytes = MAX_FULL_BYTES): string {
  return `(async () => {
  try {
    const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
    const team = Object.values(cfg.teams || {})[0];
    if (!team) return { error: 'Slack is not signed in' };
    const body = new FormData();
    body.append('token', team.token);
    body.append('file', ${JSON.stringify(fileId)});
    const info = await (await fetch('/api/files.info', { method: 'POST', body, credentials: 'include' })).json();
    if (!info.ok) return { error: 'files.info: ' + info.error };
    const f = info.file;
    if (!/^image\\//.test(f.mimetype || '')) return { error: 'not an image' };
    const url = (f.size || 0) <= ${String(maxBytes)} ? (f.url_private || f.thumb_1024) : (f.thumb_1024 || f.thumb_720 || f.url_private);
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { error: 'download ' + res.status };
    const type = (res.headers.get('content-type') || f.mimetype || '').split(';')[0];
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { type, data: btoa(bin) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})()`;
}

const Targets = z.array(z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() }));
const Answer = z.union([z.object({ type: z.string(), data: z.string() }), z.object({ error: z.string() }).passthrough()]);

/** Evaluates `expression` in Slack's client page; null when Slack is not listening on `cdp`. */
async function evaluate(expression: string, cdp: string): Promise<unknown> {
  let targets: z.infer<typeof Targets>;
  try {
    targets = Targets.parse(await (await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(2_000) })).json());
  } catch {
    return null;
  }
  const page = targets.find((t) => t.type === "page" && t.url.includes("app.slack.com/client"));
  if (page?.webSocketDebuggerUrl === undefined) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const timer = setTimeout(() => {
    reject(new Error("Slack did not answer"));
  }, 60_000);
  ws.onerror = () => {
    reject(new Error("Could not reach Slack"));
  };
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: { result?: { value?: unknown } } };
    if (m.id === 1) resolve(m.result?.result?.value ?? { error: "no answer" });
  };
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

const slackInflight = new Map<string, Promise<string | null>>();

/** Slack file `fileId` as a host media path, fetched once through Slack's page; null when it can't be. */
export function slackImage(fileId: string, media: ReviewMedia, cdp = SLACK_CDP): Promise<string | null> {
  const key = `slack:${fileId}`;
  const have = kept(media, key);
  if (have !== undefined) return Promise.resolve(media.path(have));
  const running = slackInflight.get(key);
  if (running !== undefined) return running;
  const job = (async (): Promise<string | null> => {
    try {
      const a = Answer.safeParse(await evaluate(slackFetchScript(fileId), cdp));
      if (!a.success || "error" in a.data) return null;
      const ext = EXT[a.data.type.toLowerCase()];
      if (ext === undefined) return null;
      return media.path(keep(media, key, ext, Buffer.from(a.data.data, "base64")));
    } catch {
      return null;
    }
  })().finally(() => slackInflight.delete(key));
  slackInflight.set(key, job);
  return job;
}
